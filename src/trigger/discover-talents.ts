import { logger, schedules } from "@trigger.dev/sdk";
import { CONFIG } from "../lib/config.js";
import {
  fetchMatchInviteFormState,
  fetchMatchInviteFormStateDebug,
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

    // Diagnostic — surface why discovery yields 0 if it does. Returned in
    // the task output so it shows up in the Trigger.dev dashboard.
    const cookie = process.env.MYVISAJOBS_TALENT_COOKIE ?? "";
    const debug: Record<string, unknown> = {
      cookiePresent: cookie.length > 0,
      cookieLength: cookie.length,
      cookieHasAspSession: cookie.includes("ASP.NET_SessionId"),
      cookieHasYourAppName: cookie.includes("yourAppName"),
      cookieHasQVWROLES: cookie.includes("QVWROLES"),
    };

    let firstSearchDone = false;
    // One-time GET diagnostic so we can see what the empty form looks like.
    try {
      const dbg = await fetchMatchInviteFormStateDebug();
      debug.getResponseTitle = dbg.title;
      debug.getResponseHtmlLength = dbg.html.length;
      debug.getResponseHasMatchForm = /MainContent\$ddlOccupations/.test(dbg.html);
      debug.getResponseHiddenFields = dbg.hiddenInputs.map((h) => `${h.name}(${h.valueLength})`).join(", ");
      debug.getResponseHtmlHead = dbg.html.slice(0, 800);
    } catch (err) {
      debug.getDiagnosticError = err instanceof Error ? err.message : String(err);
    }
    for (const kw of TALENT_KEYWORD_SETS) {
      for (const career of COMPUTER_SPECIALIST_CAREERS) {
        await sleep(800 + Math.random() * 800);
        try {
          // Refresh form state per search — VIEWSTATE is single-use after a postback.
          const formState = await fetchMatchInviteFormState();
          if (!firstSearchDone) {
            debug.formStateOk = !!formState.viewState && !!formState.eventValidation;
            debug.viewStateLength = formState.viewState?.length ?? 0;
            debug.viewStateGeneratorPresent = !!formState.viewStateGenerator;
          }
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

          // Capture details from the very first search so we can debug.
          if (!firstSearchDone) {
            firstSearchDone = true;
            debug.firstSearchKeyword = kw.tag;
            debug.firstSearchCareer = career.code;
            debug.firstSearchHtmlLength = html.length;
            debug.firstSearchResults = results.length;
            debug.firstSearchHtmlHeadSnippet = html.slice(0, 600);
            debug.firstSearchHtmlBodyStart = html.slice(2000, 2600);
            debug.firstSearchHtmlBodyMid = html.slice(20000, 20600);
            debug.firstSearchHasCandidateLinks = /\/candidate\//i.test(html);
            debug.firstSearchHasSignInIndicator = /Sign\s*In|signin\.aspx/i.test(html);
            debug.firstSearchHasUpgradePrompt = /upgrade|premium\s*employer/i.test(html);
            debug.firstSearchHasResultsTable = /<table[^>]*>[\s\S]*?<a[^>]*\/candidate\//i.test(html);
            debug.firstSearchTitle = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
            debug.firstSearchHasErrorMsg = /error|exception|invalid|failed/i.test(html.slice(0, 5000));
            debug.firstSearchHasMatchedText = /matched\s+\d+\s+candidate|Our system matched/i.test(html);
            debug.firstSearchHasGenericServerError = /Page\s+Temporarily\s+Unavailable|System is taking a break/i.test(html);
            logger.info("First match-invite search debug", debug);
          }

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
      logger.info("Discovery yielded 0 new talents", { totalSeen, searchesFailed, debug });
      await updateDashboard({
        lastRun: new Date().toISOString(),
        lastRunStatus: `talent-discovery: 0 new (${totalSeen} seen)`,
      });
      return { added: 0, totalSeen, searchesFailed, debug };
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

    return { added: toQueue.length, totalSeen, searchesFailed, debug };
  },
});
