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
 * Parse the full LCA page HTML using DOM selectors against the real structure:
 *   - Top `<table class='tbl'>`: key/value pairs for most fields
 *       (Case Number, Status, Employer, Employer Contact, Contact Email,
 *        Preoffered Wage, Work City, Job Name(SOC), Agent or Attorney)
 *   - `<div class='infoList'>` blocks per section (A through L):
 *       Each has `<div class='secHeader'><h4>B. Temporary Need Information</h4></div>`
 *       followed by `<div class='infoHolder'><h5>1. Job Title *</h5><p>VALUE</p></div>`
 *
 * Fields we care about:
 *   - Job Title           → Section B #1
 *   - Section D #1..14    → contact name/title/phone/email
 *   - Section E #15       → Law firm/Business name
 *   - Section F Location 1: City (#6), State (#8), Wage (#10)
 */
export function parseLcaDetailHtml(
  html: string,
  meta: { lcaId: string; year: number; lcaUrl: string; employerSlug: string },
): Partial<LCAContact> {
  const $ = cheerio.load(html);

  const out: Partial<LCAContact> = {
    lcaId: meta.lcaId,
    year: meta.year,
    lcaUrl: meta.lcaUrl,
    employerSlug: meta.employerSlug,
  };

  // --- Top summary table ---
  const summary = extractSummaryTable($);
  out.caseStatus = summary["Status"] ?? null;
  out.employerName = summary["Employer"] ?? null;
  out.caseNumber = summary["Case Number"] ?? null;
  out.occupation = summary["Job Name(SOC)"] ?? summary["SOC"] ?? null;

  // Filing date derived from case number: I-200-YYDOY-XXXXXX
  // e.g. I-200-25042-684041 -> year 2025, day 42 -> 2025-02-11
  if (out.caseNumber) {
    const m = out.caseNumber.match(/^I-\d{3}-(\d{2})(\d{3})-/i);
    if (m) {
      const yy = Number(m[1]);
      const doy = Number(m[2]);
      const year = yy < 50 ? 2000 + yy : 1900 + yy;
      const d = new Date(Date.UTC(year, 0, doy));
      if (Number.isFinite(d.getTime())) {
        out.filingDate = d.toISOString().slice(0, 10);
      }
    }
  }

  // Work_City may arrive as "San Mateo, CA" from summary
  const summaryWorkCity = summary["Work City"] ?? summary["Location"] ?? null;
  if (summaryWorkCity) {
    const m = summaryWorkCity.match(/^(.+?)[,\s]+([A-Z]{2})\s*$/);
    if (m) {
      out.workCity = m[1].trim();
      out.workState = m[2].trim();
    } else {
      out.workCity = summaryWorkCity;
    }
  }

  // Wage (from summary) — "Preoffered Wage: $140000/Year"
  const wageStr = summary["Preoffered Wage"] ?? summary["Prevailing Wage"] ?? "";
  const wageMatch = wageStr.match(/\$?([\d,]+(?:\.\d+)?)/);
  if (wageMatch) {
    const v = parseMoney(wageMatch[1]);
    out.salaryMin = v;
    out.salaryMax = v;
  }

  // Summary "Employer Contact" (full name) + "Contact Email"
  const summaryContactName = summary["Employer Contact"] ?? null;
  const summaryContactEmail = summary["Contact Email"] ?? null;
  if (summaryContactName) {
    const parts = summaryContactName.split(/\s+/);
    if (parts.length >= 2) {
      out.contactFirstName = parts[0];
      out.contactLastName = parts.slice(1).join(" ");
    } else {
      out.contactLastName = summaryContactName;
    }
  }
  if (summaryContactEmail && !/^redacted$/i.test(summaryContactEmail)) {
    out.contactEmail = summaryContactEmail;
  }

  // --- Section B #1 Job Title ---
  const sectionB = extractSectionItems($, /^B\.\s*Temporary/i);
  const jobTitle = findItemValue(sectionB, /^1\.\s*Job\s*Title/i);
  if (jobTitle) out.jobTitle = jobTitle;

  // --- Section D: Employer Point of Contact Information ---
  const sectionD = extractSectionItems($, /^D\.\s*Employer\s*Point\s*of\s*Contact/i);
  const dLast = findItemValue(sectionD, /^1\./);
  const dFirst = findItemValue(sectionD, /^2\./);
  const dTitle = findItemValue(sectionD, /^4\.\s*Contact'?s?\s*job\s*title/i);
  const dPhone = findItemValue(sectionD, /^12\.\s*Telephone/i);
  const dEmail = findItemValue(sectionD, /^14\.\s*E-?Mail/i);
  if (dLast) out.contactLastName = dLast;
  if (dFirst) out.contactFirstName = dFirst;
  if (dTitle) out.contactTitle = dTitle;
  if (dPhone) {
    const phone = cleanPhone(dPhone);
    if (phone) out.contactPhone = phone;
  }
  if (dEmail && !/^redacted$/i.test(dEmail)) out.contactEmail = dEmail;

  // --- Section E #15 Law firm/Business name ---
  const sectionE = extractSectionItems($, /^E\.\s*Attorney/i);
  const lawFirm = findItemValue(sectionE, /Law\s*firm\/Business\s*name/i);
  if (lawFirm) out.lawFirm = lawFirm;

  // --- Section F Location 1 (overrides summary if present) ---
  const sectionF = extractSectionItems($, /^F\.\s*Employment\s*and\s*Wage/i);
  const fCity = findItemValue(sectionF, /^6\.\s*City/i);
  const fState = findItemValue(sectionF, /^8\.\s*State/i);
  if (fCity) out.workCity = fCity;
  if (fState) out.workState = fState;

  // Section F #10 wage range (more granular than summary)
  const wageRow = sectionF.find((it) => /10\.\s*Wage\s*Rate/i.test(it.label));
  if (wageRow) {
    const text = wageRow.value.replace(/\s+/g, " ");
    const fromMatch = text.match(/From:\s*\$?\s*([\d,]+(?:\.\d+)?)/i);
    const toMatch = text.match(/To:\s*\$?\s*([\d,]+(?:\.\d+)?)/i);
    const fromVal = parseMoney(fromMatch?.[1]);
    const toVal = parseMoney(toMatch?.[1]);
    if (fromVal) out.salaryMin = fromVal;
    if (toVal) out.salaryMax = toVal;
    else if (fromVal) out.salaryMax = fromVal;
  }

  return out;
}

/** Parse `<table class='tbl'>` into a plain {label: value} map. */
function extractSummaryTable($: cheerio.CheerioAPI): Record<string, string> {
  const out: Record<string, string> = {};
  $("table.tbl tr").each((_, tr) => {
    const tds = $(tr).find("td");
    for (let i = 0; i + 1 < tds.length; i += 2) {
      const rawLabel = $(tds[i]).text();
      const rawValue = $(tds[i + 1]).text();
      const label = rawLabel.replace(/[:\s]+$/g, "").trim();
      const value = rawValue.replace(/\s+/g, " ").trim();
      if (!label || !value) continue;
      if (/^redacted$/i.test(value)) continue;
      out[label] = value;
    }
  });
  return out;
}

/**
 * Extract labelled items from a specific infoList section, matched by
 * its h4 header text. Returns [{label, value}, ...] preserving document order.
 */
function extractSectionItems(
  $: cheerio.CheerioAPI,
  headerMatcher: RegExp,
): Array<{ label: string; value: string }> {
  const items: Array<{ label: string; value: string }> = [];
  $("div.infoList").each((_, il) => {
    const headerText = $(il).find("div.secHeader h4").first().text().trim();
    if (!headerMatcher.test(headerText)) return;
    $(il)
      .find("div.infoHolder")
      .each((_, ih) => {
        const label = $(ih).find("h5").first().text().replace(/\s+/g, " ").trim();
        // Value can be in a <p> or directly inside the div (Section E q1 "Yes")
        const pText = $(ih).find("p").first().text();
        const rawValue = (pText && pText.trim()) || $(ih).clone().find("h5").remove().end().text();
        const value = rawValue.replace(/\s+/g, " ").trim();
        if (!label) return;
        items.push({ label, value });
      });
  });
  return items;
}

function findItemValue(
  items: Array<{ label: string; value: string }>,
  labelMatcher: RegExp,
): string | null {
  const hit = items.find((it) => labelMatcher.test(it.label));
  if (!hit) return null;
  const v = hit.value.trim();
  if (!v) return null;
  if (/^redacted$/i.test(v)) return null;
  if (/^\s*##?\s*$/.test(v)) return null;
  return v;
}

function cleanPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  // Discard scientific-notation renderings
  if (/^\d+\.\d+e[+-]?\d+$/i.test(t)) return null;
  return t;
}

function parseMoney(s: string | null | undefined): number | null {
  if (!s) return null;
  const clean = s.replace(/[,$\s]/g, "");
  const n = Number(clean);
  return Number.isFinite(n) && n > 0 ? n : null;
}
