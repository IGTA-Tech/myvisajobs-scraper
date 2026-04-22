import * as cheerio from "cheerio";

export type MyVisaJobsListingItem = {
  lcaId: string;
  year: number;
  lcaUrl: string;
  jobTitle: string | null;
  employerSlug: string | null;
  employerName: string | null;
  location: string | null;
  occupation: string | null;
  lawFirm: string | null;
};

const BASE = "https://www.myvisajobs.com";

/**
 * Parse the myvisajobs H-1B listing page for a given company name.
 * URL pattern: /h1b/search.aspx?e={slug}&st=certified&y={year}
 *
 * Each listing card has:
 *   <h5><a href='/h1b-visa/lcafull.aspx?id=N&y=YYYY'>Job Title</a></h5>
 *   <p><a href='/employer/SLUG/' target='company'>Employer Name</a></p>
 *   <span class='light-green'>City, STATE</span>
 *   <span class='light-purple'>Status</span>
 *   <span class='light-blue'>Occupation</span>
 *   Law Firm: ...
 */
export function parseCompanyListing(html: string): MyVisaJobsListingItem[] {
  const $ = cheerio.load(html);
  const out: MyVisaJobsListingItem[] = [];
  const seen = new Set<string>();

  $(".job-listing-card").each((_, card) => {
    const $card = $(card);

    // Title + LCA link
    const $titleA = $card.find('a[href*="lcafull.aspx"]').first();
    const href = $titleA.attr("href") ?? "";
    const idMatch = href.match(/id=(\d+)/i);
    const yMatch = href.match(/[?&]y=(\d{4})/i);
    if (!idMatch) return;
    const lcaId = idMatch[1];
    if (seen.has(lcaId)) return;
    seen.add(lcaId);
    const year = yMatch ? Number(yMatch[1]) : new Date().getFullYear();
    const normHref = href.startsWith("http") ? href : `${BASE}${href}`;
    const jobTitle = text($titleA.text());

    // Employer link
    const $empA = $card.find('a[href*="/employer/"]').first();
    const empHref = $empA.attr("href") ?? "";
    const slugMatch = empHref.match(/\/employer\/([a-z0-9-]+)/i);
    const employerSlug = slugMatch ? slugMatch[1].toLowerCase() : null;
    const employerName = text($empA.text());

    // Location (light-green), status (light-purple), occupation (light-blue)
    const location = text($card.find("span.light-green").first().text());
    const occupation = text($card.find("span.light-blue").first().text());

    // Law firm — "Law Firm: Xxx" in the discription list
    let lawFirm: string | null = null;
    $card.find("li").each((_, li) => {
      const t = $(li).text().replace(/\s+/g, " ").trim();
      const m = t.match(/Law Firm:\s*(.+)$/i);
      if (m) lawFirm = m[1].trim();
    });

    out.push({
      lcaId,
      year,
      lcaUrl: normHref,
      jobTitle,
      employerSlug,
      employerName,
      location,
      occupation,
      lawFirm,
    });
  });

  return out;
}

function text(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length ? t : null;
}

/**
 * Build the myvisajobs search URL for a company name, certified jobs, given year.
 */
export function buildCompanySearchUrl(
  companyQuery: string,
  year: number = new Date().getFullYear(),
): string {
  return `${BASE}/h1b/search.aspx?e=${encodeURIComponent(companyQuery)}&st=certified&y=${year}`;
}
