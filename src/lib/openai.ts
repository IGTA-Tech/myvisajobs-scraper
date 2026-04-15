import OpenAI from "openai";
import { CONFIG } from "./config.js";
import {
  EmployerData,
  EmployerDataSchema,
  Enrichment,
  EnrichmentSchema,
} from "./schema.js";

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
    client = new OpenAI({ apiKey });
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

const EXTRACT_SYSTEM =
  "You extract employer visa sponsorship data from MyVisaJobs pages. Return ONLY a JSON object. No markdown, no commentary.";

const ENRICH_SYSTEM =
  "You are an expert in visa sponsorship and employer analysis. Return ONLY a JSON object.";

async function callOpenAI(system: string, user: string, maxTokens: number): Promise<string> {
  const res = await getClient().chat.completions.create({
    model: CONFIG.OPENAI_MODEL,
    temperature: 0.1,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  const content = res.choices[0]?.message?.content;
  if (!content) throw new Error("No content from OpenAI");
  return content;
}

export async function extractWithOpenAI(html: string, url: string): Promise<EmployerData> {
  const cleaned = stripHtml(html);
  const prompt = `Extract MyVisaJobs employer data from this page. URL: ${url}

Return ONLY a JSON object matching this exact shape (use null for missing, NOT strings):
{
  "companyName": string,
  "myVisaJobsUrl": "${url}",
  "verificationStatus": "Verified"|"Not Verified"|null,
  "visaRank": number|null,
  "totalH1BLCAs3yr": number|null,
  "totalGCLCs3yr": number|null,
  "totalDeniedWithdrawn3yr": number|null,
  "mainOfficeAddress": string|null,
  "mainOfficeCity": string|null,
  "mainOfficeState": string|null,
  "mainOfficeZip": string|null,
  "foundedYear": number|null,
  "numberOfEmployees": number|null,
  "naicsIndustry": string|null,
  "h1bDependent": "Yes"|"No"|"Unknown"|null,
  "willfulViolator": "Yes"|"No"|"Unknown"|null,
  "h1bLCACurrent": number|null,
  "h1bLCALastYear": number|null,
  "h1bLCA2YearsAgo": number|null,
  "gcLCCurrent": number|null,
  "gcLCLastYear": number|null,
  "gcLC2YearsAgo": number|null,
  "avgH1BSalaryCurrent": number|null,
  "avgGCSalaryCurrent": number|null,
  "topSponsoredRole1": string|null, "topSponsoredRole1Count": number|null,
  "topSponsoredRole2": string|null, "topSponsoredRole2Count": number|null,
  "topSponsoredRole3": string|null, "topSponsoredRole3Count": number|null,
  "otherSponsoredRoles": string|null,
  "topWorkerCountries": string|null,
  "contacts": [{"name": string|null, "title": string|null, "email": string|null, "phone": string|null, "type": "H1B"|"Green Card"|null}],
  "topH1BWorkSites": string|null,
  "topGCWorkSites": string|null,
  "reviewCount": number|null,
  "averageReviewScore": number|null,
  "positiveReviewKeywords": string|null,
  "negativeReviewKeywords": string|null
}

Extract EVERY unique email from contacts sections. Max 10 contacts.

PAGE TEXT:
${cleaned.slice(0, 40000)}`;

  const raw = await callOpenAI(EXTRACT_SYSTEM, prompt, 4000);
  const parsed = JSON.parse(extractJson(raw));
  return EmployerDataSchema.parse(parsed);
}

export async function enrichWithOpenAI(data: EmployerData): Promise<Enrichment> {
  const prompt = `Analyze this employer and return enrichment JSON.

EMPLOYER DATA:
${JSON.stringify(data, null, 2)}

Return ONLY this JSON:
{
  "industryCategory": string,
  "companySizeEstimate": string,
  "sponsorO1Visas": "Yes"|"No"|"Likely"|"Unknown",
  "sponsorshipTrend": "Increasing"|"Stable"|"Decreasing"|"New",
  "h1bApprovalRateCurrent": number|null,
  "h1bApprovalRateHistorical": number|null,
  "aiEmployerScore": number,
  "sponsorshipLikelihood": "Hot"|"Warm"|"Cold",
  "targetPriority": "A"|"B"|"C"|"D",
  "bestVisaTypes": string,
  "candidateMatchPotential": "High"|"Medium"|"Low",
  "partnershipOpportunity": "Direct Hiring"|"Petitioner Service"|"Education"|"None",
  "decisionMakerAccessibility": "Easy"|"Medium"|"Hard",
  "aiEvaluationNotes": string
}

SCORING: Rank 1-100=90-100, 101-500=70-89, 501-1000=50-69, 1000+=30-49. Bonuses for volume/approval/trend/salary/contacts.
PRIORITY: A=70+/rank<500/Hot, B=50-69/500-1000/Warm, C=30-49/1000-2000/Cold, D=<30/2000+`;

  const raw = await callOpenAI(ENRICH_SYSTEM, prompt, 1500);
  const parsed = JSON.parse(extractJson(raw));
  return EnrichmentSchema.parse(parsed);
}
