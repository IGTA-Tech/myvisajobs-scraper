import { sheets as sheetsApi, sheets_v4 } from "@googleapis/sheets";
import { JWT } from "google-auth-library";
import { CONFIG } from "./config.js";
import { LEAD_COLUMNS, colIndex } from "./columns.js";
import { EnrichedEmployer, LCAContact } from "./schema.js";

let sheetsClient: sheets_v4.Sheets | null = null;
function getSheets(): sheets_v4.Sheets {
  if (sheetsClient) return sheetsClient;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");
  const trimmed = raw.trim();
  const decoded = trimmed.startsWith("{")
    ? trimmed
    : Buffer.from(trimmed, "base64").toString("utf8");
  const creds = JSON.parse(decoded);
  const auth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheetsClient = sheetsApi({ version: "v4", auth });
  return sheetsClient;
}

function sheetId(): string {
  const id = process.env.SHEET_ID;
  if (!id) throw new Error("SHEET_ID is not set");
  return id;
}

export type QueueRow = {
  rowNumber: number;
  url: string;
  status: string;
  discoverySource: string | null;
  discoveryNotes: string | null;
};

/**
 * Read pending URLs from Queue tab.
 * Queue columns: A=URL | B=Status | C=Error | D=ProcessedAt | E=Discovery_Source | F=Discovery_Notes
 */
export async function readQueue(limit: number): Promise<QueueRow[]> {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId(),
    range: `${CONFIG.SHEET_TAB_QUEUE}!A2:F`,
  });
  const rows = res.data.values ?? [];
  const pending: QueueRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const [url, status, , , source, notes] = rows[i] ?? [];
    const s = (status ?? "").toString().trim().toLowerCase();
    if (url && (s === "" || s === "pending")) {
      pending.push({
        rowNumber: i + 2,
        url: url.toString().trim(),
        status: s,
        discoverySource: source ? String(source).trim() : null,
        discoveryNotes: notes ? String(notes).trim() : null,
      });
      if (pending.length >= limit) break;
    }
  }
  return pending;
}

