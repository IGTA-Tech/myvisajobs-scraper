import { logger, schedules, tasks } from "@trigger.dev/sdk";
import { CONFIG } from "../lib/config.js";
import {
  readQueue,
  updateQueueRow,
  getExistingUrls,
  updateDashboard,
  isPaused,
} from "../lib/sheets.js";
import { scrapeEmployer, ScrapeResult } from "./scrape-employer.js";
import { sendTelegramAlert } from "../lib/telegram.js";
import { sleep, jitterDelay } from "../lib/fetcher.js";

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

    // Bound parallelism ourselves via a simple worker pool over triggerAndWait.
    const results: Array<{ row: (typeof toProcess)[number]; result?: ScrapeResult; err?: string }> = [];

    const worker = async (items: typeof toProcess) => {
      for (const row of items) {
        try {
          await sleep(jitterDelay());
          const handle = await tasks.triggerAndWait<typeof scrapeEmployer>(
            "myvisajobs.scrape-employer",
            { url: row.url, addedBy: "scheduled" },
          );
          if (handle.ok) {
            results.push({ row, result: handle.output });
          } else {
            const errMsg =
              handle.error && typeof handle.error === "object" && "message" in handle.error
                ? String((handle.error as { message: unknown }).message)
                : String(handle.error ?? "unknown");
            results.push({ row, err: errMsg });
          }
        } catch (err) {
          results.push({ row, err: err instanceof Error ? err.message : String(err) });
        }
      }
    };

    const chunks: Array<typeof toProcess> = Array.from(
      { length: CONFIG.CONCURRENCY },
      () => [],
    );
    toProcess.forEach((item, i) => chunks[i % CONFIG.CONCURRENCY].push(item));
    await Promise.all(chunks.map(worker));

    for (const { row, result, err } of results) {
      if (err || !result?.success) {
        failed++;
        await updateQueueRow(row.rowNumber, "error", err ?? result?.error ?? "unknown");
        continue;
      }
      scraped++;
      if (result.tier === "haiku" || result.tier === "sonnet" || result.tier === "openai") aiFallback++;
      await updateQueueRow(row.rowNumber, "done");
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
