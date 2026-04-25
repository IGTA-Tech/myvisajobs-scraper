import { logger, schedules } from "@trigger.dev/sdk";
import { CONFIG } from "../lib/config.js";
import {
  fetchMatchInviteFormState,
  searchMatchInvite,
  parseMatchInviteResults,
  COMPUTER_SPECIALIST_CAREERS,
  TALENT_KEYWORD_SETS,
} from "../lib/match-invite.js";
import {
  appendToTalentQueue,
  getKnownTalentIds,
  isPaused,
  updateDashboard,
  TalentQueueAppendItem,
} from "../lib/sheets.js";
import { sendTelegramAlert } from "../lib/telegram.js";
import { sleep } from "../lib/fetcher.js";
import { CookieExpiredError } from "../lib/fetcher.js";

/**
 * Daily 5am Lagos discovery cron. Iterates keyword × career combinations
 * (5 keyword sets × 11 career codes = 55 searches), POSTs each to
 * /emp/match.aspx, extracts candidate URLs, dedups, queues new ones.
 *
 * Theoretical max ~25 results per search × 55 = 1,375. After cross-search
 * dedup typically lands at ~800-1,200 unique new talents per run.
 */
export const discoverTalents = schedules.task({
  id: "myvisajobs.discover-talents",
  cron: { pattern: "0 5 * * *", timezone: CONFIG.TIMEZONE },
  maxDuration: 1500,
  run: async () => {
    logger.info("discover-talents tick");

    if (await isPaused()) {
      logger.info("Paused via Control sheet");
      return { added: 0, paused: true };
    }

    const known = await getKnownTalentIds();
    const toQueue: TalentQueueAppendItem[] = [];
    const queuedThisRun = new Set<string>();
    let totalSeen = 0;
    let searchesFailed = 0;

    for (const kw of TALENT_KEYWORD_SETS) {
      for (const career of COMPUTER_SPECIALIST_CAREERS) {
        await sleep(800 + Math.random() * 800);
        try {
          // Refresh form state per search — VIEWSTATE is single-use after a postback.
          const formState = await fetchMatchInviteFormState();
          const html = await searchMatchInvite(
            {
              keywords: kw.keywords,
              occupation: CONFIG.TALENT_OCCUPATION,
              suboccupation: CONFIG.TALENT_SUBOCCUPATION,
              career: career.code,
            },
            formState,
          );
          const results = parseMatchInviteResults(html);
          totalSeen += results.length;

          for (const r of results) {
            if (known.has(r.talentId) || queuedThisRun.has(r.talentId)) continue;
            queuedThisRun.add(r.talentId);
            toQueue.push({
              talentId: r.talentId,
              profileUrl: r.profileUrl,
              discoverySource: `match:${kw.tag}:${career.code}`,
            });
          }
        } catch (err) {
          searchesFailed++;
          if (err instanceof CookieExpiredError) {
            await sendTelegramAlert(
              "critical",
              "MYVISAJOBS_TALENT_COOKIE expired (discovery)",
              `Match and Invite returned a sign-in page during discovery. Refresh MYVISAJOBS_TALENT_COOKIE.`,
            );
            // Don't keep retrying once the cookie is dead
            throw err;
          }
          logger.warn("match-invite search failed", {
            kw: kw.tag,
            career: career.code,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    if (toQueue.length === 0) {
      logger.info("Discovery yielded 0 new talents", { totalSeen, searchesFailed });
      await updateDashboard({
        lastRun: new Date().toISOString(),
        lastRunStatus: `talent-discovery: 0 new (${totalSeen} seen)`,
      });
      return { added: 0, totalSeen, searchesFailed };
    }

    await appendToTalentQueue(toQueue);

    if (searchesFailed > TALENT_KEYWORD_SETS.length * COMPUTER_SPECIALIST_CAREERS.length * 0.3) {
      await sendTelegramAlert(
        "warning",
        "Talent discovery: many searches failing",
        `${searchesFailed} of ${TALENT_KEYWORD_SETS.length * COMPUTER_SPECIALIST_CAREERS.length} match-invite searches failed. Check logs.`,
      );
    }

    await updateDashboard({
      lastRun: new Date().toISOString(),
      lastRunStatus: `talent-discovery: +${toQueue.length} queued (${totalSeen} seen)`,
    });

    logger.info("discover-talents complete", {
      queued: toQueue.length,
      totalSeen,
      searchesFailed,
    });

    return { added: toQueue.length, totalSeen, searchesFailed };
  },
});
