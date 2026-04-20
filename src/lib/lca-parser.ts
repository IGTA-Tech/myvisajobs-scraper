import * as cheerio from "cheerio";
import { LCAContact } from "./schema.js";

const BASE = "https://www.myvisajobs.com";

/**
 * Extract LCA IDs + year from an employer's listing page.
 * URL: /h1b/search.aspx?e={slug}&st=certified&y={year}
 *
 * Each job card has a "Job Details" link going to:
 *   /h1b-visa/lcafull.aspx?id={N}&y={year}
 *
 * Returns array of { id, year, url }.
 */
export function extractLcaIdsFromListing(html: string): Array<{
  id: string;
  year: number;
  url: string;
}> {
  const $ = cheerio.load(html);
  const out: Array<{ id: string; year: number; url: string }> = [];
  const seen = new Set<string>();

  $('a[href*="lcafull.aspx"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const m = href.match(/lcafull\.aspx\?(?:[^"&]*&)?id=(\d+)(?:&|$|").*?(?:y=(\d{4}))?/i);
    if (!m) return;
    const id = m[1];
    const yearStr = m[2] ?? href.match(/y=(\d{4})/)?.[1];
    const year = yearStr ? Number(yearStr) : new Date().getFullYear();
    const key = `${id}-${year}`;
    if (seen.has(key)) return;
    seen.add(key);
    const path = href.startsWith("http")
      ? href
      : `${BASE}${href.startsWith("/") ? "" : "/"}${href}`;
    out.push({ id, year, url: path });
  });

  return out;
}

/**
 * Parse the full LCA page HTML. Focuses on:
 *  - top-of-page "Job Summary" header (job title, employer, contact, status)
 *  - Section D "Employer Point of Contact Information" (name, title, email, phone)
 *  - Section E attorney/law firm
 *  - Employment info (wage, worksite)
 *
 * ASP.NET renders labels + values without predictable class names, so we
 * parse by label text matching.
 */
export function parseLcaDetailHtml(
  html: string,
  meta: { lcaId: string; year: number; lcaUrl: string; employerSlug: string },
): Partial<LCAContact> {
  const $ = cheerio.load(html);
  const pageText = $("body").text().replace(/\s+/g, " ").trim();

  const out: Partial<LCAContact> = {
    lcaId: meta.lcaId,
    year: meta.year,
    lcaUrl: meta.lcaUrl,
    employerSlug: meta.employerSlug,
  };

  // Top summary table — pairs like "Employer: ACME Inc. Status: Certified"
  out.employerName =
    matchLabeled(pageText, "Employer") ??
    null;
  out.caseStatus =
    matchLabeled(pageText, "Status") ??
    matchLabeled(pageText, "Case Status") ??
    null;
  out.jobTitle =
    matchLabeled(pageText, "Job Title") ??
    matchLabeled(pageText, "Job Offered") ??
    null;
  out.workCity =
    matchLabeled(pageText, "Work City") ??
    matchLabeled(pageText, "City") ??
    null;
  out.workState =
    matchLabeled(pageText, "Work State") ??
    matchLabeled(pageText, "State") ??
    null;
  out.lawFirm =
    matchLabeled(pageText, "Law Firm") ??
    matchLabeled(pageText, "Firm name and address, PreparerLAST_NAME") ??
    null;

  // Wages — look for numeric patterns near "wage" labels
  const wageRange = pageText.match(
    /(?:Wage\s*(?:Rate\s*of\s*Pay\s*)?(?:From|Minimum)?)[\s:]*\$?([\d,]+(?:\.\d+)?)(?:[\s-]+(?:to|[-])\s*\$?([\d,]+(?:\.\d+)?))?/i,
  );
  if (wageRange) {
    out.salaryMin = parseMoney(wageRange[1]);
    out.salaryMax = parseMoney(wageRange[2] ?? wageRange[1]);
  }

  // Section D — Employer Point of Contact Information
  // Labels are typically numbered like "1. Contact's last (family) name"
  // Walk the page text and extract by label proximity.
  out.contactLastName = pickAfter(
    pageText,
    /(?:Contact[^a-z0-9]+(?:'s)?\s*last\s*\(?family\)?\s*name|Employer\s*Point\s*of\s*Contact[\s\S]*?Last\s*Name)/i,
  );
  out.contactFirstName = pickAfter(
    pageText,
    /(?:Contact[^a-z0-9]+(?:'s)?\s*First\s*\(?given\)?\s*name|First\s*\(given\)\s*name)/i,
  );
  out.contactTitle = pickAfter(
    pageText,
    /(?:Contact[^a-z0-9]+(?:'s)?\s*job\s*title|Point\s*of\s*Contact[\s\S]*?Job\s*title)/i,
  );

  // Email: find any email in the document, prefer one near Section D text
  const emails = Array.from(pageText.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)).map(
    (m) => m[0],
  );
  if (emails.length > 0) {
    // Prefer the first email that appears after "Contact's last" label
    const dSection = pageText.split(/D\.\s*Employer\s*Point\s*of\s*Contact/i)[1];
    if (dSection) {
      const eSection = dSection.split(/E\.\s*Attorney/i)[0];
      const inD = eSection?.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
      out.contactEmail = inD?.[0] ?? emails[0];
    } else {
      out.contactEmail = emails[0];
    }
  }

  // Phone: 7-20 chars with digits + dashes/parens/spaces/plus
  const phoneMatch = pageText.match(
    /(?:Phone|Telephone)\s*(?:number|#)?\s*[:.]?\s*([+\d][\d\s().\-x]{6,})/i,
  );
  if (phoneMatch) {
    const raw = phoneMatch[1].trim();
    // Discard scientific notation floats rendered by ASP.NET
    if (!/^\d+\.\d+e[+-]?\d+$/i.test(raw)) out.contactPhone = raw;
  }

  return out;
}

function matchLabeled(text: string, label: string): string | null {
  const re = new RegExp(
    `${label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*[:.]?\\s*([^|\\n\\r]+?)(?:\\s{2,}|\\s*[|\\n\\r]|\\s*(?:Status|Employer|Contact|Work|Law\\s*Firm|Job|Case|City|State|Phone|Email|Section)\\b)`,
    "i",
  );
  const m = text.match(re);
  if (!m) return null;
  const v = m[1].trim();
  if (!v || v.length > 200) return null;
  if (/^redacted$/i.test(v)) return null;
  return v;
}

function pickAfter(text: string, labelRe: RegExp): string | null {
  const m = text.match(labelRe);
  if (!m) return null;
  const idx = (m.index ?? 0) + m[0].length;
  const tail = text.slice(idx, idx + 200);
  // Value is usually the first non-empty token(s) after the label
  const valMatch = tail.match(/[:.]?\s*([^\n\r|]+?)(?:\s{2,}|\s+\d+\.|\s+[A-Z]\.|\s+(?:Mobile|Email|Phone|Extension)\b)/);
  if (!valMatch) return null;
  const v = valMatch[1].trim();
  if (!v || v.length < 2 || v.length > 100) return null;
  if (/^redacted$/i.test(v)) return null;
  return v;
}

function parseMoney(s: string | null | undefined): number | null {
  if (!s) return null;
  const clean = s.replace(/[,$\s]/g, "");
  const n = Number(clean);
  return Number.isFinite(n) && n > 0 ? n : null;
}
