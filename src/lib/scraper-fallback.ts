import * as cheerio from "cheerio";

/**
 * Tier-2 fallback scraper — used when Firecrawl fails or budget runs out.
 * Patterns borrowed from the blog-maker Python scraper: rotating UA,
 * encoding detection, multi-tag text extraction with dedup, skip patterns
 * for non-content URLs.
 */

const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

function randomUA(): string {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

export type FallbackScrapeResult = {
  markdown: string;
  title: string | null;
  description: string | null;
};

export class FallbackScrapeError extends Error {}

/**
 * Fetch a URL with realistic browser headers, detect encoding if needed,
 * and extract the main readable content as a markdown-ish string.
 */
export async function fetchAndExtract(url: string): Promise<FallbackScrapeResult> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": randomUA(),
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Upgrade-Insecure-Requests": "1",
      "Cache-Control": "no-cache",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
    },
    redirect: "follow",
  });

  if (!res.ok) {
    throw new FallbackScrapeError(`HTTP ${res.status} for ${url}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    throw new FallbackScrapeError(`Non-HTML content-type: ${contentType}`);
  }

  // Encoding detection — try response.text() first; if it looks garbled,
  // decode the raw bytes against a fallback chain.
  let html = await res.text();
  if (isGarbled(html)) {
    const buf = new Uint8Array(await res.arrayBuffer());
    for (const enc of ["utf-8", "latin1", "windows-1252", "iso-8859-1"]) {
      try {
        const decoded = new TextDecoder(enc, { fatal: false }).decode(buf);
        if (!isGarbled(decoded)) {
          html = decoded;
          break;
        }
      } catch {
        // try next
      }
    }
  }

  const $ = cheerio.load(html);

  // Remove noise
  $("script, style, noscript, iframe, svg, canvas, video, audio").remove();

  const title = textOf($("title").first()) ?? textOf($('meta[property="og:title"]')) ?? null;
  const description =
    attrOf($('meta[name="description"]'), "content") ??
    attrOf($('meta[property="og:description"]'), "content") ??
    null;

  // Prefer a semantic main/article container if present
  let $root = $("article").first();
  if ($root.length === 0) $root = $("main").first();
  if ($root.length === 0) $root = $('[role="main"]').first();
  if ($root.length === 0) $root = $("body");

  const lines: string[] = [];
  const seen = new Set<string>();

  // Multi-tag extraction with dedup (from blog-maker's approach)
  $root
    .find("h1, h2, h3, h4, h5, h6, p, li, td, th, blockquote, pre, code")
    .each((_, el) => {
      const tag = "tagName" in el ? (el.tagName as string).toLowerCase() : "";
      const text = $(el).text().replace(/\s+/g, " ").trim();
      if (!text || text.length < 3 || seen.has(text)) return;
      seen.add(text);

      if (tag === "h1") lines.push(`# ${text}`);
      else if (tag === "h2") lines.push(`## ${text}`);
      else if (tag === "h3") lines.push(`### ${text}`);
      else if (tag === "h4" || tag === "h5" || tag === "h6") lines.push(`#### ${text}`);
      else if (tag === "li") lines.push(`- ${text}`);
      else if (tag === "pre" || tag === "code") lines.push("```\n" + text + "\n```");
      else if (tag === "blockquote") lines.push(`> ${text}`);
      else lines.push(text);
    });

  const markdown = lines.join("\n\n").trim();
  if (markdown.length < 100) {
    throw new FallbackScrapeError(`Extracted content too thin (${markdown.length} chars)`);
  }

  return { markdown, title, description };
}

function textOf($el: ReturnType<cheerio.CheerioAPI>): string | null {
  const t = $el.text().trim();
  return t.length ? t : null;
}

function attrOf(
  $el: ReturnType<cheerio.CheerioAPI>,
  name: string,
): string | null {
  const v = $el.attr(name);
  return v && v.trim().length ? v.trim() : null;
}

function isGarbled(s: string): boolean {
  if (!s) return true;
  const replacements = (s.match(/�/g) ?? []).length;
  return replacements > s.length * 0.05;
}
