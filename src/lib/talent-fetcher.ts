import { CONFIG } from "./config.js";
import { RateLimitError } from "./fetcher.js";

/**
 * Fetcher for the talent pipeline. Uses MYVISAJOBS_TALENT_COOKIE which is
 * tied to the user's premium EMPLOYER account (separate from the premium
 * talent/job-seeker account used by MYVISAJOBS_COOKIE for employer/LCA
 * scraping).
 *
 * Only used now for GET fetches of individual /candidate/ profile pages.
 * Match-and-Invite searches are driven by Playwright (see
 * `talent-discovery-browser.ts`).
 */
function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": CONFIG.USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    ...extra,
  };
  const cookie = process.env.MYVISAJOBS_TALENT_COOKIE;
  if (cookie) headers["Cookie"] = cookie;
  return headers;
}

export async function fetchTalentPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: buildHeaders(),
    redirect: "follow",
  });
  if (res.status === 429 || res.status === 403) throw new RateLimitError(res.status);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return await res.text();
}

/**
 * Detect logged-out talent-account responses. The premium employer
 * /emp/match.aspx page redirects to /account/signin.aspx when not
 * authenticated, and individual /candidate/ pages show a "premium
 * employer to view personal information" placeholder.
 */
export function isTalentLoggedOut(html: string): boolean {
  if (/Home\s*>\s*Account\s*>\s*Sign\s*In/i.test(html)) return true;
  if (/<title[^>]*>\s*Sign\s*In\s*\|/i.test(html)) return true;
  return false;
}
