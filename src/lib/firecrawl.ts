import { CONFIG } from "./config.js";

export type FirecrawlScrapeResult = {
  markdown: string;
  html?: string;
  metadata?: {
    title?: string;
    description?: string;
    statusCode?: number;
    sourceURL?: string;
    ogTitle?: string;
    ogDescription?: string;
    ogImage?: string;
  };
};

export class FirecrawlError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(`Firecrawl ${status}: ${message}`);
  }
}

/**
 * Scrape a URL via Firecrawl's /v1/scrape endpoint. Returns clean markdown
 * plus a metadata object. Handles anti-bot + JS rendering on most sites.
 *
 * Consumes 1 Firecrawl credit per successful scrape on the Hobby plan.
 */
export async function firecrawlScrape(
  url: string,
  opts: { waitForMs?: number; onlyMainContent?: boolean } = {},
): Promise<FirecrawlScrapeResult> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error("FIRECRAWL_API_KEY is not set");

  const body = {
    url,
    formats: ["markdown"],
    onlyMainContent: opts.onlyMainContent ?? true,
    waitFor: opts.waitForMs ?? 2000,
    timeout: 45000,
    blockAds: true,
  };

  const res = await fetch(CONFIG.FIRECRAWL_SCRAPE_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new FirecrawlError(res.status, text.slice(0, 300));
  }

  const json = (await res.json()) as {
    success?: boolean;
    data?: {
      markdown?: string;
      html?: string;
      metadata?: Record<string, unknown>;
    };
    error?: string;
  };

  if (!json.success || !json.data?.markdown) {
    throw new FirecrawlError(502, json.error ?? "No markdown returned");
  }

  return {
    markdown: json.data.markdown,
    html: json.data.html,
    metadata: (json.data.metadata ?? {}) as FirecrawlScrapeResult["metadata"],
  };
}
