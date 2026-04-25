import { logger, schedules, tasks } from "@trigger.dev/sdk";
import { CONFIG } from "../lib/config.js";
import { readTalentQueue, isPaused, updateDashboard } from "../lib/sheets.js";
import { scrapeTalent } from "./scrape-talent.js";
import { sendTelegramAlert } from "../lib/telegram.js";

/**
 * Drains the Talent_Queue every hour. Each tick takes up to
 * TALENT_QUEUE_BATCH_SIZE (200) pending rows, fan-outs via
 * batchTriggerAndWait. With 24 hourly runs × 200 = 4,800 max/day, well
 * above the 1,500/day target.
 */
export const processTalentQueue = schedules.task({
  id: "myvisajobs.process-talent-queue",
  cron: { pattern: "10 * * * *", timezone: CONFIG.TIMEZONE },
  maxDuration: 2400,
  run: async () => {
    logger.info("process-talent-queue tick");

    if (await isPaused()) {
      logger.info("Paused via Control sheet");
      return { processed: 0, paused: true };
    }

    const pending = await readTalentQueue(CONFIG.TALENT_QUEUE_BATCH_SIZE);
    if (pending.length === 0) {
      logger.info("Talent_Queue empty");
      return { processed: 0 };
    }

    const items = pending.map((p) => ({
      payload: {
        talentId: p.talentId,
        profileUrl: p.profileUrl,
        queueRowNumber: p.rowNumber,
        discoverySource: p.discoverySource,
      },
    }));

    const result = await tasks.batchTriggerAndWait<typeof scrapeTalent>(
      "myvisajobs.scrape-talent",
      items,
    );

    let written = 0;
    let failed = 0;
    for (const r of result.runs) {
      if (r.ok && r.output.written) written++;
      else failed++;
    }

    if (failed > pending.length * 0.5) {
      await sendTelegramAlert(
        "error",
        "Talent scraper failing broadly",
        `${failed}/${pending.length} talents failed in the latest batch. Check logs and cookie.`,
      );
    }

    await updateDashboard({
      lastRun: new Date().toISOString(),
      lastRunStatus: `talent-queue: ${pending.length} processed, +${written} written`,
    });

    logger.info("process-talent-queue done", { processed: pending.length, written, failed });
    return { processed: pending.length, written, failed };
  },
});
