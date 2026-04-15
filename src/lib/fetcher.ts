import { CONFIG } from "./config.js";

export class RateLimitError extends Error {
  constructor(public status: number) {
    super(`Rate limited (${status})`);
  }
}

export async function fetchEmployerPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": CONFIG.USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
    },
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

export function jitterDelay(): number {
  const { REQUEST_DELAY_MIN_MS, REQUEST_DELAY_MAX_MS } = CONFIG;
  return REQUEST_DELAY_MIN_MS + Math.random() * (REQUEST_DELAY_MAX_MS - REQUEST_DELAY_MIN_MS);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
