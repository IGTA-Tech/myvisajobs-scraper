import * as cheerio from "cheerio";
import { EmployerData, EmployerDataSchema, Contact } from "./schema.js";

const num = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const cleaned = s.replace(/[,$\s]/g, "");
  const m = cleaned.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

const text = (s: string | null | undefined): string | null => {
  if (!s) return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length ? t : null;
};

const match = (src: string, re: RegExp): string | null => {
  const m = src.match(re);
  return m ? m[1].trim() : null;
};

/**
 * Parse a myvisajobs employer page HTML into EmployerData.
 * Returns a partial object — caller runs isParseHealthy() + Zod validation.
 */
export function parseEmployerHtml(html: string, url: string): Partial<EmployerData> {
  const $ = cheerio.load(html);

  const pageText = $("body").text().replace(/\s+/g, " ").trim();

  const out: Partial<EmployerData> = { myVisaJobsUrl: url };

  // Company name — usually h1 or the first heading after "Home > Employers >"
  out.companyName =
    text($("h1").first().text()) ??
    text($("h2").first().text()) ??
    match(pageText, /Home\s*>\s*Employers\s*>\s*([^|]+?)(?:\s*Visa Rank|\s*Not Verified|\s*Verified|$)/i) ??
    undefined;

  // Verification
  if (/Not Verified/i.test(pageText)) out.verificationStatus = "Not Verified";
  else if (/\bVerified\b/i.test(pageText)) out.verificationStatus = "Verified";

  // Visa rank / LCA / LC / denied — from the header line
  out.visaRank = num(match(pageText, /Visa Rank:\s*([\d,]+)/i));
  out.totalH1BLCAs3yr = num(match(pageText, /LCA for H-1B:\s*([\d,]+)/i));
  out.totalGCLCs3yr = num(match(pageText, /LC for Green Card:\s*([\d,]+)/i));
  out.totalDeniedWithdrawn3yr = num(match(pageText, /Denied or withdrawn:\s*([\d,]+)/i));

  // Company meta
  out.numberOfEmployees = num(match(pageText, /Number of Employees:\s*([\d,]+)/i));
  out.foundedYear = num(match(pageText, /Founded:\s*(\d{4})/i));
  out.mainOfficeAddress = text(match(pageText, /Main Office:\s*([^-]+?)(?:\s*-\s*NAICS|$)/i));
  out.naicsIndustry = text(match(pageText, /NAICS Industry:\s*([^-\n]+?)(?:\s*H-1B Dependent|$)/i));
  out.h1bDependent = text(match(pageText, /H-1B Dependent:\s*(Yes|No|Unknown)/i));
  out.willfulViolator = text(match(pageText, /Will?full? Violator:\s*(Yes|No|Unknown)/i));

  // Main office city/state/zip from address — and the "Main Office:" in Office Locations section
  const officeLine =
    match(pageText, /Main Office:\s*([^\n]+?)(?:H-1B Visa Job Work Sites|Green Card|$)/i) ||
    out.mainOfficeAddress ||
    "";
  const cityStateZip = officeLine.match(/([A-Za-z .]+),\s*([A-Za-z]{2})\s*(\d{4,5})?/);
  if (cityStateZip) {
    out.mainOfficeCity = text(cityStateZip[1]);
    out.mainOfficeState = text(cityStateZip[2]);
    out.mainOfficeZip = text(cityStateZip[3] ?? null);
  }

  // LCA tables — H-1B and GC
  const lcaYears = parseYearlyTable($, pageText, "Labor Condition Applications");
  out.h1bLCACurrent = lcaYears[0] ?? null;
  out.h1bLCALastYear = lcaYears[1] ?? null;
  out.h1bLCA2YearsAgo = lcaYears[2] ?? null;

  const gcYears = parseYearlyTable($, pageText, "Labor Certifications");
  out.gcLCCurrent = gcYears[0] ?? null;
  out.gcLCLastYear = gcYears[1] ?? null;
  out.gcLC2YearsAgo = gcYears[2] ?? null;

  // Salaries
  const salaryYears = parseSalaryTable($, pageText);
  if (salaryYears) {
    out.avgH1BSalaryCurrent = salaryYears.h1b;
    out.avgGCSalaryCurrent = salaryYears.gc;
  }

  // Occupations
  const roles = parseOccupations($, pageText);
  out.topSponsoredRole1 = roles[0]?.title ?? null;
  out.topSponsoredRole1Count = roles[0]?.count ?? null;
  out.topSponsoredRole2 = roles[1]?.title ?? null;
  out.topSponsoredRole2Count = roles[1]?.count ?? null;
  out.topSponsoredRole3 = roles[2]?.title ?? null;
  out.topSponsoredRole3Count = roles[2]?.count ?? null;
  out.otherSponsoredRoles = roles.slice(3).map((r) => `${r.title}(${r.count})`).join(", ") || null;

  // Top worker countries
  out.topWorkerCountries = parseCountries($, pageText);

  // Contacts — the whole point of the exercise
  out.contacts = parseContacts($);

  // Work sites
  out.topH1BWorkSites = parseWorkSites(pageText, "H-1B Visa Job Work Sites");
  out.topGCWorkSites = parseWorkSites(pageText, "Green Card Job Work Sites");

  // Reviews
  out.reviewCount = num(match(pageText, /Number of Reviews:\s*(\d+)/i));
  out.averageReviewScore = num(match(pageText, /Average Review Score:\s*([\d.]+)/i));
  out.positiveReviewKeywords = extractReviewKeywords(pageText, "like");
  out.negativeReviewKeywords = extractReviewKeywords(pageText, "don't like");

  return out;
}