export async function updateQueueRow(
  rowNumber: number,
  status: "processing" | "done" | "duplicate" | "error",
  error?: string,
): Promise<void> {
  const sheets = getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId(),
    range: `${CONFIG.SHEET_TAB_QUEUE}!B${rowNumber}:D${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [[status, error ?? "", new Date().toISOString()]] },
  });
}

/** Returns set of MyVisaJobs URLs already in the Queue tab (any status). */
export async function getQueuedUrls(): Promise<Set<string>> {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId(),
    range: `${CONFIG.SHEET_TAB_QUEUE}!A2:A`,
  });
  const rows = res.data.values ?? [];
  const out = new Set<string>();
  for (const r of rows) {
    const v = r?.[0];
    if (v) out.add(v.toString().trim().toLowerCase());
  }
  return out;
}

export type QueueAppendRow = {
  url: string;
  discoverySource: string;
  discoveryNotes: string;
};

/** Appends new URLs to the Queue tab with pending status and discovery metadata. */
export async function appendToQueue(items: QueueAppendRow[]): Promise<number> {
  if (items.length === 0) return 0;
  const sheets = getSheets();
  const rows = items.map((i) => [i.url, "pending", "", "", i.discoverySource, i.discoveryNotes]);
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: `${CONFIG.SHEET_TAB_QUEUE}!A:F`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });
  return items.length;
}

/** Returns set of MyVisaJobs URLs already in the leads sheet. */
export async function getExistingUrls(): Promise<Set<string>> {
  const sheets = getSheets();
  const urlColLetter = colLetter(colIndex("MyVisaJobs_URL") + 1);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId(),
    range: `${CONFIG.SHEET_TAB_LEADS}!${urlColLetter}2:${urlColLetter}`,
  });
  const rows = res.data.values ?? [];
  const out = new Set<string>();
  for (const r of rows) {
    const v = r?.[0];
    if (v) out.add(v.toString().trim().toLowerCase());
  }
  return out;
}

function colLetter(col: number): string {
  let s = "";
  while (col > 0) {
    const rem = (col - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    col = Math.floor((col - 1) / 26);
  }
  return s;
}

function generateEmployerID(): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rand = Math.floor(Math.random() * 10000).toString().padStart(4, "0");
  return `EMP-${ymd}-${rand}`;
}

function buildRow(data: EnrichedEmployer, addedBy: string): (string | number)[] {
  const row: (string | number)[] = new Array(LEAD_COLUMNS.length).fill("");
  const now = new Date().toISOString();
  const set = (col: string, v: unknown) => {
    if (v === null || v === undefined) return;
    row[colIndex(col)] = typeof v === "number" ? v : String(v);
  };

  set("Employer_ID", generateEmployerID());
  set("Date_Added", now);
  set("Timestamp", now);
  set("Company_Name", data.companyName);
  set("MyVisaJobs_URL", data.myVisaJobsUrl);
  set("Verification_Status", data.verificationStatus ?? "Unknown");
  set("Data_Source", "MyVisaJobs");

  set("Main_Office_Address", data.mainOfficeAddress);
  set("Main_Office_City", data.mainOfficeCity);
  set("Main_Office_State", data.mainOfficeState);
  set("Main_Office_Zip", data.mainOfficeZip);
  set("Founded_Year", data.foundedYear);
  set("NAICS_Industry", data.naicsIndustry);
  set("Industry_Category", data.industryCategory);
  set("Company_Size_Employees", data.companySizeEstimate ?? data.numberOfEmployees);
  set("H1B_Dependent_Status", data.h1bDependent ?? "Unknown");
  set("Willful_Violator_Status", data.willfulViolator ?? "Unknown");

  set("Visa_Rank", data.visaRank);
  set("Total_H1B_LCAs_3yr", data.totalH1BLCAs3yr ?? 0);
  set("Total_GC_LCs_3yr", data.totalGCLCs3yr ?? 0);
  set("Total_Denied_Withdrawn_3yr", data.totalDeniedWithdrawn3yr ?? 0);
  set("H1B_LCA_Current_Year", data.h1bLCACurrent ?? 0);
  set("H1B_LCA_Last_Year", data.h1bLCALastYear ?? 0);
  set("H1B_LCA_2_Years_Ago", data.h1bLCA2YearsAgo ?? 0);
  set("GC_LC_Current_Year", data.gcLCCurrent ?? 0);
  set("GC_LC_Last_Year", data.gcLCLastYear ?? 0);
  set("GC_LC_2_Years_Ago", data.gcLC2YearsAgo ?? 0);
  set("H1B_Approval_Rate_Current", data.h1bApprovalRateCurrent);
  set("H1B_Approval_Rate_Historical", data.h1bApprovalRateHistorical);
  set("Sponsorship_Trend", data.sponsorshipTrend);
  set("Avg_H1B_Salary_Current", data.avgH1BSalaryCurrent ?? 0);
  set("Avg_GC_Salary_Current", data.avgGCSalaryCurrent ?? 0);

  set("Top_Sponsored_Role_1", data.topSponsoredRole1);
  set("Top_Sponsored_Role_1_Count", data.topSponsoredRole1Count);
  set("Top_Sponsored_Role_2", data.topSponsoredRole2);
  set("Top_Sponsored_Role_2_Count", data.topSponsoredRole2Count);
  set("Top_Sponsored_Role_3", data.topSponsoredRole3);
  set("Top_Sponsored_Role_3_Count", data.topSponsoredRole3Count);
  set("Other_Sponsored_Roles", data.otherSponsoredRoles);
  set("Top_Worker_Countries", data.topWorkerCountries);
  set("Sponsor_O1_Visas", data.sponsorO1Visas ?? "Unknown");

  const contacts = data.contacts ?? [];
  for (let i = 0; i < Math.min(contacts.length, CONFIG.MAX_CONTACTS_PER_EMPLOYER); i++) {
    const c = contacts[i];
    const n = i + 1;
    set(`Contact_${n}_Name`, c.name);
    set(`Contact_${n}_Title`, c.title);
    set(`Contact_${n}_Email`, c.email);
    set(`Contact_${n}_Phone`, c.phone);
    set(`Contact_${n}_Type`, c.type);
  }

  set("Top_H1B_Work_Sites", data.topH1BWorkSites);
  set("Top_GC_Work_Sites", data.topGCWorkSites);

  set("AI_Employer_Score", data.aiEmployerScore);
  set("Evaluation_Date", now);
  set("Sponsorship_Likelihood", data.sponsorshipLikelihood);
  set("Target_Priority", data.targetPriority);
  set("Best_Visa_Types", data.bestVisaTypes);
  set("Candidate_Match_Potential", data.candidateMatchPotential);
  set("Partnership_Opportunity", data.partnershipOpportunity);
  set("Decision_Maker_Accessibility", data.decisionMakerAccessibility);
  set("AI_Evaluation_Notes", data.aiEvaluationNotes);

  set("Lead_Status", "New");
  set("Lead_Temperature", data.sponsorshipLikelihood ?? "Cold");
  set("Assigned_To", addedBy);

  set("Review_Count", data.reviewCount);
  set("Average_Review_Score", data.averageReviewScore);
  set("Positive_Review_Keywords", data.positiveReviewKeywords);
  set("Negative_Review_Keywords", data.negativeReviewKeywords);

  set("Last_Updated", now);
  set("Updated_By", addedBy);

  // Discovery metadata (columns FD/FE)
  set("Discovery_Source", data.discoverySource);
  set("Discovery_Notes", data.discoveryNotes);

  return row;
}

export async function appendEmployer(
  data: EnrichedEmployer,
  addedBy: string,
): Promise<number> {
  const sheets = getSheets();
  const row = buildRow(data, addedBy);
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: `${CONFIG.SHEET_TAB_LEADS}!A:A`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
  const updatedRange = res.data.updates?.updatedRange ?? "";
  const m = updatedRange.match(/!A(\d+)/);
  return m ? Number(m[1]) : -1;
}

/**
 * Pull top N employers from IA_Employer_Leads that haven't had their LCAs
 * scraped in the last N days (or ever). Sorted by Visa_Rank ascending
 * (rank 1 first). Returns employer metadata needed by the LCA scraper.
 */
export type EmployerToScrape = {
  slug: string;
  name: string;
  visaRank: number | null;
  rowNumber: number;
};

export async function getEmployersToScrapeLcas(
  topN: number,
  rescrapeAfterDays: number,
): Promise<EmployerToScrape[]> {
  const sheets = getSheets();
  const urlCol = colLetter(colIndex("MyVisaJobs_URL") + 1);
  const nameCol = colLetter(colIndex("Company_Name") + 1);
  const rankCol = colLetter(colIndex("Visa_Rank") + 1);
  const lcaCol = "FF"; // LCAs_Last_Scraped — col 162
  const firstCol = urlCol < nameCol ? urlCol : nameCol;
  const lastCol = "FF";

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId(),
    range: `${CONFIG.SHEET_TAB_LEADS}!A2:${lastCol}`,
  });
  const rows = res.data.values ?? [];
  const urlIdx = colIndex("MyVisaJobs_URL");
  const nameIdx = colIndex("Company_Name");
  const rankIdx = colIndex("Visa_Rank");
  const lcaIdx = 161; // 0-based index of FF (col 162)

  const cutoff = Date.now() - rescrapeAfterDays * 24 * 60 * 60 * 1000;
  const out: EmployerToScrape[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const url = row?.[urlIdx]?.toString().trim();
    if (!url) continue;
    const slugMatch = url.match(/\/employer\/([a-z0-9-]+)\/?$/i);
    if (!slugMatch) continue;
    const slug = slugMatch[1].toLowerCase();

    const lastScraped = row?.[lcaIdx]?.toString().trim();
    if (lastScraped) {
      const t = Date.parse(lastScraped);
      if (Number.isFinite(t) && t > cutoff) continue;
    }

    const rank = Number(row?.[rankIdx] ?? "");
    out.push({
      slug,
      name: row?.[nameIdx]?.toString().trim() ?? slug,
      visaRank: Number.isFinite(rank) && rank > 0 ? rank : null,
      rowNumber: i + 2,
    });
  }

  // Sort by rank ascending (nulls last)
  out.sort((a, b) => {
    if (a.visaRank == null && b.visaRank == null) return 0;
    if (a.visaRank == null) return 1;
    if (b.visaRank == null) return -1;
    return a.visaRank - b.visaRank;
  });

  return out.slice(0, topN);
}

/** Returns set of (slug::year) pairs already present in LCA_Contacts. */
export async function getScrapedLcaKeys(): Promise<Set<string>> {
  const sheets = getSheets();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId(),
      range: `${CONFIG.SHEET_TAB_LCA}!A2:D`,
    });
    const rows = res.data.values ?? [];
    const out = new Set<string>();
    for (const r of rows) {
      const lcaId = r?.[0]?.toString().trim();
      if (!lcaId) continue;
      const slug = r?.[1]?.toString().trim().toLowerCase();
      out.add(lcaId);
      if (slug) {
        const year = r?.[3]?.toString().trim();
        if (year) out.add(`${slug}::${year}`);
      }
    }
    return out;
  } catch {
    return new Set();
  }
}

/**
 * Write all scraped LCAs as job listings to the Jobs tab. Unlike
 * appendLcaContacts, does NOT dedup by email — one row per LCA filing.
 */
export async function appendJobs(rows: LCAContact[]): Promise<number> {
  if (rows.length === 0) return 0;
  const sheets = getSheets();
  const now = new Date().toISOString();
  const values = rows.map((r) => [
    r.lcaId,
    r.caseNumber ?? "",
    r.filingDate ?? "",
    r.year,
    r.caseStatus ?? "",
    r.employerName ?? "",
    r.employerSlug,
    r.jobTitle ?? "",
    r.occupation ?? "",
    r.salaryMin ?? "",
    r.salaryMax ?? "",
    r.workCity ?? "",
    r.workState ?? "",
    r.lawFirm ?? "",
    r.contactEmail ?? "",
    r.lcaUrl,
    now,
  ]);
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: `${CONFIG.SHEET_TAB_JOBS}!A:Q`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
  return rows.length;
}

/** Returns set of LCA IDs already in the Jobs tab (for dedup). */
export async function getScrapedJobIds(): Promise<Set<string>> {
  const sheets = getSheets();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId(),
      range: `${CONFIG.SHEET_TAB_JOBS}!A2:A`,
    });
    const rows = res.data.values ?? [];
    const out = new Set<string>();
    for (const r of rows) {
      const id = r?.[0]?.toString().trim();
      if (id) out.add(id);
    }
    return out;
  } catch {
    return new Set();
  }
}

export async function appendLcaContacts(rows: LCAContact[]): Promise<number> {
  if (rows.length === 0) return 0;
  const sheets = getSheets();
  const now = new Date().toISOString();
  const values = rows.map((r) => [
    r.lcaId,
    r.employerSlug,
    r.employerName ?? "",
    r.year,
    r.caseStatus ?? "",
    r.jobTitle ?? "",
    r.salaryMin ?? "",
    r.salaryMax ?? "",
    r.workCity ?? "",
    r.workState ?? "",
    r.lawFirm ?? "",
    r.contactLastName ?? "",
    r.contactFirstName ?? "",
    r.contactTitle ?? "",
    r.contactEmail ?? "",
    r.contactPhone ?? "",
    r.lcaUrl,
    now,
  ]);
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: `${CONFIG.SHEET_TAB_LCA}!A:R`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
  return rows.length;
}

/** Mark an employer row's LCAs_Last_Scraped cell with current timestamp. */
export async function markEmployerLcasScraped(rowNumber: number): Promise<void> {
  const sheets = getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId(),
    range: `${CONFIG.SHEET_TAB_LEADS}!FF${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [[new Date().toISOString()]] },
  });
}

