import * as cheerio from "cheerio";
import { Talent } from "./schema.js";

/**
 * Parse a /candidate/{slug}-{id}/ profile page into structured Talent data.
 * Uses JSON-LD schema.org/Person for the fast path, body sections for the
 * fields not in JSON-LD (phone, email, experiences, education, sidebar).
 */
export function parseTalentProfile(
  html: string,
  url: string,
): Partial<Talent> {
  const $ = cheerio.load(html);

  const out: Partial<Talent> = { profileUrl: url };

  // Talent_ID and slug from URL
  const idMatch = url.match(/\/candidate\/[a-z0-9-]+-(\d+)\/?$/i);
  if (idMatch) out.talentId = idMatch[1];

  // --- JSON-LD fast path ---
  const jsonLdScript = $('script[type="application/ld+json"]').first().html();
  let jsonLd: Record<string, unknown> | null = null;
  try {
    if (jsonLdScript) jsonLd = JSON.parse(jsonLdScript);
  } catch {
    // ignore parse errors, fall back to body parsing
  }

  if (jsonLd) {
    out.fullName = strOrNull(jsonLd.name);
    out.lookingFor = strOrNull(jsonLd.jobTitle);
    const alumni = jsonLd.alumniOf as { name?: string } | undefined;
    out.mostRecentSchool = strOrNull(alumni?.name);
    const credential = jsonLd.hasCredential as { name?: string } | undefined;
    out.degree = strOrNull(credential?.name);
    const address = jsonLd.address as { addressCountry?: string; addressLocality?: string } | undefined;
    out.country = strOrNull(address?.addressCountry);
    out.city = strOrNull(address?.addressLocality);
    if (Array.isArray(jsonLd.skills)) out.skills = (jsonLd.skills as string[]).join(", ");
    if (Array.isArray(jsonLd.knowsLanguage)) out.languages = (jsonLd.knowsLanguage as string[]).join(", ");
  }

  // First / last name from "profile:first_name" / "profile:last_name" meta
  out.firstName =
    strOrNull($('meta[property="profile:first_name"]').attr("content")) ?? splitFullName(out.fullName).first;
  out.lastName =
    strOrNull($('meta[property="profile:last_name"]').attr("content")) ?? splitFullName(out.fullName).last;

  // --- Body parsing for fields not in JSON-LD ---
  const pageText = $("body").text().replace(/\s+/g, " ").trim();

  // Phone, Email — appear in the top profile block as "Phone: ..." and "Email: ..."
  // Multiple places: top of profile + sidebar "More About". Either has the same value.
  out.phone = pickAfter(pageText, /Phone:\s*([^\s|<]+(?:\s*[^\s|<]+)?)/i, 50);
  out.email = pickAfter(pageText, /Email:\s*([^\s|<]+@[^\s|<]+)/i, 80);

  // Looking For (target roles) — labeled bullet
  if (!out.lookingFor) out.lookingFor = pickAfter(pageText, /Looking\s*For:\s*([^\.\n]+?)(?=\s+Occupation:|$)/i, 200);

  // Occupation category, Career Level, Languages, Degree (fallbacks)
  out.occupationCategory = pickAfter(pageText, /Occupation:\s*([^\n\.]+?)(?=\s+Degree:|$)/i, 100);
  out.careerLevel = pickAfter(pageText, /Career\s*Level:\s*([^\n]+?)(?=\s+Languages:|$)/i, 200);
  if (!out.degree) out.degree = pickAfter(pageText, /Degree:\s*([^\n]+?)(?=\s+Career\s*Level:|$)/i, 80);
  if (!out.languages) out.languages = pickAfter(pageText, /Languages:\s*([^\n]+?)(?=\s+You must|$)/i, 200);

  // Career Information section: Goal, Skills, Certifications, Honors
  const careerSpan = $("#ctl00_ContentPlaceHolder1_lblCareer").text().replace(/\s+/g, " ").trim();
  if (careerSpan) {
    if (!out.skills) out.skills = pickAfter(careerSpan, /Skills:\s*([^\n]+?)(?=\s*Goal:|\s*Certification:|\s*Honor:|$)/i, 600);
    out.goal = pickAfter(careerSpan, /Goal:\s*(.+?)(?=\s*Certification:|\s*Honor:|$)/i, 2000);
    out.certifications = pickAfter(careerSpan, /Certification:\s*(.+?)(?=\s*Honor:|$)/i, 1000);
    out.honors = pickAfter(careerSpan, /Honor:\s*(.+?)$/i, 1000);
  }

  // Experiences full text (preserve as-is for outreach context)
  const experienceHtml = $("#ctl00_ContentPlaceHolder1_lblExperience").html() ?? "";
  out.experiencesFull = htmlToText(experienceHtml);

  // Most-recent (first) experience parsed for current_company / current_title
  const firstExp = parseFirstExperience(experienceHtml);
  out.currentTitle = firstExp.title;
  out.currentCompany = firstExp.company;
  out.yearsExperience = countExperienceYears(experienceHtml);

  // Education full text + most-recent major fallback
  const educationHtml = $("#ctl00_ContentPlaceHolder1_lblEducation").html() ?? "";
  out.educationFull = htmlToText(educationHtml);
  if (!out.mostRecentMajor) {
    const majorMatch = educationHtml.match(/Major:\s*([^<\n]+?)(?=<|\n|$)/i);
    if (majorMatch) out.mostRecentMajor = majorMatch[1].trim();
  }

  // Resume URL
  const resumeHref = $("#ctl00_ContentPlaceHolder1_lblResume a").first().attr("href");
  if (resumeHref) {
    out.resumeUrl = resumeHref.startsWith("http") ? resumeHref : `https://www.myvisajobs.com${resumeHref}`;
  }

  // Sidebar: "More About" — Visa, Work Authorization, Expected Salary, Target Locations, Interests
  const moreSpan = $("#ctl00_ContentPlaceHolder1_lblMore").text().replace(/\s+/g, " ").trim();
  if (moreSpan) {
    out.visaStatus = pickAfter(moreSpan, /Visa:\s*([^\n]*?)(?=\s+Work\s*Authorization:|$)/i, 200);
    out.workAuthorization = pickAfter(moreSpan, /Work\s*Authorization:\s*([^\n]+?)(?=\s+Expected\s*Salary:|$)/i, 100);
    out.expectedSalary = pickAfter(moreSpan, /Expected\s*Salary:\s*([^\n]+?)(?=\s+Target\s*Locations:|$)/i, 100);
    out.targetUsLocations = pickAfter(moreSpan, /Target\s*Locations:\s*([^\n]+?)(?=\s+Intests|\s+Interests|$)/i, 400);
    out.interestsHobbies = pickAfter(moreSpan, /(?:Intests|Interests)\s*(?:&|and)?\s*Hobbies:\s*(.+?)$/i, 400);
  }

  // Contact-Candidate URL (premium feature)
  const contactBtn = $('a[href*="/cv/contactcandidate.aspx"]').first().attr("href");
  if (contactBtn) {
    out.contactCandidateUrl = contactBtn.startsWith("http")
      ? contactBtn
      : `https://www.myvisajobs.com${contactBtn}`;
  }

  return out;
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function strOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function splitFullName(name: string | null | undefined): { first: string | null; last: string | null } {
  if (!name) return { first: null, last: null };
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

function pickAfter(text: string, re: RegExp, maxLen: number): string | null {
  const m = text.match(re);
  if (!m) return null;
  const v = m[1].trim();
  if (!v || v.length < 1) return null;
  return v.slice(0, maxLen);
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|span|hr|b|strong|i|em|ul|ol|li)[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Most experiences are formatted as:
 *   <p><b>Title</b>   MM/YYYY -  current <br/>Company, City, Country<br>...
 * The first <b> in lblExperience is the most recent title.
 */
function parseFirstExperience(html: string): { title: string | null; company: string | null } {
  if (!html) return { title: null, company: null };
  const titleMatch = html.match(/<b>([^<]+)<\/b>/i);
  const title = titleMatch?.[1]?.trim() ?? null;
  // Company appears after the date range, on the next line break
  // e.g. "<b>Data Scientist</b>   02/2024 -  current <br/>Nybl.ai, Doha, Qatar<br>"
  const afterDate = html.match(/<b>[^<]+<\/b>[^<]*<br\s*\/?>([^<]+)</i);
  const companyRaw = afterDate?.[1]?.trim();
  const company = companyRaw ? companyRaw.split(",")[0].trim() : null;
  return { title, company: company || null };
}

/**
 * Rough count of experience entries for years-of-experience proxy.
 * Each experience starts with `<b>...</b>` so count those.
 */
function countExperienceYears(html: string): string | null {
  if (!html) return null;
  const matches = html.match(/<b>[^<]+<\/b>/gi);
  if (!matches || matches.length === 0) return null;
  // Crude: assume ~2 years per role on average — used for filter buckets, not display
  return `${matches.length} roles listed`;
}
