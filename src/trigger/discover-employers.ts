import { logger, schedules } from "@trigger.dev/sdk";
import * as cheerio from "cheerio";
import { CONFIG } from "../lib/config.js";
import {
  getExistingUrls,
  getQueuedUrls,
  appendToQueue,
  updateDashboard,
  isPaused,
  QueueAppendRow,
} from "../lib/sheets.js";
import { fetchEmployerPage, RateLimitError, isLoggedOut, sleep } from "../lib/fetcher.js";
import { sendTelegramAlert } from "../lib/telegram.js";

const BASE = "https://www.myvisajobs.com";

type DiscoverySourceDef = {
  url: string;
  tag: string;
  humanLabel: string;
};

// Confirmed working discovery sources. State/industry URLs were rejected —
// they silently echo the national top-100. Broader discovery happens
// organically via related-employer graph traversal inside scrape-employer.
const SOURCES: DiscoverySourceDef[] = [
  {
    url: `${BASE}/reports/h1b/`,
    tag: "top_h1b_sponsors",
    humanLabel: "Top H-1B Visa Sponsors ranking",
  },
  {
    url: `${BASE}/reports/green-card.aspx`,
    tag: "top_gc_sponsors",
    humanLabel: "Top Green Card Sponsors ranking",
  },
  {
    url: `${BASE}/h1b/cap-exempt-employers`,
    tag: "cap_exempt",
    humanLabel: "Cap-Exempt H-1B Employers (universities, nonprofits, research)",
  },
];

function normalizeEmployerUrl(href: string): string | null {
  const m = href.match(/^\/employer\/([a-z0-9-]+)\/?$/i);
  if (!m) return null;
  return `${BASE}/employer/${m[1].toLowerCase()}/`;
}

/**
 * Extracts employer URLs in page order so we can record the rank/position
 * at which each employer appeared on the source list.
 */
function extractEmployerLinksOrdered(html: string): string[] {
  const $ = cheerio.load(html);
  const urls: string[] = [];
  const seen = new Set<string>();
  $('a[href*="/employer/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const normalized = normalizeEmployerUrl(href);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    urls.push(normalized);
  });
  return urls;
}

function formatLagosTime(d: Date): string {
  try {
    return (
      new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Africa/Lagos",
      }).format(d) + " WAT"
    );
  } catch {
    return d.toISOString();
  }
}

function buildDiscoveryPrefix(
  def: DiscoverySourceDef,
  position: number,
  total: number,
  timestamp: Date,
): string {
  return `${formatLagosTime(timestamp)} · ${def.humanLabel} (${def.url}) · position #${position}/${total}`;
}

export const discoverEmployers = schedules.task({
  id: "myvisajobs.discover-employers",
  cron: { pattern: "0 6 * * *", timezone: CONFIG.TIMEZONE },
  maxDuration: 300,
  run: async () => {
    logger.info("discover-employers starting");

    if (await isPaused()) {
      logger.info("Paused via Control sheet");
      return { added: 0, paused: true };
    }

    // Collect from all discovery sources, preserving rank/position.
    // Be polite: small delay between source fetches (102 sources now).
    const now = new Date();
    const candidates: QueueAppendRow[] = [];
    let totalDiscovered = 0;
    let sourcesFailed = 0;

    for (let idx = 0; idx < SOURCES.length; idx++) {
      const def = SOURCES[idx];
      if (idx > 0) await sleep(500 + Math.random() * 500);

      try {
        const html = await fetchEmployerPage(def.url);

        if (isLoggedOut(html)) {
          logger.warn("Discovery source shows logged-out placeholder", {
            source: def.url,
          });
        }

        const links = extractEmployerLinksOrdered(html);
        totalDiscovered += links.length;

        links.forEach((url, i) => {
          candidates.push({
            url,
            discoverySource: def.tag,
            discoveryNotes: buildDiscoveryPrefix(def, i + 1, links.length, now),
          });
        });

        if (idx % 20 === 0) {
          logger.info("Discovery progress", {
            completed: idx + 1,
            total: SOURCES.length,
            candidates: candidates.length,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sourcesFailed++;
        logger.error("Discovery source failed", { source: def.url, err: msg });
        if (err instanceof RateLimitError) {
          await sendTelegramAlert(
            "warning",
            "Discovery rate limited",
            `Source: ${def.url}\nStatus: ${err.status}\nPausing this run.`,
          );
          break;
        }
      }
    }

    logger.info("Discovery sweep complete", {
      sources: SOURCES.length,
      sourcesFailed,
      candidates: candidates.length,
      totalDiscovered,
    });

    if (candidates.length === 0) {
      await sendTelegramAlert(
        "error",
        "Discovery found zero employers",
        `All ${SOURCES.length} sources returned no results. Report pages may have changed — check HTML structure.`,
      );
      return { added: 0, discovered: 0 };
    }

    // Dedup against existing leads + queue; keep first occurrence (preserves top-H1B ranking)
    const [existing, queued] = await Promise.all([getExistingUrls(), getQueuedUrls()]);
    const seen = new Set<string>([...existing, ...queued]);

    const toAdd: QueueAppendRow[] = [];
    const addedUrls = new Set<string>();
    for (const c of candidates) {
      const key = c.url.toLowerCase();
      if (seen.has(key) || addedUrls.has(key)) continue;
      toAdd.push(c);
      addedUrls.add(key);
      if (toAdd.length >= CONFIG.MAX_DISCOVERY_APPEND) break;
    }

    if (toAdd.length === 0) {
      logger.info("No new employers to add", {
        discovered: totalDiscovered,
        unique: candidates.length,
        alreadyKnown: seen.size,
      });
      await updateDashboard({
        lastRun: new Date().toISOString(),
        lastRunStatus: `discovery: 0 new (${totalDiscovered} seen)`,
      });
      return { added: 0, discovered: totalDiscovered };
    }

    await appendToQueue(toAdd);
    logger.info("Queued new employers", { added: toAdd.length });

    await updateDashboard({
      lastRun: new Date().toISOString(),
      lastRunStatus: `discovery: +${toAdd.length} new`,
    });

    return { added: toAdd.length, discovered: totalDiscovered };
  },
});