function parseYearlyTable(
  $: cheerio.CheerioAPI,
  pageText: string,
  sectionLabel: string,
): number[] {
  // Look for "<YYYY> <certified> <denied> <withdrawn> <cert-withdrawn>" rows after the section label
  const idx = pageText.indexOf(sectionLabel);
  if (idx < 0) return [];
  const chunk = pageText.slice(idx, idx + 2000);
  const rows: Array<[number, number]> = [];
  const re = /(\d{4})\s+(\d+)\s+\d+\s+\d+\s+\d+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    rows.push([Number(m[1]), Number(m[2])]);
  }
  rows.sort((a, b) => b[0] - a[0]);
  return rows.map((r) => r[1]);
}

function parseSalaryTable(
  $: cheerio.CheerioAPI,
  pageText: string,
): { h1b: number | null; gc: number | null } | null {
  const idx = pageText.indexOf("Annual Average Salaries");
  if (idx < 0) return null;
  const chunk = pageText.slice(idx, idx + 2000);
  const re = /(\d{4})\s+\$?([\d,]+)\s+\$?([\d,]+)/;
  const m = chunk.match(re);
  if (!m) return null;
  return { h1b: num(m[2]), gc: num(m[3]) };
}

function parseOccupations(
  $: cheerio.CheerioAPI,
  pageText: string,
): Array<{ title: string; count: number }> {
  const idx = pageText.indexOf("H-1B Occupations");
  if (idx < 0) return [];
  const chunk = pageText.slice(idx, idx + 3000);
  const end = chunk.search(/\bContacts\b|\bread more\b/);
  const scoped = end > 0 ? chunk.slice(0, end) : chunk;
  const out: Array<{ title: string; count: number }> = [];
  const re = /([A-Z][A-Za-z0-9 ,.&/'-]+?)\((\d+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scoped)) !== null) {
    const title = m[1].trim().replace(/^[\s•,-]+/, "");
    if (title.length < 2 || title.length > 100) continue;
    out.push({ title, count: Number(m[2]) });
    if (out.length >= 12) break;
  }
  return out;
}

function parseCountries($: cheerio.CheerioAPI, pageText: string): string | null {
  const idx = pageText.search(/Citizenship:\s*where they came from/i);
  if (idx < 0) return null;
  const chunk = pageText.slice(idx, idx + 1500);
  const end = chunk.search(/read more|Visas\b/);
  const scoped = end > 0 ? chunk.slice(0, end) : chunk;
  const parts: string[] = [];
  const re = /([A-Z][A-Za-z ]+?)\((\d+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scoped)) !== null) {
    parts.push(`${m[1].trim()}(${m[2]})`);
    if (parts.length >= 12) break;
  }
  return parts.length ? parts.join(", ") : null;
}

/**
 * MyVisaJobs sometimes renders phone numbers as ASP.NET float strings like
 * "1.73268e+010" — which is precision-lossy garbage. Strip these entirely.
 * Real phones are strings with dashes, spaces, parens, or a leading +.
 */
function cleanPhone(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  // Scientific notation pattern — cannot be recovered, discard.
  if (/^\d+\.\d+e[+-]?\d+$/i.test(t)) return null;
  return t;
}

