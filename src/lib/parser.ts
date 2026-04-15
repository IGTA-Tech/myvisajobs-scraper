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
  out.contacts = parseContacts($, pageText);

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

function parseContacts($: cheerio.CheerioAPI, pageText: string): Contact[] {
  const contacts: Contact[] = [];
  const seen = new Set<string>();

  // Primary approach: look for email addresses in the Contacts section and walk backwards
  const contactsIdx = pageText.search(/\bContacts\b/);
  if (contactsIdx < 0) return contacts;

  const officesIdx = pageText.search(/Office Locations/);
  const scope = pageText.slice(contactsIdx, officesIdx > contactsIdx ? officesIdx : contactsIdx + 5000);

  // Extract all emails in the contacts section
  const emailRe = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
  const emails = Array.from(new Set(scope.match(emailRe) ?? []));

  // For each email, try to find the nearest preceding name block
  const blocks = scope.split(/(?=[A-Z][a-z]+ [A-Z]\b|[A-Z][a-z]+ [A-Z][a-z]+)/);

  // Fallback: naive block-based parsing from cheerio structure
  // Look for patterns like "Name - Title" or "Name" followed by address/phone/email
  const blockRe =
    /([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})\s*(?:-\s*([^\n[]+?))?\s*(?:\[[-+]\])?\s*(?:([\d .,()\-x+]{7,30})\s*Phone:?\s*)?(?:Phone:\s*([^\n]+?))?\s*(?:Email:\s*([\w.+-]+@[\w.-]+))?/g;

  // Simpler approach: split scope on email occurrences and grab name before each
  const segments = scope.split(/Email:\s*/);
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1];
    const emailPart = segments[i];
    const email = emailPart.match(emailRe)?.[0];
    if (!email || seen.has(email)) continue;
    seen.add(email);

    // Walk back in prev to find name + title
    const tail = prev.slice(-500);
    const nameMatch = tail.match(
      /([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]*){1,3})\s*(?:-\s*([^\n[]+?))?\s*\[[-+]?\]/,
    );
    const phoneMatch = tail.match(/Phone:\s*([^\n]+?)(?:\s*Email|\s*$)/i);
    const titleLoose = tail.match(/([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]*){1,3})\s*-\s*([^[\n]+?)\s*\[/);

    contacts.push({
      name: nameMatch?.[1]?.trim() ?? titleLoose?.[1]?.trim() ?? null,
      title: nameMatch?.[2]?.trim() ?? titleLoose?.[2]?.trim() ?? null,
      email,
      phone: phoneMatch?.[1]?.trim() ?? null,
      type: /Green Card/i.test(prev.slice(-1500)) ? "Green Card" : "H1B",
    });

    if (contacts.length >= 10) break;
  }

  // If we got no contacts but found emails, return one per email with minimal info
  if (contacts.length === 0 && emails.length) {
    for (const email of emails.slice(0, 10)) {
      contacts.push({ name: null, title: null, email, phone: null, type: null });
    }
  }

  return contacts;
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
