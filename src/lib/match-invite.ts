import * as cheerio from "cheerio";
import { fetchTalentPage, postTalentForm, ensureTalentAuthenticated } from "./talent-fetcher.js";

const MATCH_INVITE_URL = "https://www.myvisajobs.com/emp/hiring/match.aspx";

/**
 * ASP.NET Web Forms hidden state pulled from the GET response and required
 * on every POST.
 */
export type MatchInviteFormState = {
  viewState: string;
  viewStateGenerator: string;
  eventValidation: string;
};

export async function fetchMatchInviteFormState(): Promise<MatchInviteFormState> {
  const html = await fetchTalentPage(MATCH_INVITE_URL);
  ensureTalentAuthenticated(html);

  const $ = cheerio.load(html);
  const get = (id: string) => $(`#${id}`).attr("value") ?? "";
  return {
    viewState: get("__VIEWSTATE"),
    viewStateGenerator: get("__VIEWSTATEGENERATOR"),
    eventValidation: get("__EVENTVALIDATION"),
  };
}

export type MatchInviteSearch = {
  keywords: string;
  /** Occupation code (top-level), e.g., "15-1000" for Computer specialists / IT and Math. */
  occupation: string;
  /** Suboccupation code, e.g., "15-1000" for Computer specialists. */
  suboccupation: string;
  /** Career code, e.g., "15-1133" for Software Developers, Systems Software. */
  career: string;
};

/**
 * Run one Match and Invite search. POSTs the search form with VIEWSTATE
 * tokens, returns the response HTML.
 */
export async function searchMatchInvite(
  query: MatchInviteSearch,
  state?: MatchInviteFormState,
): Promise<string> {
  const formState = state ?? (await fetchMatchInviteFormState());

  const fields: Record<string, string> = {
    __EVENTTARGET: "",
    __EVENTARGUMENT: "",
    __VIEWSTATE: formState.viewState,
    __VIEWSTATEGENERATOR: formState.viewStateGenerator,
    __EVENTVALIDATION: formState.eventValidation,
    "ctl00$MainContent$txtInfo": query.keywords,
    "ctl00$MainContent$ddlOccupations": query.occupation,
    "ctl00$MainContent$ddlSubOccupations": query.suboccupation,
    "ctl00$MainContent$ddlCareer": query.career,
    "ctl00$MainContent$btnSearch": "Match",
  };

  const html = await postTalentForm(MATCH_INVITE_URL, fields);
  ensureTalentAuthenticated(html);
  return html;
}

/**
 * Parse the result table of a Match and Invite response.
 * Each row's first or second column has an <a href="/candidate/{slug}-{id}/">.
 */
export type MatchInviteResult = {
  talentId: string;
  profileUrl: string;
  lastName: string | null;
  degree: string | null;
  location: string | null;
  skills: string | null;
  score: number | null;
};

export function parseMatchInviteResults(html: string): MatchInviteResult[] {
  const $ = cheerio.load(html);
  const out: MatchInviteResult[] = [];
  const seen = new Set<string>();

  $('a[href*="/candidate/"]').each((_, a) => {
    const $a = $(a);
    const href = $a.attr("href") ?? "";
    const m = href.match(/\/candidate\/([a-z0-9-]+)-(\d+)\/?$/i);
    if (!m) return;
    const slug = m[1];
    const id = m[2];
    if (seen.has(id)) return;
    seen.add(id);

    const $row = $a.closest("tr");
    const cells = $row.find("td").map((_, td) => $(td).text().replace(/\s+/g, " ").trim()).get();

    const lastName = $a.text().trim() || null;
    // Result table column order: [photo, name, degree, location, skills, score]
    // Indexes can shift; pick by content heuristics.
    const degree = cells.find((c) => /degree/i.test(c)) ?? null;
    const location = cells.find((c) => /(United States|India|China|Pakistan|Nepal|UK|Bangladesh|Philippines|Spain|Albania|Thailand|Lebanon|Qatar)/i.test(c)) ?? null;
    const skills = cells.find((c) => c.includes(";") && c.length > 10) ?? null;
    const scoreCell = cells[cells.length - 1];
    const scoreNum = scoreCell ? Number(scoreCell.replace(/[^\d]/g, "")) : null;

    out.push({
      talentId: id,
      profileUrl: `https://www.myvisajobs.com/candidate/${slug}-${id}/`,
      lastName,
      degree,
      location,
      skills,
      score: Number.isFinite(scoreNum) && scoreNum != null ? scoreNum : null,
    });
  });

  return out;
}

/**
 * The eleven Computer-specialist career codes under "IT and Math" (15-1000).
 * Iterating these on every discovery run gets us broad coverage across
 * software/AI/data roles.
 */
export const COMPUTER_SPECIALIST_CAREERS: Array<{ code: string; label: string }> = [
  { code: "15-1111", label: "Computer and Information Research Scientists" },
  { code: "15-1121", label: "Computer Systems Analysts" },
  { code: "15-1131", label: "Computer Programmers" },
  { code: "15-1132", label: "Software Developers, Applications" },
  { code: "15-1133", label: "Software Developers, Systems Software" },
  { code: "15-1141", label: "Database Administrators" },
  { code: "15-1142", label: "Network and Computer Systems Administrators" },
  { code: "15-1143", label: "Computer Network Architects" },
  { code: "15-1151", label: "Computer User Support Specialists" },
  { code: "15-1152", label: "Computer Network Support Specialists" },
  { code: "15-1199", label: "Computer Occupations, All Other" },
];

/**
 * Keyword sets to rotate through. Each combined with all 11 career codes
 * yields ~25-50 results per search; total per discovery run after dedup
 * lands in the 800-1500 unique-talent range.
 */
export const TALENT_KEYWORD_SETS: Array<{ tag: string; keywords: string }> = [
  { tag: "ai-ml-cs", keywords: "EAL, qualified AI/ML/Data Science/Computer Science professionals" },
  { tag: "data-eng", keywords: "Data Engineer, ETL, Data Pipelines, Big Data, Spark" },
  { tag: "software-eng", keywords: "Software Engineer, Backend, Frontend, Full Stack" },
  { tag: "ml-research", keywords: "Machine Learning Researcher, Deep Learning, NLP, Computer Vision" },
  { tag: "cloud-devops", keywords: "Cloud Engineer, DevOps, Kubernetes, AWS, Azure, GCP" },
];