export async function appendFailed(
  url: string,
  error: string,
  rawHtmlPreview: string,
): Promise<void> {
  const sheets = getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: `${CONFIG.SHEET_TAB_FAILED}!A:D`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[new Date().toISOString(), url, error, rawHtmlPreview.slice(0, 500)]],
    },
  });
}

export type DashboardStats = {
  scrapedToday: number;
  scrapedTotal: number;
  failedToday: number;
  duplicatesToday: number;
  aiFallbackToday: number;
  lastRun: string;
  lastRunStatus: string;
};

export async function updateDashboard(stats: Partial<DashboardStats>): Promise<void> {
  const sheets = getSheets();
  const entries = Object.entries(stats);
  if (!entries.length) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: `${CONFIG.SHEET_TAB_DASHBOARD}!A:C`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: entries.map(([k, v]) => [new Date().toISOString(), k, String(v ?? "")]),
    },
  });
}

/**
 * Reads the kill-switch cell. Returns true if the scraper is paused.
 * Control tab layout:
 *   A1: "Paused"   B1: TRUE/FALSE
 */
export async function isPaused(): Promise<boolean> {
  try {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId(),
      range: `${CONFIG.SHEET_TAB_CONTROL}!B1`,
    });
    const v = res.data.values?.[0]?.[0];
    if (v == null) return false;
    const s = String(v).trim().toUpperCase();
    return s === "TRUE" || s === "YES" || s === "1" || s === "PAUSED";
  } catch {
    // If the Control tab doesn't exist yet, default to running.
    return false;
  }
}

export async function getDashboardSummaryForToday(): Promise<DashboardStats> {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId(),
    range: `${CONFIG.SHEET_TAB_DASHBOARD}!A:C`,
  });
  const rows = res.data.values ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const acc: DashboardStats = {
    scrapedToday: 0,
    scrapedTotal: 0,
    failedToday: 0,
    duplicatesToday: 0,
    aiFallbackToday: 0,
    lastRun: "",
    lastRunStatus: "",
  };
  for (const r of rows) {
    const [ts, key, val] = r ?? [];
    if (!ts || !key) continue;
    const isToday = ts.toString().startsWith(today);
    if (key === "scrapedTotal") acc.scrapedTotal += Number(val) || 0;
    if (!isToday) continue;
    if (key === "scrapedToday") acc.scrapedToday += Number(val) || 0;
    if (key === "failedToday") acc.failedToday += Number(val) || 0;
    if (key === "duplicatesToday") acc.duplicatesToday += Number(val) || 0;
    if (key === "aiFallbackToday") acc.aiFallbackToday += Number(val) || 0;
    if (key === "lastRun") acc.lastRun = val ?? "";
    if (key === "lastRunStatus") acc.lastRunStatus = val ?? "";
  }
  return acc;
}
