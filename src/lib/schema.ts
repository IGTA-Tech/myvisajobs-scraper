import { z } from "zod";

export const ContactSchema = z.object({
  name: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
  email: z.string().nullable().default(null),
  phone: z.string().nullable().default(null),
  type: z.string().nullable().default(null),
});
export type Contact = z.infer<typeof ContactSchema>;

export const EmployerDataSchema = z.object({
  companyName: z.string().min(1),
  myVisaJobsUrl: z.string().url(),
  verificationStatus: z.string().nullable().default(null),
  visaRank: z.number().nullable().default(null),
  totalH1BLCAs3yr: z.number().nullable().default(null),
  totalGCLCs3yr: z.number().nullable().default(null),
  totalDeniedWithdrawn3yr: z.number().nullable().default(null),
  mainOfficeAddress: z.string().nullable().default(null),
  mainOfficeCity: z.string().nullable().default(null),
  mainOfficeState: z.string().nullable().default(null),
  mainOfficeZip: z.string().nullable().default(null),
  foundedYear: z.number().nullable().default(null),
  numberOfEmployees: z.number().nullable().default(null),
  naicsIndustry: z.string().nullable().default(null),
  h1bDependent: z.string().nullable().default(null),
  willfulViolator: z.string().nullable().default(null),
  h1bLCACurrent: z.number().nullable().default(null),
  h1bLCALastYear: z.number().nullable().default(null),
  h1bLCA2YearsAgo: z.number().nullable().default(null),
  gcLCCurrent: z.number().nullable().default(null),
  gcLCLastYear: z.number().nullable().default(null),
  gcLC2YearsAgo: z.number().nullable().default(null),
  avgH1BSalaryCurrent: z.number().nullable().default(null),
  avgGCSalaryCurrent: z.number().nullable().default(null),
  topSponsoredRole1: z.string().nullable().default(null),
  topSponsoredRole1Count: z.number().nullable().default(null),
  topSponsoredRole2: z.string().nullable().default(null),
  topSponsoredRole2Count: z.number().nullable().default(null),
  topSponsoredRole3: z.string().nullable().default(null),
  topSponsoredRole3Count: z.number().nullable().default(null),
  otherSponsoredRoles: z.string().nullable().default(null),
  topWorkerCountries: z.string().nullable().default(null),
  contacts: z.array(ContactSchema).default([]),
  topH1BWorkSites: z.string().nullable().default(null),
  topGCWorkSites: z.string().nullable().default(null),
  reviewCount: z.number().nullable().default(null),
  averageReviewScore: z.number().nullable().default(null),
  positiveReviewKeywords: z.string().nullable().default(null),
  negativeReviewKeywords: z.string().nullable().default(null),
  discoverySource: z.string().nullable().default(null),
  discoveryNotes: z.string().nullable().default(null),
});
export type EmployerData = z.infer<typeof EmployerDataSchema>;

export const EnrichmentSchema = z.object({
  industryCategory: z.string().nullable().default(null),
  companySizeEstimate: z.string().nullable().default(null),
  sponsorO1Visas: z.string().nullable().default(null),
  sponsorshipTrend: z.string().nullable().default(null),
  h1bApprovalRateCurrent: z.number().nullable().default(null),
  h1bApprovalRateHistorical: z.number().nullable().default(null),
  aiEmployerScore: z.number().nullable().default(null),
  sponsorshipLikelihood: z.string().nullable().default(null),
  targetPriority: z.string().nullable().default(null),
  bestVisaTypes: z.string().nullable().default(null),
  candidateMatchPotential: z.string().nullable().default(null),
  partnershipOpportunity: z.string().nullable().default(null),
  decisionMakerAccessibility: z.string().nullable().default(null),
  aiEvaluationNotes: z.string().nullable().default(null),
});
export type Enrichment = z.infer<typeof EnrichmentSchema>;

export type EnrichedEmployer = EmployerData &
  Partial<Enrichment> & { companySizeEstimate?: string | null; numberOfEmployees?: number | null };

// LCA = Labor Condition Application — one filing per H-1B job posting.
// Section D of the LCA contains the Employer Point of Contact, often a
// role-specific hiring manager distinct from the generic immigration reps.
export const LCAContactSchema = z.object({
  lcaId: z.string().min(1),
  employerSlug: z.string().min(1),
  employerName: z.string().nullable().default(null),
  year: z.number(),
  caseNumber: z.string().nullable().default(null),
  filingDate: z.string().nullable().default(null),
  caseStatus: z.string().nullable().default(null),
  jobTitle: z.string().nullable().default(null),
  occupation: z.string().nullable().default(null),
  salaryMin: z.number().nullable().default(null),
  salaryMax: z.number().nullable().default(null),
  workCity: z.string().nullable().default(null),
  workState: z.string().nullable().default(null),
  lawFirm: z.string().nullable().default(null),
  contactLastName: z.string().nullable().default(null),
  contactFirstName: z.string().nullable().default(null),
  contactTitle: z.string().nullable().default(null),
  contactEmail: z.string().nullable().default(null),
  contactPhone: z.string().nullable().default(null),
  lcaUrl: z.string().url(),
});
export type LCAContact = z.infer<typeof LCAContactSchema>;

// Job_Descriptions row — fully enriched job from external sources (careers page,
// ATS, LinkedIn). One row per (LCA_ID). Claude Haiku extracts the structured
// fields from scraped markdown; Description_Full preserves the raw source.
export const JobDescriptionSchema = z.object({
  rowId: z.string().min(1),
  outreachRow: z.number().int().positive(),
  outreachRank: z.number().nullable().default(null),
  employerName: z.string().min(1),
  employerSlug: z.string().nullable().default(null),
  employerEmail: z.string().nullable().default(null),
  jobTitle: z.string().min(1),
  location: z.string().nullable().default(null),
  remoteFlag: z.string().nullable().default(null),
  workType: z.string().nullable().default(null),
  salaryMin: z.number().nullable().default(null),
  salaryMax: z.number().nullable().default(null),
  salaryPeriod: z.string().nullable().default(null),
  experienceLevel: z.string().nullable().default(null),
  descriptionFull: z.string().default(""),
  descriptionSummary: z.string().nullable().default(null),
  responsibilities: z.string().nullable().default(null),
  qualifications: z.string().nullable().default(null),
  requiredSkills: z.string().nullable().default(null),
  preferredSkills: z.string().nullable().default(null),
  education: z.string().nullable().default(null),
  yearsExperience: z.string().nullable().default(null),
  benefits: z.string().nullable().default(null),
  visaSponsorship: z.string().nullable().default(null),
  sourceUrl: z.string().url(),
  sourceDomain: z.string(),
  sourceType: z.string(),
  postedDate: z.string().nullable().default(null),
  applicationUrl: z.string().nullable().default(null),
  qualityScore: z.number().min(0).max(1).default(0),
  scraperTier: z.string(),
  aiSummary: z.string().nullable().default(null),
  scrapedAt: z.string(),
  notes: z.string().nullable().default(null),
  // internal — key for dedup. Not written to sheet directly.
  lcaId: z.string(),
});
export type JobDescription = z.infer<typeof JobDescriptionSchema>;

/**
 * Critical fields that MUST be present for a parse to be considered valid.
 * If any are missing after cheerio, we fall through to AI extraction.
 */
export function isParseHealthy(data: Partial<EmployerData>): boolean {
  if (!data.companyName || data.companyName.length < 2) return false;
  if (data.visaRank == null && data.totalH1BLCAs3yr == null) return false;
  return true;
}
