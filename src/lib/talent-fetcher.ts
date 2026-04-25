import { CONFIG } from "./config.js";
import { CookieExpiredError, RateLimitError } from "./fetcher.js";

/**
 * Fetcher for the talent pipeline. Uses MYVISAJOBS_TALENT_COOKIE which is
 * tied to the user's premium EMPLOYER account (separate from the premium
 * talent/job-seeker account used by MYVISAJOBS_COOKIE for employer/LCA
 * scraping).
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
 * POST to an ASP.NET Web Forms endpoint with form-urlencoded body. Used by
 * match-invite.ts to drive the /emp/match.aspx Match and Invite search.
 */
export async function postTalentForm(
  url: string,
  fields: Record<string, string>,
): Promise<string> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);

  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders({
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://www.myvisajobs.com",
      Referer: url,
    }),
    body: body.toString(),
    redirect: "follow",
  });
  if (res.status === 429 || res.status === 403) throw new RateLimitError(res.status);
  if (!res.ok) throw new Error(`HTTP ${res.status} POST ${url}`);
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

export function ensureTalentAuthenticated(html: string): void {
  if (isTalentLoggedOut(html)) throw new CookieExpiredError();
}