function parseContacts($: cheerio.CheerioAPI): Contact[] {
  const contacts: Contact[] = [];
  const emailRe = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
  const PREMIUM = "Premium Member Only";

  // Each <div class="job-location"> holds one contact group (H-1B or Green Card)
  // with an <h3> label and a <div class="contact-list"> containing .contact-card elements.
  $(".job-location").each((_, group) => {
    const $group = $(group);
    const heading = $group.find("h3").first().text().trim();
    let type: string | null = null;
    if (/Green Card/i.test(heading)) type = "Green Card";
    else if (/H-?1B/i.test(heading)) type = "H1B";
    else return; // not a contact group — probably an office location block

    $group.find(".contact-card").each((_, card) => {
      if (contacts.length >= 10) return false;
      const $card = $(card);

      // Name + title from .contact-summary
      const $summary = $card.find(".contact-summary").first();
      const name = text($summary.find("strong").first().text()) ?? null;
      const summaryText = $summary.text().replace(/\s+/g, " ").trim();
      let title: string | null = null;
      const dashIdx = summaryText.indexOf(" - ");
      if (name && dashIdx >= 0) {
        const after = summaryText.slice(dashIdx + 3).replace(/\[[-+]?\]/g, "").trim();
        if (after && !/^Premium/i.test(after)) title = after;
      }

      // Details: address, phone, email from .contact-details
      const $details = $card.find(".contact-details").first();
      const detailsText = $details.text().replace(/\s+/g, " ").trim();

      // Phone — capture after "Phone:" up to "Email:" or end
      let phone: string | null = null;
      const phoneMatch = detailsText.match(/Phone:\s*(.*?)(?:\s*Email:|$)/i);
      if (phoneMatch) {
        const raw = phoneMatch[1].trim();
        if (raw && !raw.includes(PREMIUM)) phone = raw;
      }

      // Email — prefer a real email in the details section
      let email: string | null = null;
      const emailMatch = detailsText.match(emailRe);
      if (emailMatch) email = emailMatch[0];
      else if (detailsText.includes(PREMIUM)) email = null;

      contacts.push({ name, title, email, phone: cleanPhone(phone), type });
    });
  });

  // Dedup: same email appearing twice (same person in H1B and GC sections).
  // Keep the entry with the most complete data (phone > no phone, title > no title).
  const byKey = new Map<string, Contact>();
  for (const c of contacts) {
    const key = (c.email || c.name || "").toLowerCase();
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, c);
      continue;
    }
    const score = (x: Contact) => (x.phone ? 2 : 0) + (x.title ? 1 : 0);
    if (score(c) > score(existing)) byKey.set(key, c);
  }
  return Array.from(byKey.values()).slice(0, 10);
}

function parseWorkSites(pageText: string, label: string): string | null {
  const idx = pageText.indexOf(label);
  if (idx < 0) return null;
  const chunk = pageText.slice(idx + label.length, idx + label.length + 1500);
  const end = chunk.search(
    /Green Card Job Work Sites|Prevailing Wage|H-1B Visa Petition|FAQs|Reviews/,
  );
  const scoped = end > 0 ? chunk.slice(0, end) : chunk;
  const parts: string[] = [];
  const re = /([A-Z][A-Za-z .]+?,\s*[A-Za-z]{2})\((\d+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scoped)) !== null) {
    parts.push(`${m[1].trim()}(${m[2]})`);
    if (parts.length >= 10) break;
  }
  return parts.length ? parts.join(", ") : null;
}

function extractReviewKeywords(pageText: string, kind: "like" | "don't like"): string | null {
  const label = kind === "like" ? "Things I like:" : "Things I don't like:";
  const themes = new Set<string>();
  const re = new RegExp(`${label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*([^\\n]+?)(?=\\n|Things|★|$)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(pageText)) !== null) {
    m[1].split(",").forEach((t) => themes.add(t.trim()));
    if (themes.size >= 20) break;
  }
  return themes.size ? Array.from(themes).slice(0, 10).join(", ") : null;
}

/**
 * Full parse with Zod validation. Returns null if the parse fails validation.
 */
export function parseAndValidate(html: string, url: string): EmployerData | null {
  const raw = parseEmployerHtml(html, url);
  const result = EmployerDataSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * Extract "Related & Recommended Employers" URLs from a scraped employer page.
 * These form the graph-traversal discovery source — each scraped employer
 * yields 10-15 related employer URLs to queue.
 */
export function extractRelatedEmployers(html: string, selfUrl: string): string[] {
  const $ = cheerio.load(html);
  const out = new Set<string>();
  const selfSlug = selfUrl.match(/\/employer\/([a-z0-9-]+)\/?$/i)?.[1]?.toLowerCase();

  $('a[href*="/employer/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const m = href.match(/^\/employer\/([a-z0-9-]+)\/?$/i);
    if (!m) return;
    const slug = m[1].toLowerCase();
    if (slug === selfSlug) return;
    out.add(`https://www.myvisajobs.com/employer/${slug}/`);
  });

  return Array.from(out);
}
