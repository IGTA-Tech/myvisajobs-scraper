import Anthropic from "@anthropic-ai/sdk";
import { CONFIG } from "./config.js";
import {
  EmployerData,
  EmployerDataSchema,
  Enrichment,
  EnrichmentSchema,
} from "./schema.js";
import { extractWithOpenAI, enrichWithOpenAI } from "./openai.js";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    client = new Anthropic({ apiKey });
  }
  return client;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractJson(content: string): string {
  let c = content.trim();
  if (c.startsWith("```")) {
    c = c.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  }
  const first = c.indexOf("{");
  const last = c.lastIndexOf("}");
  if (first >= 0 && last > first) return c.slice(first, last + 1);
  return c;
}

const EXTRACT_SYSTEM = `You extract employer visa sponsorship data from MyVisaJobs pages. Return ONLY a JSON object. No markdown, no commentary.`;

function extractPrompt(cleanedText: string, url: string): string {
  return `Extract employer data from this MyVisaJobs page text. URL: ${url}

Return a JSON object with these exact keys (use null for missing values, NOT strings):

{
  "companyName": string,
  "myVisaJobsUrl": "${url}",
  "verificationStatus": "Verified" | "Not Verified" | null,
  "visaRank": number | null,
  "totalH1BLCAs3yr": number | null,
  "totalGCLCs3yr": number | null,
  "totalDeniedWithdrawn3yr": number | null,
  "mainOfficeAddress": string | null,
  "mainOfficeCity": string | null,
  "mainOfficeState": string | null,
  "mainOfficeZip": string | null,
  "foundedYear": number | null,
  "numberOfEmployees": number | null,
  "naicsIndustry": string | null,
  "h1bDependent": "Yes" | "No" | "Unknown" | null,
  "willfulViolator": "Yes" | "No" | "Unknown" | null,
  "h1bLCACurrent": number | null,
  "h1bLCALastYear": number | null,
  "h1bLCA2YearsAgo": number | null,
  "gcLCCurrent": number | null,
  "gcLCLastYear": number | null,
  "gcLC2YearsAgo": number | null,
  "avgH1BSalaryCurrent": number | null,
  "avgGCSalaryCurrent": number | null,
  "topSponsoredRole1": string | null,
  "topSponsoredRole1Count": number | null,
  "topSponsoredRole2": string | null,
  "topSponsoredRole2Count": number | null,
  "topSponsoredRole3": string | null,
  "topSponsoredRole3Count": number | null,
  "otherSponsoredRoles": string | null,
  "topWorkerCountries": string | null,
  "contacts": [{"name": string|null, "title": string|null, "email": string|null, "phone": string|null, "type": "H1B"|"Green Card"|null}],
  "topH1BWorkSites": string | null,
  "topGCWorkSites": string | null,
  "reviewCount": number | null,
  "averageReviewScore": number | null,
  "positiveReviewKeywords": string | null,
  "negativeReviewKeywords": string | null
}

CRITICAL: Extract EVERY unique email from contacts sections (both H-1B and Green Card). Each unique email = one contact. Max 10 contacts.

PAGE TEXT:
${cleanedText.slice(0, 40000)}

Return ONLY the JSON object.`;
}

async function callClaude(
  model: string,
  system: string,
  userContent: string,
  maxTokens: number,
): Promise<string> {
  const res = await getClient().messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userContent }],
  });
  const block = res.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("No text response from Claude");
  return block.text;
}

/**
 * Tier 3/4 extraction fallback. Tries Haiku first, then Sonnet.
 * Returns validated EmployerData or throws.
 */
export async function extractWithAI(
  html: string,
  url: string,
): Promise<{ data: EmployerData; tier: "haiku" | "sonnet" | "openai" }> {
  const cleaned = stripHtml(html);
  const prompt = extractPrompt(cleaned, url);

  // Tier 3 — Haiku
  try {
    const raw = await callClaude(CONFIG.HAIKU_MODEL, EXTRACT_SYSTEM, prompt, 4000);
    const parsed = JSON.parse(extractJson(raw));
    const validated = EmployerDataSchema.safeParse(parsed);
    if (validated.success) return { data: validated.data, tier: "haiku" };
  } catch {
    // fall through to Sonnet
  }

  // Tier 4 — Sonnet
  try {
    const raw = await callClaude(CONFIG.SONNET_MODEL, EXTRACT_SYSTEM, prompt, 4000);
    const parsed = JSON.parse(extractJson(raw));
    const validated = EmployerDataSchema.safeParse(parsed);
    if (validated.success) return { data: validated.data, tier: "sonnet" };
  } catch {
    // fall through to OpenAI
  }

  // Tier 5 — OpenAI (cross-provider final fallback — billing/outage safety net)
  const data = await extractWithOpenAI(html, url);
  return { data, tier: "openai" };
}

