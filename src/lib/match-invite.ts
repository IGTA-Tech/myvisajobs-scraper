import * as cheerio from "cheerio";

/**
 * Parse the result table of a Match and Invite response page.
 * Each candidate row has an <a href="/candidate/{slug}-{id}/">.
 *
 * NOTE: discover-talents drives the search via Playwright now (see
 * `talent-discovery-browser.ts`). The fetch/POST flow that previously
 * lived here was retired because the ASP.NET form's VIEWSTATE +
 * cascading-postback behavior could not be reliably replayed server-side.
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
 * Free-text keyword sets layered on top of each career SOC. Combined with
 * 11 careers gives 110 (career × keyword) discovery cells; the cron rotates
 * through them to keep surfacing fresh candidates.
 */
export const TALENT_KEYWORD_SETS: Array<{ tag: string; keywords: string }> = [
  { tag: "ai-ml-cs", keywords: "EAL, qualified AI/ML/Data Science/Computer Science professionals" },
  { tag: "data-eng", keywords: "Data Engineer, ETL, Data Pipelines, Big Data, Spark" },
  { tag: "software-eng", keywords: "Software Engineer, Backend, Frontend, Full Stack" },
  { tag: "ml-research", keywords: "Machine Learning Researcher, Deep Learning, NLP, Computer Vision" },
  { tag: "cloud-devops", keywords: "Cloud Engineer, DevOps, Kubernetes, AWS, Azure, GCP" },
  { tag: "ai-llm", keywords: "LLM, Large Language Model, GPT, Transformer, Generative AI, RAG" },
  { tag: "ai-vision", keywords: "Computer Vision, OpenCV, Image Recognition, CNN, Object Detection" },
  { tag: "mobile-eng", keywords: "Mobile Engineer, iOS, Android, Swift, Kotlin, React Native" },
  { tag: "security-eng", keywords: "Security Engineer, Cybersecurity, SOC Analyst, Penetration Testing" },
  { tag: "data-science", keywords: "Data Scientist, Statistics, R, Python, SQL, Tableau, Business Intelligence" },
];
