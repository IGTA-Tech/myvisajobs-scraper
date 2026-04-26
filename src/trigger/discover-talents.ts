import { logger, schedules } from "@trigger.dev/sdk";
import { CONFIG } from "../lib/config.js";
import {
  appendToTalentQueue,
  getKnownTalentIds,
  isPaused,
  updateDashboard,
  TalentQueueAppendItem,
} from "../lib/sheets.js";
import { sendTelegramAlert } from "../lib/telegram.js";
import { CookieExpiredError } from "../lib/fetcher.js";
import {
  pickDiscoverySpecs,
  runDiscoverySession,
} from "../lib/talent-discovery-browser.js";

/**
 * Headless-Chromium discovery cron. Each tick logs in via
 * MYVISAJOBS_TALENT_COOKIE, runs CONFIG.TALENT_DISCOVERY_SEARCHES_PER_RUN
 * Match-and-Invite searches, and queues new candidate URLs into Talent_Queue.
 *
 * Stateless rotation: the (career × keyword) slot is derived from the run
 * timestamp, so consecutive runs cover different filter combinations and
 * eventually wrap through the full grid (11 careers × 5 keyword sets = 55).
 *
 * Scheduled every 4 hours; at 10 searches/run that's 60/day — full grid
 * cycled in ~22 hours.
 */
export const discoverTalents = schedules.task({
  id: "myvisajobs.discover-talents",
  cron: { pattern: "0 */4 * * *", timezone: CONFIG.TIMEZONE },
  maxDuration: 2400,
  machine: "medium-1x",
  run: async (payload) => {
    logger.info("discover-talents tick");

    if (await isPaused()) {
      logger.info("Paused via Control sheet");
      return { added: 0, paused: true };
    }

    // Derive a deterministic rotation slot from the scheduled run time —
    // wraps the (career × keyword) grid every ~22 hours at 10 searches/run.
    const baseTime = payload.timestamp instanceof Date ? payload.timestamp : new Date();
    const slot = Math.floor(baseTime.getTime() / (1000 * 60 * 60 * 4));
    const specs = pickDiscoverySpecs(slot, CONFIG.TALENT_DISCOVERY_SEARCHES_PER_RUN);

    const known = await getKnownTalentIds();

    let session;
    try {
      session = await runDiscoverySession(specs);
    } catch (err) {
      if (err instanceof CookieExpiredError) {
        await sendTelegramAlert(
          "critical",
          "MYVISAJOBS_TALENT_COOKIE expired (discovery)",
          "Headless discovery hit a sign-in page. Refresh MYVISAJOBS_TALENT_COOKIE on Trigger.dev.",
        );
        return { added: 0, totalSeen: 0, totalFailed: specs.length, cookieExpired: true };
      }
      throw err;
    }

    const seenInRun = new Set<string>();
    const toQueue: TalentQueueAppendItem[] = [];
    for (const outcome of session.outcomes) {
      for (const r of outcome.results) {
        if (known.has(r.talentId) || seenInRun.has(r.talentId)) continue;
        seenInRun.add(r.talentId);
        toQueue.push({
          talentId: r.talentId,
          profileUrl: r.profileUrl,
          discoverySource: `match:${outcome.spec.keywords.tag}:${outcome.spec.career.code}`,
        });
      }
    }

    if (toQueue.length > 0) {
      await appendToTalentQueue(toQueue);
    }

    if (session.totalFailed > specs.length * 0.4) {
      await sendTelegramAlert(
        "warning",
        "Talent discovery: many searches failed",
        `${session.totalFailed}/${specs.length} headless searches failed this tick.`,
      );
    }

    await updateDashboard({
      lastRun: new Date().toISOString(),
      lastRunStatus: `talent-discovery: +${toQueue.length} queued (${session.totalSeen} seen, ${session.totalFailed} failed)`,
    });

    logger.info("discover-talents complete", {
      slot,
      searches: specs.length,
      queued: toQueue.length,
      totalSeen: session.totalSeen,
      totalFailed: session.totalFailed,
    });

    return {
      added: toQueue.length,
      totalSeen: session.totalSeen,
      totalFailed: session.totalFailed,
      slot,
      searches: specs.length,
    };
  },
});
