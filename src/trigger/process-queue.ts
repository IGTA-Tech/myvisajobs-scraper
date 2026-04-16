import { logger, schedules, tasks } from "@trigger.dev/sdk";
import { CONFIG } from "../lib/config.js";
import {
  readQueue,
  updateQueueRow,
  getExistingUrls,
  updateDashboard,
  isPaused,
} from "../lib/sheets.js";
import { scrapeEmployer } from "./scrape-employer.js";
import { sendTelegramAlert } from "../lib/telegram.js";

export const processQueue = schedules.task({
  id: "myvisajobs.process-queue",
  cron: { pattern: "*/15 * * * *", timezone: CONFIG.TIMEZONE },
  maxDuration: 540,
  run: async () => {
    logger.info("process-queue tick");

    if (await isPaused()) {
      logger.info("Scraper paused via Control sheet — skipping tick");
      await updateDashboard({
        lastRun: new Date().toISOString(),
        lastRunStatus: "paused",
      });
      return { processed: 0, paused: true };
    }

    const pending = await readQueue(CONFIG.BATCH_SIZE);
    if (pending.length === 0) {
      logger.info("Queue empty");
      return { processed: 0 };
    }

    const existing = await getExistingUrls();

    const toProcess: typeof pending = [];
    for (const row of pending) {
      const normalized = row.url.trim().toLowerCase();
      if (existing.has(normalized)) {
        await updateQueueRow(row.rowNumber, "duplicate", "Already in IA_Employer_Leads");
        continue;
      }
      await updateQueueRow(row.rowNumber, "processing");
      toProcess.push(row);
    }

    let scraped = 0;
    let failed = 0;
    let aiFallback = 0;
    const duplicates = pending.length - toProcess.length;

    // Trigger.dev v4 forbids Promise.all around triggerAndWait. Use
    // batchTriggerAndWait to spawn all child runs and collect results.
    // Parallelism is bounded by the scrape-employer queue.concurrencyLimit (5).
    const batchItems = toProcess.map((row) => ({
      payload: {
        url: row.url,
        addedBy: "Sherrod",
        discoverySource: row.discoverySource,
        discoveryNotesPrefix: row.discoveryNotes,
      },
    }));

    const batch = await tasks.batchTriggerAndWait<typeof scrapeEmployer>(
      "myvisajobs.scrape-employer",
      batchItems,
    );

    for (let i = 0; i < batch.runs.length; i++) {
      const row = toProcess[i];
      const run = batch.runs[i];
      if (run.ok) {
        scraped++;
        const tier = run.output.tier;
        if (tier === "haiku" || tier === "sonnet" || tier === "openai") aiFallback++;
        if (!run.output.success) {
          failed++;
          await updateQueueRow(row.rowNumber, "error", run.output.error ?? "unknown");
        } else {
          await updateQueueRow(row.rowNumber, "done");
        }
      } else {
        failed++;
        const errMsg =
          run.error && typeof run.error === "object" && "message" in run.error
            ? String((run.error as { message: unknown }).message)
            : String(run.error ?? "unknown");
        await updateQueueRow(row.rowNumber, "error", errMsg);
      }
    }

    // Circuit breaker
    const fallbackRate = toProcess.length > 0 ? aiFallback / toProcess.length : 0;
    if (fallbackRate > CONFIG.CIRCUIT_BREAKER_THRESHOLD && toProcess.length >= 10) {
      await sendTelegramAlert(
        "critical",
        "Circuit breaker tripped",
        `${aiFallback}/${toProcess.length} rows hit AI fallback (${(fallbackRate * 100).toFixed(0)}%).\nCheerio selectors likely drifted — investigate before next run.`,
      );
    }

    await updateDashboard({
      scrapedToday: scraped,
      scrapedTotal: scraped,
      failedToday: failed,
      duplicatesToday: duplicates,
      aiFallbackToday: aiFallback,
      lastRun: new Date().toISOString(),
      lastRunStatus: failed === 0 ? "ok" : `${failed} failed`,
    });

    logger.info("Batch complete", { scraped, failed, duplicates, aiFallback });
    return { processed: toProcess.length, scraped, failed, duplicates, aiFallback };
  },
});
