import { logger, task } from "@trigger.dev/sdk";
import { fetchEmployerPage, RateLimitError } from "../lib/fetcher.js";
import { parseEmployerHtml } from "../lib/parser.js";
import { EmployerDataSchema, isParseHealthy, EnrichedEmployer } from "../lib/schema.js";
import { extractWithAI, enrichWithAI } from "../lib/anthropic.js";
import { appendEmployer, appendFailed } from "../lib/sheets.js";
import { sendTelegramAlert } from "../lib/telegram.js";

export type ScrapeResult = {
  url: string;
  success: boolean;
  tier: "cheerio" | "haiku" | "sonnet" | "openai" | "failed";
  rowNumber?: number;
  companyName?: string;
  error?: string;
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
  run: async (payload: { url: string; addedBy?: string }): Promise<ScrapeResult> => {
    const { url } = payload;
    const addedBy = payload.addedBy ?? "trigger.dev";
    logger.info("Scraping employer", { url });

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

    // Write
    const rowNumber = await appendEmployer(data, addedBy);
    logger.info("Wrote employer", { url, rowNumber, tier, company: data.companyName });

    return {
      url,
      success: true,
      tier,
      rowNumber,
      companyName: data.companyName,
    };
  },
});
