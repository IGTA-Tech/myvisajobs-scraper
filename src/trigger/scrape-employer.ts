import { logger, task } from "@trigger.dev/sdk";
import {
  fetchEmployerPage,
  RateLimitError,
  CookieExpiredError,
  isLoggedOut,
} from "../lib/fetcher.js";
import { parseEmployerHtml } from "../lib/parser.js";
import { EmployerDataSchema, isParseHealthy, EnrichedEmployer } from "../lib/schema.js";
import { extractWithAI, enrichWithAI } from "../lib/anthropic.js";
import { appendEmployer, appendFailed, updateDashboard } from "../lib/sheets.js";
import { sendTelegramAlert } from "../lib/telegram.js";

export type ScrapeResult = {
  url: string;
  success: boolean;
  tier: "cheerio" | "haiku" | "sonnet" | "openai" | "failed";
  rowNumber?: number;
  companyName?: string;
  error?: string;
};

export type ScrapePayload = {
  url: string;
  addedBy?: string;
  discoverySource?: string | null;
  discoveryNotesPrefix?: string | null;
};

export const scrapeEmployer = task({
  id: "myvisajobs.scrape-employer",
  queue: { concurrencyLimit: 5 },
  maxDuration: 180,
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 15000,
    factor: 2,
  },
  run: async (payload: ScrapePayload): Promise<ScrapeResult> => {
    const { url } = payload;
    const addedBy = payload.addedBy ?? "Sherrod";
    const discoverySource = payload.discoverySource ?? "manual";
    const discoveryNotesPrefix = payload.discoveryNotesPrefix ?? null;
    logger.info("Scraping employer", { url, discoverySource });

    let html: string;
    try {
      html = await fetchEmployerPage(url);
    } catch (err) {
      if (err instanceof RateLimitError) {
        await sendTelegramAlert(
          "warning",
          "MyVisaJobs rate limit",
          `Got HTTP ${err.status} on ${url}. Task will retry with backoff.`,
        );
      }
      throw err;
    }

    // Cookie expiry detection — if the response still shows the "Premium Member Only"
    // placeholder in contact details, the session cookie is dead (or not set).
    if (isLoggedOut(html)) {
      await sendTelegramAlert(
        "critical",
        "MyVisaJobs cookie expired",
        `Response shows logged-out content — emails/phones are gated behind premium.\n\nFix: log in to myvisajobs.com, copy a fresh session cookie, update MYVISAJOBS_COOKIE in Trigger.dev env vars, redeploy.`,
      );
      throw new CookieExpiredError();
    }

    // Tier 1: cheerio
    const parsed = parseEmployerHtml(html, url);
    let tier: ScrapeResult["tier"] = "cheerio";
    let data: EnrichedEmployer | null = null;

    if (isParseHealthy(parsed)) {
      const validated = EmployerDataSchema.safeParse(parsed);
      if (validated.success) {
        data = validated.data;
      }
    }

    // Tier 3/4: AI extraction fallback
    if (!data) {
      logger.warn("Cheerio parse unhealthy — falling back to AI", { url });
      try {
        const ai = await extractWithAI(html, url);
        data = ai.data;
        tier = ai.tier;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("AI extraction failed", { url, err: msg });
        await appendFailed(url, `All tiers failed: ${msg}`, html);
        await sendTelegramAlert(
          "error",
          "Scrape failed (all tiers)",
          `URL: ${url}\nError: ${msg}`,
        );
        return { url, success: false, tier: "failed", error: msg };
      }
    }

    // Enrichment (Haiku -> Sonnet -> empty)
    try {
      const enrichment = await enrichWithAI(data);
      data = { ...data, ...enrichment };
    } catch (err) {
      logger.warn("Enrichment failed, writing without it", { url, err });
    }

    // Build final discovery notes (rich, post-enrichment)
    data.discoverySource = discoverySource;
    data.discoveryNotes = buildDiscoveryNotes(data, discoveryNotesPrefix);

    // Write
    const rowNumber = await appendEmployer(data, addedBy);
    logger.info("Wrote employer", { url, rowNumber, tier, company: data.companyName });

    // Per-row dashboard log — one entry per scraped employer so individual runs
    // (including direct test-runs) show up in the Dashboard tab.
    await updateDashboard({
      scrapedToday: 1,
      scrapedTotal: 1,
      lastRun: new Date().toISOString(),
      lastRunStatus: `ok (${tier}) ${data.companyName}`,
    });

    return {
      url,
      success: true,
      tier,
      rowNumber,
      companyName: data.companyName,
    };
  },
});

/**
 * Composes a rich Discovery_Notes string combining the discovery metadata
 * (timestamp, source, position) with useful company/job insight from the
 * AI enrichment step. Falls back gracefully if fields are missing.
 */
function buildDiscoveryNotes(
  data: EnrichedEmployer,
  prefix: string | null,
): string {
  const parts: string[] = [];

  // Metadata line
  if (prefix) parts.push(prefix);
  else
    parts.push(
      `${formatLagosTime(new Date())} · manual entry`,
    );

  // Company profile line
  const profile: string[] = [];
  if (data.companyName) profile.push(data.companyName);
  const loc = [data.mainOfficeCity, data.mainOfficeState].filter(Boolean).join(", ");
  if (loc) profile.push(`(${loc}${data.numberOfEmployees ? `, ${data.numberOfEmployees} employees` : ""})`);
  if (data.naicsIndustry) profile.push(`— ${data.naicsIndustry}`);
  if (data.visaRank) profile.push(`· visa rank #${data.visaRank}`);
  if (profile.length) parts.push(profile.join(" "));

  // Volume / salary line
  const vol: string[] = [];
  if (data.h1bLCACurrent != null) vol.push(`${data.h1bLCACurrent} H-1B LCAs current FY`);
  if (data.gcLCCurrent != null && data.gcLCCurrent > 0) vol.push(`${data.gcLCCurrent} GC LCs`);
  if (data.avgH1BSalaryCurrent) vol.push(`avg $${data.avgH1BSalaryCurrent.toLocaleString()}`);
  if (vol.length) parts.push(vol.join(", "));

  // Top roles line
  const roles = [
    data.topSponsoredRole1 ? `${data.topSponsoredRole1}${data.topSponsoredRole1Count ? ` (${data.topSponsoredRole1Count})` : ""}` : null,
    data.topSponsoredRole2 ? `${data.topSponsoredRole2}${data.topSponsoredRole2Count ? ` (${data.topSponsoredRole2Count})` : ""}` : null,
    data.topSponsoredRole3 ? `${data.topSponsoredRole3}${data.topSponsoredRole3Count ? ` (${data.topSponsoredRole3Count})` : ""}` : null,
  ].filter(Boolean);
  if (roles.length) parts.push(`Top sponsored roles: ${roles.join("; ")}`);

  // Worker countries
  if (data.topWorkerCountries) parts.push(`Worker origins: ${data.topWorkerCountries}`);

  // AI insight
  const aiBits: string[] = [];
  if (data.targetPriority) aiBits.push(`Priority ${data.targetPriority}`);
  if (data.sponsorshipLikelihood) aiBits.push(data.sponsorshipLikelihood);
  if (data.aiEmployerScore != null) aiBits.push(`AI score ${data.aiEmployerScore}/100`);
  if (aiBits.length) parts.push(`[${aiBits.join(" · ")}]`);
  if (data.aiEvaluationNotes) parts.push(data.aiEvaluationNotes);

  return parts.join("\n");
}

function formatLagosTime(d: Date): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Africa/Lagos",
    }).format(d) + " WAT";
  } catch {
    return d.toISOString();
  }
}
