import { CONFIG } from "./config.js";

export type SerperOrganicResult = {
  title: string;
  link: string;
  snippet?: string;
  position?: number;
  date?: string;
};

/**
 * Query Serper and return organic results in order.
 * Use num to cap — we rarely need more than 10.
 */
export async function serperSearch(
  query: string,
  num = 10,
): Promise<SerperOrganicResult[]> {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error("SERPER_API_KEY is not set");

  const res = await fetch(CONFIG.SERPER_ENDPOINT, {
    method: "POST",
    headers: {
      "X-API-KEY": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, num }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Serper ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as { organic?: SerperOrganicResult[] };
  return data.organic ?? [];
}

// -----------------------------------------------------------------------------
// URL ranking — prefer high-signal job sources over low-signal aggregators.
// -----------------------------------------------------------------------------

type SourceType = "careers" | "ats" | "linkedin" | "indeed" | "aggregator" | "other";

const ATS_DOMAINS = [
  "greenhouse.io",
  "lever.co",
  "workday.com",
  "ashbyhq.com",
  "smartrecruiters.com",
  "bamboohr.com",
  "recruitee.com",
  "breezy.hr",
  "jobvite.com",
  "icims.com",
  "myworkdayjobs.com",
  "workable.com",
  "dover.com",
];

const AGGREGATOR_DOMAINS = [
  "ziprecruiter.com",
  "simplyhired.com",
  "monster.com",
  "glassdoor.com",
  "dice.com",
  "careerbuilder.com",
  "joblist.com",
  "jobs2careers.com",
  "talent.com",
  "jora.com",
];

const JUNK_URL_PATTERNS = [
  /\.(pdf|zip|doc|docx|jpg|jpeg|png|gif|svg|webp|ico|mp4|webm)(\?|$)/i,
  /\/wp-admin\//i,
  /\/wp-login/i,
  /\/cart\b/i,
  /\/checkout\b/i,
  /\/login\b/i,
  /\/signin\b/i,
  /\/signup\b/i,
  /\/register\b/i,
  /\/privacy\b/i,
  /\/terms\b/i,
  /\/cookie-policy\b/i,
];

export function classifySource(url: string, companyName?: string): SourceType {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "other";
  }

  // LinkedIn is tricky — JS-walled. Keep but deprioritize.
  if (host.endsWith("linkedin.com")) return "linkedin";
  if (host.endsWith("indeed.com")) return "indeed";

  if (AGGREGATOR_DOMAINS.some((d) => host === d || host.endsWith("." + d))) {
    return "aggregator";
  }
  if (ATS_DOMAINS.some((d) => host === d || host.endsWith("." + d))) {
    return "ats";
  }

  // Careers page heuristic — host or path contains "career"/"jobs" and it's not
  // a known aggregator, plus it vaguely resembles the company if name given.
  const looksLikeCareers =
    /careers?\./i.test(host) ||
    /\/careers?\//i.test(url) ||
    /\/jobs?\//i.test(url) ||
    /\/positions?\//i.test(url);

  if (looksLikeCareers) {
    if (!companyName) return "careers";
    const slug = companyName.toLowerCase().replace(/[^a-z0-9]/g, "");
    const hostBase = host.replace(/^www\./, "").split(".")[0]?.replace(/-/g, "") ?? "";
    if (hostBase && (slug.includes(hostBase) || hostBase.includes(slug.slice(0, 6)))) {
      return "careers";
    }
    return "careers"; // generic careers page — still better than aggregator
  }

  return "other";
}

const SOURCE_PRIORITY: Record<SourceType, number> = {
  careers: 1,
  ats: 2,
  linkedin: 3,
  other: 4,
  indeed: 5,
  aggregator: 6,
};

export function rankResults(
  results: SerperOrganicResult[],
  companyName: string,
): SerperOrganicResult[] {
  return results
    .filter((r) => r.link && !JUNK_URL_PATTERNS.some((p) => p.test(r.link)))
    .map((r, i) => ({
      r,
      type: classifySource(r.link, companyName),
      originalPosition: i,
    }))
    .sort((a, b) => {
      const pa = SOURCE_PRIORITY[a.type];
      const pb = SOURCE_PRIORITY[b.type];
      if (pa !== pb) return pa - pb;
      return a.originalPosition - b.originalPosition;
    })
    .map((x) => x.r);
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}
