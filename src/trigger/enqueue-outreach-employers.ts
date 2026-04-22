import { logger, schedules, tasks } from "@trigger.dev/sdk";
import { CONFIG } from "../lib/config.js";
import {
  readOutreachCompanies,
  getExistingJobDescriptionLcaIds,
  isPaused,
  updateDashboard,
} from "../lib/sheets.js";
import { processOutreachEmployer } from "./process-outreach-employer.js";
import { sendTelegramAlert } from "../lib/telegram.js";

/**
 * Daily 7am Lagos cron. Reads every row of Outreach_Companies sorted by
 * Rank DESC (bottom-up). Ignores columns D/E (human-tracked flags).
 *
 * For each company, we rely on per-job dedup in processOutreachEmployer:
 * if all top-N jobs are already in Job_Descriptions, that task exits
 * cheaply without consuming credits. So we don't need an employer-level
 * "already processed" filter here — we just push everyone in batches.
 *
 * Batch size = CONFIG.OUTREACH_BATCH_SIZE companies per run.
 */
export const enqueueOutreachEmployers = schedules.task({
  id: "myvisajobs.enqueue-outreach-employers",
  cron: { pattern: "0 7 * * *", timezone: CONFIG.TIMEZONE },
  maxDuration: 2400,
  run: async () => {
    logger.info("enqueue-outreach-employers tick");

    if (await isPaused()) {
      logger.info("Paused via Control sheet");
      return { processed: 0, paused: true };
    }

    const all = await readOutreachCompanies();
    if (all.length === 0) {
      logger.warn("Outreach_Companies tab is empty — nothing to do");
      return { processed: 0 };
    }

    // Pre-filter: if ALL of a company's likely jobs are already known, skip.
    // We can't cheaply know which LCA_IDs they have without fetching, so a
    // cheap proxy: skip companies whose rowId+lcaId combo we have already.
    // But since per-job dedup handles this downstream, the simplest correct
    // behaviour is to just take the first N from the sorted list.
    const existing = await getExistingJobDescriptionLcaIds();
    logger.info("Reading outreach state", {
      totalCompanies: all.length,
      existingJobDescriptions: existing.size,
    });

    // Find companies that have no existing rows — prioritize those first.
    // This is a cheap heuristic; not a hard gate.
    const hasSome = (company: string) => {
      // We don't have employer -> lcaIds index in memory; just use set size
      // as a coarse stat. Leave actual per-job dedup to the child task.
      return false;
    };

    const batch = all.slice(0, CONFIG.OUTREACH_BATCH_SIZE);
    logger.info("Enqueueing outreach batch", {
      batchSize: batch.length,
      topCompany: batch[0]?.companyName,
      topRank: batch[0]?.rank,
    });

    const items = batch.map((c) => ({
      payload: {
        rowNumber: c.rowNumber,
        rank: c.rank,
        companyName: c.companyName,
        email: c.email,
      },
    }));

    const result = await tasks.batchTriggerAndWait<typeof processOutreachEmployer>(
      "myvisajobs.process-outreach-employer",
      items,
    );

    let totalFound = 0;
    let totalSkipped = 0;
    let totalEnriched = 0;
    let totalFailed = 0;
    let companiesWithNoJobs = 0;
    let failedCompanies = 0;

    for (const r of result.runs) {
      if (r.ok) {
        totalFound += r.output.jobsFound;
        totalSkipped += r.output.jobsSkipped;
        totalEnriched += r.output.jobsEnriched;
        totalFailed += r.output.jobsFailed;
        if (r.output.jobsFound === 0) companiesWithNoJobs++;
      } else {
        failedCompanies++;
      }
    }

    if (failedCompanies > batch.length * 0.5) {
      await sendTelegramAlert(
        "error",
        "Outreach scraper failing broadly",
        `${failedCompanies}/${batch.length} employers crashed. Check Trigger.dev logs.`,
      );
    }

    await updateDashboard({
      lastRun: new Date().toISOString(),
      lastRunStatus: `outreach: ${batch.length} employers, +${totalEnriched} jobs`,
    });

    logger.info("Outreach batch complete", {
      batchSize: batch.length,
      totalFound,
      totalSkipped,
      totalEnriched,
      totalFailed,
      companiesWithNoJobs,
      failedCompanies,
    });

    return {
      processed: batch.length,
      totalFound,
      totalSkipped,
      totalEnriched,
      totalFailed,
      companiesWithNoJobs,
      failedCompanies,
    };
  },
});
