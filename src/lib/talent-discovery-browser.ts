import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  parseMatchInviteResults,
  type MatchInviteResult,
  COMPUTER_SPECIALIST_CAREERS,
  TALENT_KEYWORD_SETS,
} from "./match-invite.js";
import { CookieExpiredError } from "./fetcher.js";

const MATCH_INVITE_URL = "https://www.myvisajobs.com/emp/hiring/match.aspx";

export type DiscoverySearchSpec = {
  career: { code: string; label: string };
  keywords: { tag: string; keywords: string };
};

export type DiscoverySearchOutcome = {
  spec: DiscoverySearchSpec;
  results: MatchInviteResult[];
  error?: string;
};

export type DiscoverySessionResult = {
  outcomes: DiscoverySearchOutcome[];
  totalSeen: number;
  totalFailed: number;
};

/**
 * Convert the env-var cookie string ("k1=v1; k2=v2; k3=v3") into the
 * cookie objects Playwright's BrowserContext expects.
 */
function parseCookieHeader(cookie: string, domain = ".myvisajobs.com") {
  return cookie
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf("=");
      const name = i === -1 ? pair : pair.slice(0, i);
      const value = i === -1 ? "" : pair.slice(i + 1);
      return {
        name,
        value,
        domain,
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: "Lax" as const,
      };
    });
}

/**
 * Rotate deterministically through the (career × keywords) cross-product
 * so each cron tick covers a fresh slice without server-side cursor state.
 * `slot` should be a monotonically-increasing integer (e.g. epoch / interval).
 */
export function pickDiscoverySpecs(slot: number, count: number): DiscoverySearchSpec[] {
  const all: DiscoverySearchSpec[] = [];
  for (const career of COMPUTER_SPECIALIST_CAREERS) {
    for (const keywords of TALENT_KEYWORD_SETS) {
      all.push({ career, keywords });
    }
  }
  const start = ((slot % all.length) + all.length) % all.length;
  const out: DiscoverySearchSpec[] = [];
  for (let i = 0; i < count; i++) {
    out.push(all[(start + i) % all.length]);
  }
  return out;
}

/**
 * Open a Chromium session pre-authenticated via MYVISAJOBS_TALENT_COOKIE
 * and run a list of Match-and-Invite searches. Returns the parsed result
 * rows for each search. The caller is responsible for deduping against
 * existing Talent_Queue / Talents.
 */
export async function runDiscoverySession(
  specs: DiscoverySearchSpec[],
): Promise<DiscoverySessionResult> {
  const cookie = process.env.MYVISAJOBS_TALENT_COOKIE;
  if (!cookie) {
    throw new Error("MYVISAJOBS_TALENT_COOKIE is not set");
  }

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  const outcomes: DiscoverySearchOutcome[] = [];
  let totalSeen = 0;
  let totalFailed = 0;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 800 },
    });
    await context.addCookies(parseCookieHeader(cookie));
    page = await context.newPage();

    for (const spec of specs) {
      try {
        const html = await runOneSearch(page, spec);
        const results = parseMatchInviteResults(html);
        totalSeen += results.length;
        outcomes.push({ spec, results });
      } catch (err) {
        totalFailed++;
        if (err instanceof CookieExpiredError) {
          // Stop the whole session — no point continuing without auth.
          outcomes.push({
            spec,
            results: [],
            error: "cookie-expired",
          });
          throw err;
        }
        outcomes.push({
          spec,
          results: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }

  return { outcomes, totalSeen, totalFailed };
}

async function runOneSearch(page: Page, spec: DiscoverySearchSpec): Promise<string> {
  const { career, keywords } = spec;

  await page.goto(MATCH_INVITE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

  const html0 = await page.content();
  if (looksLoggedOut(html0)) throw new CookieExpiredError();

  // Suboccupation cascades from Occupation (auto-postback). Setting Occupation
  // to "15-1000" reloads the form with the IT-and-Math suboccupations.
  await page.selectOption("#ctl00_MainContent_ddlOccupations", "15");
  await page.waitForLoadState("networkidle", { timeout: 20000 });

  await page.selectOption("#ctl00_MainContent_ddlSubOccupations", "15-1000");
  await page.waitForLoadState("networkidle", { timeout: 20000 });

  await page.selectOption("#ctl00_MainContent_ddlCareer", career.code);

  await page.fill("#ctl00_MainContent_txtInfo", keywords.keywords);

  // Submit and wait for the results table to render.
  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: 25000 }),
    page.click("#ctl00_MainContent_btnSaveOnly"),
  ]);

  const html = await page.content();
  if (looksLoggedOut(html)) throw new CookieExpiredError();
  return html;
}

function looksLoggedOut(html: string): boolean {
  return /sign\s*in\s*to\s*(continue|your account)|signin\.aspx/i.test(html.slice(0, 5000));
}
