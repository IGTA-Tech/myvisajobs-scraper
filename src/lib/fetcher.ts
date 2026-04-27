import { CONFIG } from "./config.js";

export class RateLimitError extends Error {
  constructor(public status: number) {
    super(`Rate limited (${status})`);
  }
}

export class CookieExpiredError extends Error {
  constructor() {
    super(
      "MyVisaJobs session cookie is expired or invalid — logged-out response detected. Update MYVISAJOBS_COOKIE env var.",
    );
  }
}

function buildHeaders(): Record<string, string> {
  // Mirror Chrome 147's full request fingerprint. myvisajobs degrades premium
  // content (LCA Section D, etc.) to empty when the headers don't match a
  // browser-shaped fingerprint, even with a valid premium cookie. The minimal
  // header set we used to send was passing for non-LCA pages but failing on
  // /h1b-visa/lcafull.aspx — captured via DevTools to confirm parity.
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "max-age=0",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Sec-Ch-Ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
  };
  const cookie = process.env.MYVISAJOBS_COOKIE;
  if (cookie) headers["Cookie"] = cookie;
  return headers;
}

export async function fetchEmployerPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: buildHeaders(),
    redirect: "follow",
  });

  if (res.status === 429 || res.status === 403) {
    throw new RateLimitError(res.status);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return await res.text();
}

// ─────────────────────────────────────────────────────────────────────────────
// Session-aware fetching
//
// myvisajobs rotates QVWROLES (and possibly other auth cookies) on EVERY
// response with Set-Cookie + HttpOnly. A single env-var cookie value works
// for the first request, but subsequent requests sending the same value get
// degraded "logged-in but no premium" content. The caller must thread a
// CookieJar through related requests so each one sends the latest rolled
// value the server issued on the prior response.
// ─────────────────────────────────────────────────────────────────────────────

export type CookieJar = Map<string, string>;

export function createSessionJar(): CookieJar {
  const jar: CookieJar = new Map();
  const env = process.env.MYVISAJOBS_COOKIE ?? "";
  for (const pair of env.split(/;\s*/)) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq > 0) {
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
    }
  }
  return jar;
}

function jarToCookieHeader(jar: CookieJar): string {
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function updateJarFromResponse(jar: CookieJar, res: Response): void {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  let setCookies: string[] = [];
  if (typeof headers.getSetCookie === "function") {
    setCookies = headers.getSetCookie();
  } else {
    const single = res.headers.get("set-cookie");
    if (single) setCookies = [single];
  }
  for (const sc of setCookies) {
    const pair = sc.split(";")[0].trim();
    const eq = pair.indexOf("=");
    if (eq > 0) {
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1);
      if (name) jar.set(name, value); // REPLACE rolled cookies, don't skip
    }
  }
}

/**
 * Like fetchEmployerPage but threads a CookieJar across requests so
 * server-issued Set-Cookie values (rolled QVWROLES, etc.) carry forward.
 * Use one jar per task-run.
 */
export async function fetchEmployerPageWithSession(
  url: string,
  jar: CookieJar,
): Promise<string> {
  const headers = buildHeaders();
  headers["Cookie"] = jarToCookieHeader(jar);
  const res = await fetch(url, { headers, redirect: "follow" });
  updateJarFromResponse(jar, res);
  if (res.status === 429 || res.status === 403) {
    throw new RateLimitError(res.status);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return await res.text();
}

/**
 * Returns true if the HTML shows we're logged out (contact data gated).
 * The logged-in view replaces the "Premium Member Only" placeholder with real emails/phones.
 */
export function isLoggedOut(html: string): boolean {
  return html.includes("Premium Member Only, Sign Up Now!");
}

export function jitterDelay(): number {
  const { REQUEST_DELAY_MIN_MS, REQUEST_DELAY_MAX_MS } = CONFIG;
  return REQUEST_DELAY_MIN_MS + Math.random() * (REQUEST_DELAY_MAX_MS - REQUEST_DELAY_MIN_MS);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
