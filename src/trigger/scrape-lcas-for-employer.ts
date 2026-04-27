import { logger, task } from "@trigger.dev/sdk";
import {
  RateLimitError,
  CookieExpiredError,
  isLoggedOut,
  sleep,
  jitterDelay,
} from "../lib/fetcher.js";
import {
  openMyvisajobsSession,
  closeMyvisajobsSession,
  fetchPageInBrowser,
} from "../lib/browser-fetcher.js";
import { extractLcaIdsFromListing, parseLcaDetailHtml } from "../lib/lca-parser.js";
import { LCAContact, LCAContactSchema } from "../lib/schema.js";
import { CONFIG } from "../lib/config.js";
import {
  appendLcaContacts,
  appendJobs,
  markEmployerLcasScraped,
  getScrapedLcaKeys,
  getScrapedJobIds,
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
  skippedStale?: number;
  jobsWritten?: number;
  errors: number;
};

const BASE = "https://www.myvisajobs.com";

export const scrapeLcasForEmployer = task({
  id: "myvisajobs.scrape-lcas-for-employer",
  queue: { concurrencyLimit: 5 },
  maxDuration: 1500,
  machine: "medium-1x",
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
    const freshnessCutoffMs =
      Date.now() - CONFIG.LCA_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

    // Headless Chromium — myvisajobs's /h1b-visa/lcafull.aspx requires the
    // full browser fingerprint (TLS, HTTP/2, native cookie rolling). Native
    // fetch + static env-var cookie returns degraded empty content even
    // with Chrome 147 header parity and a session jar.
    const browserSession = await openMyvisajobsSession();

    const allRows: LCAContact[] = [];
    let lcasFound = 0;
    let skipped = 0;
    let skippedStale = 0;
    let errors = 0;
    let emptyParses = 0;
    let attempted = 0;

    try {
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
        listingHtml = await fetchPageInBrowser(browserSession, listingUrl);
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
          detailHtml = await fetchPageInBrowser(browserSession, ref.url);
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

        attempted++;
        const parsed = parseLcaDetailHtml(detailHtml, {
          lcaId: ref.id,
          year: ref.year,
          lcaUrl: ref.url,
          employerSlug: slug,
        });
        if (!parsed.employerName) parsed.employerName = employerName;

        // Reject empty parses — cookie-degraded responses have LCA-shaped HTML
        // but our summary-table + section-block extractors return nothing.
        // Without this gate, every degraded fetch silently writes a row with
        // only metadata (LCA_ID, slug, year, URL) and all parser fields null.
        const hasMeaningfulContent =
          !!(parsed.caseStatus ||
            parsed.caseNumber ||
            parsed.jobTitle ||
            parsed.contactEmail ||
            parsed.contactLastName ||
            parsed.workCity);
        if (!hasMeaningfulContent) {
          emptyParses++;
          errors++;
          logger.warn("LCA parse returned empty — cookie may be degraded", {
            id: ref.id,
            year: ref.year,
          });
          continue;
        }

        const validated = LCAContactSchema.safeParse(parsed);
        if (!validated.success) {
          errors++;
          logger.warn("LCA parse invalid", { id: ref.id, issues: validated.error.issues });
          continue;
        }

        // Freshness filter — skip LCAs older than LCA_MAX_AGE_DAYS. Only
        // applies when we have a reliable filingDate; missing date = keep.
        const fd = validated.data.filingDate;
        if (fd) {
          const fdMs = Date.parse(fd + "T00:00:00Z");
          if (Number.isFinite(fdMs) && fdMs < freshnessCutoffMs) {
            skippedStale++;
            scrapedKeys.add(ref.id); // still mark seen so we don't refetch
            continue;
          }
        }

        allRows.push(validated.data);
        scrapedKeys.add(ref.id);
      }
    }
    } finally {
      // Always release Chromium even on partial failure
      await closeMyvisajobsSession(browserSession);
    }

    // If the cookie was degraded mid-batch, every fetch returned an empty
    // LCA shell. Surface this loudly — silently passing back zero rows used
    // to look the same as "no LCAs for this employer", which masked ~1300
    // junk rows getting written before this gate existed.
    if (attempted > 0 && emptyParses / attempted >= 0.5) {
      await sendTelegramAlert(
        "critical",
        "MyVisaJobs cookie likely degraded (LCA)",
        `Slug ${slug}: ${emptyParses}/${attempted} LCAs returned empty page content. Refresh MYVISAJOBS_COOKIE — make sure it's the premium-tier candidate-side cookie.`,
      );
    }

    // 3a. Jobs tab: append ONE row per LCA (no email dedup). Dedup by LCA ID
    //     against existing Jobs rows so reruns don't double-write.
    const existingJobIds = await getScrapedJobIds();
    const newJobs = allRows.filter((r) => !existingJobIds.has(r.lcaId));
    const jobsWritten = newJobs.length ? await appendJobs(newJobs) : 0;

    // 3b. LCA_Contacts tab: dedup by contact email within this employer —
    //     the same hiring manager often appears on many LCAs.
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

    // 4. Bulk write contacts + mark employer as scraped
    const written = await appendLcaContacts(toWrite);
    await markEmployerLcasScraped(employerRowNumber);

    logger.info("LCA scrape complete", {
      slug,
      lcasFound,
      jobsWritten,
      contactsWritten: written,
      skippedStale,
      skippedDuplicates: skipped,
      errors,
    });

    return {
      slug,
      lcasFound,
      lcasWritten: written,
      skippedDuplicates: skipped,
      skippedStale,
      jobsWritten,
      errors,
    };
  },
});
