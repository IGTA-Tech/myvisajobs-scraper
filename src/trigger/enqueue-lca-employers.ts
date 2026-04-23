import { logger, schedules, tasks } from "@trigger.dev/sdk";
import { CONFIG } from "../lib/config.js";
import {
  getEmployersToScrapeLcas,
  isPaused,
  updateDashboard,
} from "../lib/sheets.js";
import { scrapeLcasForEmployer } from "./scrape-lcas-for-employer.js";
import { sendTelegramAlert } from "../lib/telegram.js";

/**
 * Daily scheduled task that picks the next batch of employers to LCA-scrape
 * and fans out via batchTriggerAndWait.
 *
 * Scope (option A):
 *  - Top N employers by Visa_Rank (LCA_TOP_N_EMPLOYERS = 2000)
 *  - Skip if LCAs_Last_Scraped within last LCA_RESCRAPE_AFTER_DAYS (90)
 *  - Each run processes LCA_ENQUEUE_BATCH_SIZE (20) employers
 *  - Each employer: 2 years × max 20 LCAs = up to 40 LCA pages
 */
export const enqueueLcaEmployers = schedules.task({
  id: "myvisajobs.enqueue-lca-employers",
  cron: { pattern: "30 */6 * * *", timezone: CONFIG.TIMEZONE },
  maxDuration: 1800,
  run: async () => {
    logger.info("enqueue-lca-employers tick");

    if (await isPaused()) {
      logger.info("Paused via Control sheet");
      return { processed: 0, paused: true };
    }

    const candidates = await getEmployersToScrapeLcas(
      CONFIG.LCA_TOP_N_EMPLOYERS,
      CONFIG.LCA_RESCRAPE_AFTER_DAYS,
    );

    const batch = candidates.slice(0, CONFIG.LCA_ENQUEUE_BATCH_SIZE);
    if (batch.length === 0) {
      logger.info("No employers due for LCA scraping");
      await updateDashboard({
        lastRun: new Date().toISOString(),
        lastRunStatus: "lca: 0 employers due",
      });
      return { processed: 0 };
    }

    logger.info("Enqueueing LCA scrapes", {
      batchSize: batch.length,
      totalCandidates: candidates.length,
      topSlug: batch[0].slug,
      topRank: batch[0].visaRank,
    });

    const items = batch.map((e) => ({
      payload: {
        slug: e.slug,
        employerName: e.name,
        employerRowNumber: e.rowNumber,
      },
    }));

    const result = await tasks.batchTriggerAndWait<typeof scrapeLcasForEmployer>(
      "myvisajobs.scrape-lcas-for-employer",
      items,
    );

    let totalLcas = 0;
    let totalWritten = 0;
    let totalErrors = 0;
    let failedEmployers = 0;

    for (const run of result.runs) {
      if (run.ok) {
        totalLcas += run.output.lcasFound;
        totalWritten += run.output.lcasWritten;
        totalErrors += run.output.errors;
      } else {
        failedEmployers++;
      }
    }

    if (failedEmployers > batch.length * 0.5) {
      await sendTelegramAlert(
        "error",
        "LCA scraper failing broadly",
        `${failedEmployers}/${batch.length} employers failed. Check logs.`,
      );
    }

    await updateDashboard({
      lastRun: new Date().toISOString(),
      lastRunStatus: `lca: ${batch.length} employers, +${totalWritten} contacts`,
    });

    logger.info("LCA batch complete", {
      batchSize: batch.length,
      totalLcas,
      totalWritten,
      totalErrors,
      failedEmployers,
    });

    return {
      processed: batch.length,
      totalLcas,
      totalWritten,
      totalErrors,
      failedEmployers,
    };
  },
});