const ENRICH_SYSTEM = `You are an expert in visa sponsorship and employer analysis. Return ONLY a JSON object.`;

function enrichmentPrompt(data: EmployerData): string {
  return `Analyze this employer and return enrichment JSON.

EMPLOYER DATA:
${JSON.stringify(data, null, 2)}

Return ONLY this JSON structure:

{
  "industryCategory": "Tech|Finance|Healthcare|Consulting|etc",
  "companySizeEstimate": string,
  "sponsorO1Visas": "Yes|No|Likely|Unknown",
  "sponsorshipTrend": "Increasing|Stable|Decreasing|New",
  "h1bApprovalRateCurrent": number|null,
  "h1bApprovalRateHistorical": number|null,
  "aiEmployerScore": number (0-100),
  "sponsorshipLikelihood": "Hot|Warm|Cold",
  "targetPriority": "A|B|C|D",
  "bestVisaTypes": "H1B,O1,EB1A,L1",
  "candidateMatchPotential": "High|Medium|Low",
  "partnershipOpportunity": "Direct Hiring|Petitioner Service|Education|None",
  "decisionMakerAccessibility": "Easy|Medium|Hard",
  "aiEvaluationNotes": "2-3 sentence insight"
}

SCORING:
- Rank 1-100 = 90-100, 101-500 = 70-89, 501-1000 = 50-69, 1000+ = 30-49
- Bonuses for: volume, approval rate, increasing trend, high salary, multiple contacts

PRIORITY:
- A: score 70+, rank <500, Hot
- B: score 50-69, rank 500-1000, Warm
- C: score 30-49, rank 1000-2000, Cold
- D: score <30, rank 2000+`;
}

/**
 * Enrichment with Haiku -> Sonnet fallback. If both fail, returns empty enrichment.
 */
// -----------------------------------------------------------------------------
// Job-description structured extraction (Outreach pipeline)
// -----------------------------------------------------------------------------

export type JobDescriptionExtraction = {
  location: string | null;
  remoteFlag: string | null;
  workType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryPeriod: string | null;
  experienceLevel: string | null;
  descriptionSummary: string | null;
  responsibilities: string | null;
  qualifications: string | null;
  requiredSkills: string | null;
  preferredSkills: string | null;
  education: string | null;
  yearsExperience: string | null;
  benefits: string | null;
  visaSponsorship: string | null;
  postedDate: string | null;
  applicationUrl: string | null;
  aiSummary: string | null;
};

const JOB_SYSTEM = `You extract structured job-posting data from scraped page markdown. Preserve actual language from the source — do not invent. Return ONLY valid JSON, no commentary.`;

/**
 * Extract structured job fields from scraped markdown. The Description_Full
 * column on the sheet stores the raw markdown; this function pulls out
 * targeted structured fields.
 *
 * sourceUrl is passed so Claude can derive a sensible applicationUrl default.
 */
