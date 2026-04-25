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
 * Fetch + return Set-Cookie headers so the caller can forward them on the
 * subsequent POST. ASP.NET WebForms apps sometimes issue anti-CSRF or
 * session-refresh cookies on each GET that must round-trip on the POST,
 * otherwise the form submission is rejected.
 */
export async function fetchTalentPageWithCookies(
  url: string,
): Promise<{ html: string; setCookies: string[] }> {
  const res = await fetch(url, {
    headers: buildHeaders(),
    redirect: "follow",
  });
  if (res.status === 429 || res.status === 403) throw new RateLimitError(res.status);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const setCookies: string[] = [];
  // Node's fetch exposes multiple Set-Cookie via getSetCookie()
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") {
    setCookies.push(...anyHeaders.getSetCookie());
  } else {
    const single = res.headers.get("set-cookie");
    if (single) setCookies.push(single);
  }
  return { html: await res.text(), setCookies };
}

/**
 * POST to an ASP.NET Web Forms endpoint with form-urlencoded body. Used by
 * match-invite.ts to drive the /emp/match.aspx Match and Invite search.
 */
export async function postTalentForm(
  url: string,
  fields: Record<string, string>,
  extraCookies?: string[],
): Promise<string> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);

  // Merge extra cookies (from a prior GET's Set-Cookie) into the static cookie.
  // CRITICAL: myvisajobs rolls QVWROLES (and possibly others) on every request,
  // so when an extra cookie has the same name as one in the static env var,
  // the EXTRA one (newer, rolled) must REPLACE the static one — not be skipped.
  const baseCookie = process.env.MYVISAJOBS_TALENT_COOKIE ?? "";
  const cookieMap = new Map<string, string>();
  baseCookie.split(/;\s*/).forEach((p) => {
    const idx = p.indexOf("=");
    if (idx > 0) {
      const name = p.slice(0, idx).trim();
      const value = p.slice(idx + 1);
      if (name) cookieMap.set(name, value);
    }
  });
  if (extraCookies && extraCookies.length > 0) {
    for (const sc of extraCookies) {
      // "name=value; Path=...; HttpOnly" — keep only name=value
      const cookiePart = sc.split(";")[0].trim();
      const idx = cookiePart.indexOf("=");
      if (idx > 0) {
        const name = cookiePart.slice(0, idx).trim();
        const value = cookiePart.slice(idx + 1);
        if (name) cookieMap.set(name, value); // REPLACE, not skip
      }
    }
  }
  const mergedCookie = Array.from(cookieMap.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

  const headers: Record<string, string> = {
    "User-Agent": CONFIG.USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Content-Type": "application/x-www-form-urlencoded",
    Referer: url,
    "X-Requested-With": "XMLHttpRequest",
  };
  if (mergedCookie) headers["Cookie"] = mergedCookie;

  const res = await fetch(url, {
    method: "POST",
    headers,
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
