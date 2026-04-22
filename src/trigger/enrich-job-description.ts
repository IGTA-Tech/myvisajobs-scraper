import { logger, task } from "@trigger.dev/sdk";
import { CONFIG } from "../lib/config.js";
import { serperSearch, rankResults, domainOf, classifySource } from "../lib/serper.js";
import { firecrawlScrape, FirecrawlError } from "../lib/firecrawl.js";
import { fetchAndExtract, FallbackScrapeError } from "../lib/scraper-fallback.js";
import {
  extractJobDescriptionStructured,
  jobExtractionQuality,
} from "../lib/anthropic.js";
import { appendJobDescription, getExistingJobDescriptionLcaIds } from "../lib/sheets.js";
import { JobDescriptionSchema } from "../lib/schema.js";
import { sendTelegramAlert } from "../lib/telegram.js";

export type EnrichJobPayload = {
  lcaId: string;
  lcaUrl: string;
  employerName: string;
  employerSlug: string | null;
  employerEmail: string | null;
  jobTitle: string;
  outreachRow: number;
  outreachRank: number | null;
  locationHint: string | null;
};

export type EnrichJobResult = {
  lcaId: string;
  written: boolean;
  reason?: string;
  scraperTier?: string;
  qualityScore?: number;
  sourceUrl?: string;
};

export const enrichJobDescription = task({
  id: "myvisajobs.enrich-job-description",
  queue: { concurrencyLimit: 3 },
  maxDuration: 300,
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 15000,
    factor: 2,
  },
  run: async (payload: EnrichJobPayload): Promise<EnrichJobResult> => {
    const { lcaId, employerName, jobTitle } = payload;
    logger.info("Enriching job description", { lcaId, employerName, jobTitle });

    // Dedup — if we already wrote this LCA, skip.
    const existing = await getExistingJobDescriptionLcaIds();
    if (existing.has(lcaId)) {
      return { lcaId, written: false, reason: "already-in-sheet" };
    }

    // 1. Serper
    let results;
    try {
      results = await serperSearch(
        `"${jobTitle}" "${employerName}" careers`,
        10,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Serper failed", { lcaId, err: msg });
      return { lcaId, written: false, reason: `serper-failed: ${msg}` };
    }

    if (results.length === 0) {
      return { lcaId, written: false, reason: "no-serper-results" };
    }

    // 2. Rank by source preference
    const ranked = rankResults(results, employerName).slice(
      0,
      1 + CONFIG.OUTREACH_MAX_FIRECRAWL_RETRIES,
    );

    // 3. Scrape top URL, retry once if quality gate fails
    let chosen: {
      markdown: string;
      sourceUrl: string;
      sourceDomain: string;
      sourceType: string;
      scraperTier: string;
    } | null = null;

    for (let attempt = 0; attempt < ranked.length; attempt++) {
      const r = ranked[attempt];
      const url = r.link;
      const domain = domainOf(url);
      const sourceType = classifySource(url, employerName);

      // Try Firecrawl first
      let markdown: string | null = null;
      let tier = "firecrawl";
      try {
        const fc = await firecrawlScrape(url);
        markdown = fc.markdown;
      } catch (err) {
        if (err instanceof FirecrawlError) {
          logger.warn("Firecrawl failed, trying fallback", {
            lcaId,
            url,
            status: err.status,
          });
        }
        // Fallback to native fetch + cheerio
        try {
          const fb = await fetchAndExtract(url);
          markdown = fb.markdown;
          tier = "cheerio";
        } catch (fbErr) {
          if (fbErr instanceof FallbackScrapeError) {
            logger.warn("Fallback also failed", { lcaId, url, err: fbErr.message });
          }
          continue; // try next ranked URL
        }
      }

      if (!markdown || markdown.length < CONFIG.OUTREACH_MIN_DESCRIPTION_CHARS) {
        logger.info("Thin content, trying next URL", {
          lcaId,
          url,
          len: markdown?.length ?? 0,
        });
        continue;
      }

      chosen = {
        markdown,
        sourceUrl: url,
        sourceDomain: domain,
        sourceType,
        scraperTier: tier,
      };
      break;
    }

    if (!chosen) {
      return { lcaId, written: false, reason: "all-scrapes-failed-or-thin" };
    }

    // 4. Claude Haiku structured extraction
    let structured;
    try {
      structured = await extractJobDescriptionStructured(chosen.markdown, {
        employerName,
        jobTitle,
        sourceUrl: chosen.sourceUrl,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Claude extraction failed", { lcaId, err: msg });
      return { lcaId, written: false, reason: `extraction-failed: ${msg}` };
    }

    const quality = jobExtractionQuality(structured, chosen.markdown.length);

    // 5. Build JobDescription row
    const rowId = `jd-${lcaId}`;
    const row = JobDescriptionSchema.parse({
      rowId,
      outreachRow: payload.outreachRow,
      outreachRank: payload.outreachRank,
      employerName,
      employerSlug: payload.employerSlug,
      employerEmail: payload.employerEmail,
      jobTitle,
      location: structured.location ?? payload.locationHint,
      remoteFlag: structured.remoteFlag,
      workType: structured.workType,
      salaryMin: structured.salaryMin,
      salaryMax: structured.salaryMax,
      salaryPeriod: structured.salaryPeriod,
      experienceLevel: structured.experienceLevel,
      descriptionFull: chosen.markdown,
      descriptionSummary: structured.descriptionSummary,
      responsibilities: structured.responsibilities,
      qualifications: structured.qualifications,
      requiredSkills: structured.requiredSkills,
      preferredSkills: structured.preferredSkills,
      education: structured.education,
      yearsExperience: structured.yearsExperience,
      benefits: structured.benefits,
      visaSponsorship: structured.visaSponsorship,
      sourceUrl: chosen.sourceUrl,
      sourceDomain: chosen.sourceDomain,
      sourceType: chosen.sourceType,
      postedDate: structured.postedDate,
      applicationUrl: structured.applicationUrl,
      qualityScore: quality,
      scraperTier: chosen.scraperTier,
      aiSummary: structured.aiSummary,
      scrapedAt: new Date().toISOString(),
      notes: null,
      lcaId,
    });

    await appendJobDescription(row);

    logger.info("Wrote job description", {
      lcaId,
      quality,
      tier: chosen.scraperTier,
      sourceType: chosen.sourceType,
      domain: chosen.sourceDomain,
    });

    // Low-quality warning (don't fail the task, just surface)
    if (quality < 0.3) {
      await sendTelegramAlert(
        "warning",
        "Low-quality job description",
        `${employerName} - ${jobTitle}\nQuality: ${quality}\nSource: ${chosen.sourceUrl}`,
      );
    }

    return {
      lcaId,
      written: true,
      scraperTier: chosen.scraperTier,
      qualityScore: quality,
      sourceUrl: chosen.sourceUrl,
    };
  },
});
