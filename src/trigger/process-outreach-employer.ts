import { logger, task, tasks } from "@trigger.dev/sdk";
import { CONFIG } from "../lib/config.js";
import { fetchEmployerPage, isLoggedOut } from "../lib/fetcher.js";
import {
  buildCompanySearchUrl,
  parseCompanyListing,
  MyVisaJobsListingItem,
} from "../lib/job-listings-parser.js";
import { getExistingJobDescriptionLcaIds } from "../lib/sheets.js";
import { enrichJobDescription } from "./enrich-job-description.js";

export type ProcessOutreachPayload = {
  rowNumber: number;
  rank: number | null;
  companyName: string;
  email: string | null;
};

export type ProcessOutreachResult = {
  company: string;
  jobsFound: number;
  jobsSkipped: number;
  jobsEnriched: number;
  jobsFailed: number;
  reason?: string;
};

export const processOutreachEmployer = task({
  id: "myvisajobs.process-outreach-employer",
  queue: { concurrencyLimit: 3 },
  maxDuration: 900,
  run: async (payload: ProcessOutreachPayload): Promise<ProcessOutreachResult> => {
    const { rowNumber, rank, companyName, email } = payload;
    logger.info("Processing outreach employer", { rowNumber, companyName });

    // 1. Fetch myvisajobs current fiscal year search (free — native fetch + cookie)
    const currentYear = new Date().getUTCFullYear() + 1; // US fiscal year runs Oct-Sep; bias to latest FY
    const urls = [
      buildCompanySearchUrl(companyName, currentYear),
      buildCompanySearchUrl(companyName, currentYear - 1),
    ];

    const allListings: MyVisaJobsListingItem[] = [];
    const seenIds = new Set<string>();

    for (const url of urls) {
      try {
        const html = await fetchEmployerPage(url);
        if (isLoggedOut(html)) {
          logger.warn("Logged-out response from myvisajobs", { url });
          continue;
        }
        const listings = parseCompanyListing(html);
        for (const item of listings) {
          if (seenIds.has(item.lcaId)) continue;
          seenIds.add(item.lcaId);
          allListings.push(item);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("myvisajobs fetch failed", { url, err: msg });
      }
    }

    if (allListings.length === 0) {
      logger.info("No jobs found for company on myvisajobs", { companyName });
      return {
        company: companyName,
        jobsFound: 0,
        jobsSkipped: 0,
        jobsEnriched: 0,
        jobsFailed: 0,
        reason: "no-myvisajobs-listings",
      };
    }

    // 2. Pick top N distinct titles (highest signal per unique title)
    const byTitle = new Map<string, MyVisaJobsListingItem>();
    for (const item of allListings) {
      const key = (item.jobTitle ?? item.lcaId).toLowerCase();
      if (!byTitle.has(key)) byTitle.set(key, item);
    }
    const top = Array.from(byTitle.values()).slice(
      0,
      CONFIG.OUTREACH_TOP_JOBS_PER_EMPLOYER,
    );

    // 3. Dedup vs existing Job_Descriptions (per-job guard)
    const existing = await getExistingJobDescriptionLcaIds();
    const toEnrich = top.filter((i) => !existing.has(i.lcaId));
    const skipped = top.length - toEnrich.length;

    if (toEnrich.length === 0) {
      logger.info("All top jobs already enriched, skipping", { companyName });
      return {
        company: companyName,
        jobsFound: top.length,
        jobsSkipped: skipped,
        jobsEnriched: 0,
        jobsFailed: 0,
        reason: "all-already-scraped",
      };
    }

    // 4. Fan out enrichment via batchTriggerAndWait
    const firstItem = toEnrich[0];
    const employerSlug = firstItem.employerSlug ?? null;

    const items = toEnrich.map((item) => ({
      payload: {
        lcaId: item.lcaId,
        lcaUrl: item.lcaUrl,
        employerName: item.employerName ?? companyName,
        employerSlug,
        employerEmail: email,
        jobTitle: item.jobTitle ?? "Unknown",
        outreachRow: rowNumber,
        outreachRank: rank,
        locationHint: item.location,
      },
    }));

    const result = await tasks.batchTriggerAndWait<typeof enrichJobDescription>(
      "myvisajobs.enrich-job-description",
      items,
    );

    let enriched = 0;
    let failed = 0;
    for (const r of result.runs) {
      if (r.ok && r.output.written) enriched++;
      else failed++;
    }

    logger.info("Outreach employer done", {
      company: companyName,
      jobsFound: top.length,
      jobsSkipped: skipped,
      jobsEnriched: enriched,
      jobsFailed: failed,
    });

    return {
      company: companyName,
      jobsFound: top.length,
      jobsSkipped: skipped,
      jobsEnriched: enriched,
      jobsFailed: failed,
    };
  },
});
