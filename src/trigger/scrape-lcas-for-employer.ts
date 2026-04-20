import { logger, task } from "@trigger.dev/sdk";
import {
  fetchEmployerPage,
  RateLimitError,
  CookieExpiredError,
  isLoggedOut,
  sleep,
  jitterDelay,
} from "../lib/fetcher.js";
import { extractLcaIdsFromListing, parseLcaDetailHtml } from "../lib/lca-parser.js";
import { LCAContact, LCAContactSchema } from "../lib/schema.js";
import { CONFIG } from "../lib/config.js";
import {
  appendLcaContacts,
  markEmployerLcasScraped,
  getScrapedLcaKeys,
} from "../lib/sheets.js";
import { sendTelegramAlert } from "../lib/telegram.js";

export type ScrapeLcasPayload = {
  slug: string;
  employerName: string;
  employerRowNumber: number;
};

export type ScrapeLcasResult = {
  slug: string;
  lcasFound: number;
  lcasWritten: number;
  skippedDuplicates: number;
  errors: number;
};

const BASE = "https://www.myvisajobs.com";

export const scrapeLcasForEmployer = task({
  id: "myvisajobs.scrape-lcas-for-employer",
  queue: { concurrencyLimit: 3 },
  maxDuration: 600,
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 15000,
    factor: 2,
  },
  run: async (payload: ScrapeLcasPayload): Promise<ScrapeLcasResult> => {
    const { slug, employerName, employerRowNumber } = payload;
    logger.info("Scraping LCAs for employer", { slug, employerName });

    const scrapedKeys = await getScrapedLcaKeys();

    const allRows: LCAContact[] = [];
    let lcasFound = 0;
    let skipped = 0;
    let errors = 0;

    for (const year of CONFIG.LCA_YEARS) {
      // Skip year if we've already done it for this employer
      if (scrapedKeys.has(`${slug}::${year}`)) {
        logger.info("Year already scraped, skipping", { slug, year });
        continue;
      }

      // 1. Fetch listing page(s) — 10 results per page, up to 2 pages for 20 max
      const listingUrl = `${BASE}/h1b/search.aspx?e=${encodeURIComponent(slug)}&st=certified&y=${year}`;
      let listingHtml: string;
      try {
        listingHtml = await fetchEmployerPage(listingUrl);
      } catch (err) {
        errors++;
        if (err instanceof RateLimitError) {
          await sendTelegramAlert(
            "warning",
            "LCA rate limit",
            `${slug} year ${year}: HTTP ${err.status}`,
          );
          throw err;
        }
        if (err instanceof CookieExpiredError) throw err;
        logger.warn("Listing fetch failed", { slug, year, err: String(err) });
        continue;
      }

      if (isLoggedOut(listingHtml)) {
        await sendTelegramAlert(
          "critical",
          "MyVisaJobs cookie expired (LCA)",
          `Listing page for ${slug} ${year} shows logged-out content. Refresh MYVISAJOBS_COOKIE env var.`,
        );
        throw new CookieExpiredError();
      }

      const lcaRefs = extractLcaIdsFromListing(listingHtml)
        .filter((r) => !scrapedKeys.has(r.id))
        .slice(0, CONFIG.LCA_MAX_PER_EMPLOYER_YEAR);

      logger.info("Found LCAs in listing", { slug, year, count: lcaRefs.length });
      lcasFound += lcaRefs.length;

      // 2. Fetch each LCA detail page and parse Section D
      for (const ref of lcaRefs) {
        await sleep(jitterDelay());

        let detailHtml: string;
        try {
          detailHtml = await fetchEmployerPage(ref.url);
        } catch (err) {
          errors++;
          if (err instanceof RateLimitError) throw err;
          if (err instanceof CookieExpiredError) throw err;
          logger.warn("LCA detail fetch failed", { id: ref.id, err: String(err) });
          continue;
        }

        if (isLoggedOut(detailHtml)) {
          await sendTelegramAlert(
            "critical",
            "MyVisaJobs cookie expired (LCA detail)",
            `LCA ${ref.id} shows logged-out content. Refresh cookie.`,
          );
          throw new CookieExpiredError();
        }

        const parsed = parseLcaDetailHtml(detailHtml, {
          lcaId: ref.id,
          year: ref.year,
          lcaUrl: ref.url,
          employerSlug: slug,
        });
        if (!parsed.employerName) parsed.employerName = employerName;

        const validated = LCAContactSchema.safeParse(parsed);
        if (!validated.success) {
          errors++;
          logger.warn("LCA parse invalid", { id: ref.id, issues: validated.error.issues });
          continue;
        }
        allRows.push(validated.data);
        scrapedKeys.add(ref.id);
      }
    }

    // 3. Deduplicate by contact email within this employer — the same hiring
    //    manager can appear on many LCAs; keep the first occurrence.
    const byEmail = new Map<string, LCAContact>();
    const noEmail: LCAContact[] = [];
    for (const r of allRows) {
      const key = r.contactEmail?.toLowerCase();
      if (key) {
        if (!byEmail.has(key)) byEmail.set(key, r);
        else skipped++;
      } else {
        noEmail.push(r);
      }
    }
    const toWrite = [...byEmail.values(), ...noEmail];

    // 4. Bulk write + mark employer as scraped
    const written = await appendLcaContacts(toWrite);
    await markEmployerLcasScraped(employerRowNumber);

    logger.info("LCA scrape complete", {
      slug,
      lcasFound,
      written,
      skipped,
      errors,
    });

    return {
      slug,
      lcasFound,
      lcasWritten: written,
      skippedDuplicates: skipped,
      errors,
    };
  },
});