export async function extractJobDescriptionStructured(
  markdown: string,
  ctx: { employerName: string; jobTitle: string; sourceUrl: string },
): Promise<JobDescriptionExtraction> {
  const trimmed = markdown.slice(0, 40000);
  const prompt = `Extract job data from this scraped page.

Employer: ${ctx.employerName}
Job title (from myvisajobs): ${ctx.jobTitle}
Source URL: ${ctx.sourceUrl}

Return ONLY this JSON. Use null when unknown — never fabricate.

{
  "location": string|null,                    // city/state from posting; "Remote" if fully remote
  "remoteFlag": "Yes"|"No"|"Hybrid"|"Unknown",
  "workType": "Full-time"|"Part-time"|"Contract"|"Internship"|"Temporary"|null,
  "salaryMin": number|null,                   // annual $ (or whatever salaryPeriod is) minimum
  "salaryMax": number|null,
  "salaryPeriod": "Annual"|"Hourly"|"Monthly"|null,
  "experienceLevel": "Entry"|"Mid"|"Senior"|"Lead"|"Executive"|null,
  "descriptionSummary": string|null,          // 3-5 sentence summary of the role
  "responsibilities": string|null,            // bullet list joined with "\\n- "
  "qualifications": string|null,              // required qualifications, same format
  "requiredSkills": string|null,              // comma-separated
  "preferredSkills": string|null,             // comma-separated
  "education": string|null,                   // e.g. "Bachelor's in Computer Science or related field"
  "yearsExperience": string|null,             // e.g. "5+ years" or "3-5 years"
  "benefits": string|null,                    // bullets joined with "\\n- "
  "visaSponsorship": "Yes"|"No"|"Mentioned"|"Unknown",  // any H-1B/visa sponsor language?
  "postedDate": string|null,                  // ISO date if visible, else null
  "applicationUrl": string|null,              // direct "apply" link if different from sourceUrl
  "aiSummary": string|null                    // 2-sentence pitch for a recruiter's outreach email
}

PAGE MARKDOWN:
${trimmed}`;

  const raw = await callClaude(CONFIG.HAIKU_MODEL, JOB_SYSTEM, prompt, 2500);
  const parsed = JSON.parse(extractJson(raw));

  // Normalize: ensure numeric salaries, string-or-null for others.
  const num = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    if (typeof v === "string") {
      const n = Number(v.replace(/[^\d.]/g, ""));
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  };
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;

  return {
    location: str(parsed.location),
    remoteFlag: str(parsed.remoteFlag),
    workType: str(parsed.workType),
    salaryMin: num(parsed.salaryMin),
    salaryMax: num(parsed.salaryMax),
    salaryPeriod: str(parsed.salaryPeriod),
    experienceLevel: str(parsed.experienceLevel),
    descriptionSummary: str(parsed.descriptionSummary),
    responsibilities: str(parsed.responsibilities),
    qualifications: str(parsed.qualifications),
    requiredSkills: str(parsed.requiredSkills),
    preferredSkills: str(parsed.preferredSkills),
    education: str(parsed.education),
    yearsExperience: str(parsed.yearsExperience),
    benefits: str(parsed.benefits),
    visaSponsorship: str(parsed.visaSponsorship),
    postedDate: str(parsed.postedDate),
    applicationUrl: str(parsed.applicationUrl),
    aiSummary: str(parsed.aiSummary),
  };
}

/**
 * Score 0-1 based on field completeness — used for Quality_Score column
 * and to decide whether to retry with a different source URL.
 */
export function jobExtractionQuality(
  ext: JobDescriptionExtraction,
  descriptionFullLength: number,
): number {
  let score = 0;
  let max = 0;
  const present = (v: unknown): number => (v ? 1 : 0);

  max += 3; score += descriptionFullLength >= 2000 ? 3 : descriptionFullLength >= 500 ? 2 : descriptionFullLength >= 200 ? 1 : 0;
  max += 1; score += present(ext.descriptionSummary);
  max += 2; score += present(ext.responsibilities) * 2;
  max += 2; score += present(ext.qualifications) * 2;
  max += 1; score += present(ext.requiredSkills);
  max += 1; score += present(ext.location);
  max += 1; score += present(ext.education);
  max += 1; score += ext.salaryMin || ext.salaryMax ? 1 : 0;

  return Number((score / max).toFixed(2));
}

// -----------------------------------------------------------------------------
// Talent enrichment — short outreach pitch + 0-100 fit score
// -----------------------------------------------------------------------------

const TALENT_SYSTEM = `You are an immigration sponsorship consultant. Return ONLY a JSON object — no commentary.`;

export type TalentEnrichment = { aiSummary: string | null; aiScore: number | null };

