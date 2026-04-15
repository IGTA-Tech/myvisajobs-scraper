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
  const headers: Record<string, string> = {
    "User-Agent": CONFIG.USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
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

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