export async function enrichTalentWithAI(data: {
  fullName?: string | null;
  lookingFor?: string | null;
  occupationCategory?: string | null;
  careerLevel?: string | null;
  degree?: string | null;
  mostRecentSchool?: string | null;
  mostRecentMajor?: string | null;
  skills?: string | null;
  country?: string | null;
  city?: string | null;
  visaStatus?: string | null;
  workAuthorization?: string | null;
  expectedSalary?: string | null;
  targetUsLocations?: string | null;
  yearsExperience?: string | null;
  currentCompany?: string | null;
  currentTitle?: string | null;
  goal?: string | null;
  certifications?: string | null;
  honors?: string | null;
  experiencesFull?: string | null;
  educationFull?: string | null;
}): Promise<TalentEnrichment> {
  const prompt = `Score this talent for US H-1B sponsorship outreach (0-100) and write a 2-3 sentence pitch a recruiter could paste into a cold email.

TALENT DATA:
${JSON.stringify(data, null, 2)}

Score weights:
- 0-30: graduate degree from a known university
- 0-25: relevant CS/AI/ML/Data skills
- 0-20: relevant experience (years + company quality)
- 0-15: already in US or work-authorized
- 0-10: visa status clarity (open to sponsorship)

Return ONLY:
{"aiSummary": string, "aiScore": number 0-100}`;

  const callOnce = async (model: string, useOpenAI = false): Promise<TalentEnrichment> => {
    if (useOpenAI) {
      // Lazy import to avoid circular dep
      const openai = await import("./openai.js").then((m) => m).catch(() => null);
      if (!openai) throw new Error("OpenAI fallback unavailable");
      // Minimal one-off call using OpenAI client setup
      const OpenAI = (await import("openai")).default;
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY not set");
      const client = new OpenAI({ apiKey });
      const res = await client.chat.completions.create({
        model: CONFIG.OPENAI_MODEL,
        temperature: 0.2,
        max_tokens: 800,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: TALENT_SYSTEM },
          { role: "user", content: prompt },
        ],
      });
      const content = res.choices[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(content);
      return normalize(parsed);
    }
    const raw = await callClaude(model, TALENT_SYSTEM, prompt, 800);
    const parsed = JSON.parse(extractJson(raw));
    return normalize(parsed);
  };

  // Tier 1: Haiku
  try {
    return await callOnce(CONFIG.HAIKU_MODEL);
  } catch {
    // Tier 2: Sonnet
    try {
      return await callOnce(CONFIG.SONNET_MODEL);
    } catch {
      // Tier 3: OpenAI
      try {
        return await callOnce(CONFIG.OPENAI_MODEL, true);
      } catch {
        // Tier 4: rule-based deterministic fallback so the pipeline never blocks
        return ruleBasedTalentScore(data);
      }
    }
  }
}

function normalize(parsed: unknown): TalentEnrichment {
  const obj = parsed as { aiSummary?: unknown; aiScore?: unknown };
  const summary = typeof obj.aiSummary === "string" && obj.aiSummary.trim() ? obj.aiSummary.trim() : null;
  let score: number | null = null;
  if (typeof obj.aiScore === "number" && Number.isFinite(obj.aiScore)) score = Math.max(0, Math.min(100, Math.round(obj.aiScore)));
  return { aiSummary: summary, aiScore: score };
}

/**
 * Deterministic last-resort scorer when all AI providers fail. Ensures the
 * pipeline keeps moving and the row gets a Quality_Score-like signal.
 */
function ruleBasedTalentScore(d: {
  degree?: string | null;
  skills?: string | null;
  yearsExperience?: string | null;
  workAuthorization?: string | null;
  country?: string | null;
}): TalentEnrichment {
  let score = 30; // base
  if (d.degree) {
    if (/master|m\.?s\.?|m\.?eng\.?|phd|doctorate/i.test(d.degree)) score += 25;
    else if (/bachelor|b\.?s\.?|b\.?a\.?|b\.?e\.?/i.test(d.degree)) score += 15;
  }
  if (d.skills) {
    const len = d.skills.length;
    score += Math.min(20, Math.floor(len / 30));
  }
  if (d.yearsExperience) {
    const m = d.yearsExperience.match(/(\d+)\s*role/);
    if (m) score += Math.min(15, Number(m[1]) * 3);
  }
  if (d.workAuthorization && !/none/i.test(d.workAuthorization)) score += 10;
  if (d.country && /united states|usa|us\b/i.test(d.country)) score += 10;
  return {
    aiSummary: "AI scoring unavailable; rule-based fallback applied. Review profile manually before outreach.",
    aiScore: Math.max(0, Math.min(100, score)),
  };
}

export async function enrichWithAI(data: EmployerData): Promise<Enrichment> {
  const prompt = enrichmentPrompt(data);

  try {
    const raw = await callClaude(CONFIG.HAIKU_MODEL, ENRICH_SYSTEM, prompt, 1500);
    const parsed = JSON.parse(extractJson(raw));
    return EnrichmentSchema.parse(parsed);
  } catch {
    try {
      const raw = await callClaude(CONFIG.SONNET_MODEL, ENRICH_SYSTEM, prompt, 1500);
      const parsed = JSON.parse(extractJson(raw));
      return EnrichmentSchema.parse(parsed);
    } catch {
      // Cross-provider final fallback — OpenAI
      try {
        return await enrichWithOpenAI(data);
      } catch {
        return EnrichmentSchema.parse({});
      }
    }
  }
}
