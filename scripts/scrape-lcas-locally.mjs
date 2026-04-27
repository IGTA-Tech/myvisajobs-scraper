#!/usr/bin/env node
// Standalone local LCA scraper. Runs from your machine's residential IP
// because myvisajobs IP-gates /h1b-visa/lcafull.aspx specifically — cloud
// fetches return empty Section D, residential fetches return full data.
//
// Required env vars (set in your shell or .env.local before running):
//   MYVISAJOBS_COOKIE         full premium-candidate cookie string
//   SHEET_ID                  Google Sheet ID
//   GOOGLE_SERVICE_ACCOUNT_JSON  base64 or raw JSON of service account
//
// Usage:
//   node scripts/scrape-lcas-locally.mjs                 (default: 20 next-up employers)
//   node scripts/scrape-lcas-locally.mjs --limit=50      (top 50 to scrape)
//   node scripts/scrape-lcas-locally.mjs --slugs=oblockz,modernatx
//
// What it does (mirrors src/trigger/scrape-lcas-for-employer.ts):
//   1. Picks employers from IA_Employer_Leads where LCAs_Last_Scraped is
//      empty or older than 90 days, ordered by Visa_Rank ascending.
//   2. For each: fetch /h1b/search.aspx listings for years 2024/2025/2026,
//      collect LCA IDs (max 50 per year per employer).
//   3. Fetch each /h1b-visa/lcafull.aspx detail page, parse Section D
//      contact info, summary table, and Section F wage/location.
//   4. Drop rows where filing date is older than 540 days.
//   5. Bulk-append to LCA_Contacts + Jobs tabs, mark LCAs_Last_Scraped.

import { existsSync, readFileSync } from "node:fs";
import { load as loadHtml } from "cheerio";
import { sheets as sheetsApi } from "@googleapis/sheets";
import { JWT } from "google-auth-library";

// Auto-load .env.local if present (gitignored). Lines like KEY=value with
// optional surrounding quotes. Doesn't override anything already in process.env.
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

// ── Config ────────────────────────────────────────────────────────────────
const SHEET_TAB_LEADS = "IA_Employer_Leads";
const SHEET_TAB_LCA = "LCA_Contacts";
const SHEET_TAB_JOBS = "Jobs";
const LCA_YEARS = [2024, 2025, 2026];
const LCA_MAX_PER_EMPLOYER_YEAR = 50;
const LCA_MAX_AGE_DAYS = 540;
const LCA_RESCRAPE_AFTER_DAYS = 90;
const REQUEST_DELAY_MIN_MS = 400;
const REQUEST_DELAY_MAX_MS = 1200;
const BASE = "https://www.myvisajobs.com";

const COOKIE = process.env.MYVISAJOBS_COOKIE;
const SHEET_ID = process.env.SHEET_ID;
if (!COOKIE) throw new Error("MYVISAJOBS_COOKIE env var not set");
if (!SHEET_ID) throw new Error("SHEET_ID env var not set");

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argMap = Object.fromEntries(
  args
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? "true"];
    }),
);
const limit = Number(argMap.limit ?? 20);
const slugFilter = argMap.slugs ? argMap.slugs.split(",").map((s) => s.trim().toLowerCase()) : null;

// ── Google Sheets client ──────────────────────────────────────────────────
function getServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON env var not set");
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  }
}

const sa = getServiceAccount();
const auth = new JWT({
  email: sa.client_email,
  key: sa.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = sheetsApi({ version: "v4", auth });

// ── HTTP fetch with browser-like headers ──────────────────────────────────
function buildHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "max-age=0",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    Cookie: COOKIE,
  };
}

async function fetchPage(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: buildHeaders(), redirect: "follow" });
      if (res.status === 429 || res.status === 403) throw new Error(`rate-limited ${res.status} on ${url}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(1500 * (i + 1)); // 1.5s, 3s
    }
  }
  throw lastErr;
}

function isLoggedOut(html) {
  return html.includes("Premium Member Only, Sign Up Now!");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => REQUEST_DELAY_MIN_MS + Math.random() * (REQUEST_DELAY_MAX_MS - REQUEST_DELAY_MIN_MS);

// ── Sheet helpers ─────────────────────────────────────────────────────────
async function loadEmployersToScrape() {
  const headers = (
    await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB_LEADS}!1:1`,
    })
  ).data.values?.[0] ?? [];
  const urlIdx = headers.indexOf("MyVisaJobs_URL");
  const nameIdx = headers.indexOf("Company_Name");
  const rankIdx = headers.indexOf("Visa_Rank");
  const lastScrapedIdx = headers.indexOf("LCAs_Last_Scraped");
  if (urlIdx === -1 || nameIdx === -1 || rankIdx === -1 || lastScrapedIdx === -1) {
    throw new Error(`Required columns missing on ${SHEET_TAB_LEADS}: MyVisaJobs_URL/Company_Name/Visa_Rank/LCAs_Last_Scraped`);
  }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB_LEADS}!A2:FZ`,
  });
  const rows = res.data.values ?? [];
  const cutoffMs = Date.now() - LCA_RESCRAPE_AFTER_DAYS * 24 * 60 * 60 * 1000;

  const candidates = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const url = String(row?.[urlIdx] ?? "").trim();
    const name = String(row?.[nameIdx] ?? "").trim();
    const rankRaw = row?.[rankIdx];
    const rank = Number(rankRaw);
    const lastScraped = String(row?.[lastScrapedIdx] ?? "").trim();
    if (!url || !name || !Number.isFinite(rank) || rank <= 0) continue;
    const slugMatch = url.match(/\/employer\/([a-z0-9-]+)/i);
    if (!slugMatch) continue;
    const slug = slugMatch[1].toLowerCase();
    if (slugFilter && !slugFilter.includes(slug)) continue;
    if (lastScraped) {
      const t = Date.parse(lastScraped);
      if (Number.isFinite(t) && t > cutoffMs) continue; // recently scraped, skip
    }
    candidates.push({ slug, employerName: name, rowNumber: i + 2, visaRank: rank, lcaScrapedColIdx: lastScrapedIdx });
  }
  candidates.sort((a, b) => a.visaRank - b.visaRank);
  return candidates.slice(0, limit);
}

async function getScrapedLcaIds() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB_LCA}!A2:D`,
  });
  const rows = res.data.values ?? [];
  const out = new Set();
  for (const r of rows) {
    const id = r?.[0]?.toString().trim();
    const slug = r?.[1]?.toString().trim().toLowerCase();
    const year = r?.[3]?.toString().trim();
    if (id) out.add(id);
    if (slug && year) out.add(`${slug}::${year}`);
  }
  return out;
}

async function getScrapedJobIds() {
  const res = await sheets.spreadsheets.values
    .get({ spreadsheetId: SHEET_ID, range: `${SHEET_TAB_JOBS}!A2:A` })
    .catch(() => ({ data: { values: [] } }));
  const rows = res.data.values ?? [];
  const out = new Set();
  for (const r of rows) {
    const id = r?.[0]?.toString().trim();
    if (id) out.add(id);
  }
  return out;
}

async function appendLcaContacts(rows) {
  if (rows.length === 0) return 0;
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
    new Date().toISOString(),
  ]);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB_LCA}!A:R`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
  return values.length;
}

async function appendJobs(rows) {
  if (rows.length === 0) return 0;
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
    new Date().toISOString(),
  ]);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB_JOBS}!A:Q`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
  return values.length;
}

async function markEmployerScraped(rowNumber, colIdx) {
  const colLetter = (() => {
    let n = colIdx + 1;
    let s = "";
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  })();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB_LEADS}!${colLetter}${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [[new Date().toISOString()]] },
  });
}

// ── LCA listing + parser (ported from src/lib/lca-parser.ts) ──────────────
function extractLcaIdsFromListing(html) {
  const $ = loadHtml(html);
  const out = [];
  const seen = new Set();
  $('a[href*="lcafull.aspx"]').each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const m = href.match(/lcafull\.aspx\?(?:[^"&]*&)?id=(\d+)(?:&|$|").*?(?:y=(\d{4}))?/i);
    if (!m) return;
    const id = m[1];
    const yearStr = m[2] ?? href.match(/y=(\d{4})/)?.[1];
    const year = yearStr ? Number(yearStr) : new Date().getFullYear();
    const key = `${id}-${year}`;
    if (seen.has(key)) return;
    seen.add(key);
    const path = href.startsWith("http") ? href : `${BASE}${href.startsWith("/") ? "" : "/"}${href}`;
    out.push({ id, year, url: path });
  });
  return out;
}

function parseMoney(s) {
  if (!s) return null;
  const clean = String(s).replace(/[,$\s]/g, "");
  const n = Number(clean);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cleanPhone(raw) {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  if (/^\d+\.\d+e[+-]?\d+$/i.test(t)) return null;
  return t;
}

function extractSummaryTable($) {
  const out = {};
  $("table.tbl tr").each((_, tr) => {
    const tds = $(tr).find("td");
    for (let i = 0; i + 1 < tds.length; i += 2) {
      const label = $(tds[i]).text().replace(/[:\s]+$/g, "").trim();
      const value = $(tds[i + 1]).text().replace(/\s+/g, " ").trim();
      if (!label || !value) continue;
      if (/^redacted$/i.test(value)) continue;
      out[label] = value;
    }
  });
  return out;
}

function extractSectionItems($, headerMatcher) {
  const items = [];
  $("div.infoList").each((_, il) => {
    const headerText = $(il).find("div.secHeader h4").first().text().trim();
    if (!headerMatcher.test(headerText)) return;
    $(il)
      .find("div.infoHolder")
      .each((_, ih) => {
        const label = $(ih).find("h5").first().text().replace(/\s+/g, " ").trim();
        const pText = $(ih).find("p").first().text();
        const rawValue = (pText && pText.trim()) || $(ih).clone().find("h5").remove().end().text();
        const value = rawValue.replace(/\s+/g, " ").trim();
        if (!label) return;
        items.push({ label, value });
      });
  });
  return items;
}

function findItemValue(items, labelMatcher) {
  const hit = items.find((it) => labelMatcher.test(it.label));
  if (!hit) return null;
  const v = hit.value.trim();
  if (!v) return null;
  if (/^redacted$/i.test(v)) return null;
  if (/^\s*##?\s*$/.test(v)) return null;
  return v;
}

function parseLcaDetailHtml(html, meta) {
  const $ = loadHtml(html);
  const out = {
    lcaId: meta.lcaId,
    year: meta.year,
    lcaUrl: meta.lcaUrl,
    employerSlug: meta.employerSlug,
    employerName: null,
    caseNumber: null,
    filingDate: null,
    caseStatus: null,
    jobTitle: null,
    occupation: null,
    salaryMin: null,
    salaryMax: null,
    workCity: null,
    workState: null,
    lawFirm: null,
    contactLastName: null,
    contactFirstName: null,
    contactTitle: null,
    contactEmail: null,
    contactPhone: null,
  };

  const summary = extractSummaryTable($);
  out.caseStatus = summary["Status"] ?? null;
  out.employerName = summary["Employer"] ?? null;
  out.caseNumber = summary["Case Number"] ?? null;
  out.occupation = summary["Job Name(SOC)"] ?? summary["SOC"] ?? null;

  if (out.caseNumber) {
    const m = out.caseNumber.match(/^I-\d{3}-(\d{2})(\d{3})-/i);
    if (m) {
      const yy = Number(m[1]);
      const doy = Number(m[2]);
      const year = yy < 50 ? 2000 + yy : 1900 + yy;
      const d = new Date(Date.UTC(year, 0, doy));
      if (Number.isFinite(d.getTime())) out.filingDate = d.toISOString().slice(0, 10);
    }
  }

  const summaryWorkCity = summary["Work City"] ?? summary["Location"] ?? null;
  if (summaryWorkCity) {
    const m = summaryWorkCity.match(/^(.+?)[,\s]+([A-Z]{2})\s*$/);
    if (m) {
      out.workCity = m[1].trim();
      out.workState = m[2].trim();
    } else {
      out.workCity = summaryWorkCity;
    }
  }

  const wageStr = summary["Preoffered Wage"] ?? summary["Prevailing Wage"] ?? "";
  const wageMatch = wageStr.match(/\$?([\d,]+(?:\.\d+)?)/);
  if (wageMatch) {
    const v = parseMoney(wageMatch[1]);
    out.salaryMin = v;
    out.salaryMax = v;
  }

  const summaryContactName = summary["Employer Contact"] ?? null;
  const summaryContactEmail = summary["Contact Email"] ?? null;
  if (summaryContactName) {
    const parts = summaryContactName.split(/\s+/);
    if (parts.length >= 2) {
      out.contactFirstName = parts[0];
      out.contactLastName = parts.slice(1).join(" ");
    } else {
      out.contactLastName = summaryContactName;
    }
  }
  if (summaryContactEmail && !/^redacted$/i.test(summaryContactEmail)) {
    out.contactEmail = summaryContactEmail;
  }

  const sectionB = extractSectionItems($, /^B\.\s*Temporary/i);
  const jobTitle = findItemValue(sectionB, /^1\.\s*Job\s*Title/i);
  if (jobTitle) out.jobTitle = jobTitle;

  const sectionD = extractSectionItems($, /^D\.\s*Employer\s*Point\s*of\s*Contact/i);
  const dLast = findItemValue(sectionD, /^1\./);
  const dFirst = findItemValue(sectionD, /^2\./);
  const dTitle = findItemValue(sectionD, /^4\.\s*Contact'?s?\s*job\s*title/i);
  const dPhone = findItemValue(sectionD, /^12\.\s*Telephone/i);
  const dEmail = findItemValue(sectionD, /^14\.\s*E-?Mail/i);
  if (dLast) out.contactLastName = dLast;
  if (dFirst) out.contactFirstName = dFirst;
  if (dTitle) out.contactTitle = dTitle;
  if (dPhone) {
    const phone = cleanPhone(dPhone);
    if (phone) out.contactPhone = phone;
  }
  if (dEmail && !/^redacted$/i.test(dEmail)) out.contactEmail = dEmail;

  const sectionE = extractSectionItems($, /^E\.\s*Attorney/i);
  const lawFirm = findItemValue(sectionE, /Law\s*firm\/Business\s*name/i);
  if (lawFirm) out.lawFirm = lawFirm;

  const sectionF = extractSectionItems($, /^F\.\s*Employment\s*and\s*Wage/i);
  const fCity = findItemValue(sectionF, /^6\.\s*City/i);
  const fState = findItemValue(sectionF, /^8\.\s*State/i);
  if (fCity) out.workCity = fCity;
  if (fState) out.workState = fState;

  const wageRow = sectionF.find((it) => /10\.\s*Wage\s*Rate/i.test(it.label));
  if (wageRow) {
    const text = wageRow.value.replace(/\s+/g, " ");
    const fromMatch = text.match(/From:\s*\$?\s*([\d,]+(?:\.\d+)?)/i);
    const toMatch = text.match(/To:\s*\$?\s*([\d,]+(?:\.\d+)?)/i);
    const fromVal = parseMoney(fromMatch?.[1]);
    const toVal = parseMoney(toMatch?.[1]);
    if (fromVal) out.salaryMin = fromVal;
    if (toVal) out.salaryMax = toVal;
    else if (fromVal) out.salaryMax = fromVal;
  }

  return out;
}

// ── Per-employer scrape ───────────────────────────────────────────────────
async function scrapeEmployer(emp, scrapedKeys) {
  const allRows = [];
  let lcasFound = 0;
  let emptyParses = 0;
  let attempted = 0;
  let listingErrors = 0;
  let detailErrors = 0;
  const freshnessCutoffMs = Date.now() - LCA_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

  for (const year of LCA_YEARS) {
    if (scrapedKeys.has(`${emp.slug}::${year}`)) continue;

    const listingUrl = `${BASE}/h1b/search.aspx?e=${encodeURIComponent(emp.slug)}&st=certified&y=${year}`;
    let listingHtml;
    try {
      listingHtml = await fetchPage(listingUrl);
    } catch (err) {
      listingErrors++;
      console.warn(`  [${emp.slug}] listing ${year} fetch failed: ${err.message}`);
      continue;
    }
    if (isLoggedOut(listingHtml)) {
      console.error("Logged out — refresh MYVISAJOBS_COOKIE");
      process.exit(2);
    }
    const refs = extractLcaIdsFromListing(listingHtml)
      .filter((r) => !scrapedKeys.has(r.id))
      .slice(0, LCA_MAX_PER_EMPLOYER_YEAR);
    lcasFound += refs.length;

    for (const ref of refs) {
      await sleep(jitter());
      attempted++;
      let html;
      try {
        html = await fetchPage(ref.url);
      } catch (err) {
        detailErrors++;
        console.warn(`  [${emp.slug}] LCA ${ref.id} fetch failed: ${err.message}`);
        continue;
      }
      if (isLoggedOut(html)) {
        console.error("Logged out — refresh MYVISAJOBS_COOKIE");
        process.exit(2);
      }
      const parsed = parseLcaDetailHtml(html, {
        lcaId: ref.id,
        year: ref.year,
        lcaUrl: ref.url,
        employerSlug: emp.slug,
      });
      if (!parsed.employerName) parsed.employerName = emp.employerName;

      const meaningful =
        parsed.caseStatus ||
        parsed.caseNumber ||
        parsed.jobTitle ||
        parsed.contactEmail ||
        parsed.contactLastName ||
        parsed.workCity;
      if (!meaningful) {
        emptyParses++;
        continue;
      }
      if (parsed.filingDate) {
        const fdMs = Date.parse(parsed.filingDate + "T00:00:00Z");
        if (Number.isFinite(fdMs) && fdMs < freshnessCutoffMs) {
          scrapedKeys.add(ref.id);
          continue;
        }
      }
      allRows.push(parsed);
      scrapedKeys.add(ref.id);
    }
  }

  if (attempted > 0 && emptyParses / attempted >= 0.5) {
    console.error(`!! ${emp.slug}: ${emptyParses}/${attempted} LCAs returned empty. Cookie may be degraded — refresh MYVISAJOBS_COOKIE.`);
    process.exit(2);
  }

  return { allRows, lcasFound, emptyParses, attempted, listingErrors, detailErrors };
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Local LCA scraper starting (limit=${limit}${slugFilter ? `, slugs=${slugFilter.join(",")}` : ""})`);

  const employers = await loadEmployersToScrape();
  console.log(`Picked ${employers.length} employer(s) to scrape`);
  if (employers.length === 0) return;

  const scrapedKeys = await getScrapedLcaIds();
  const existingJobIds = await getScrapedJobIds();
  console.log(`Loaded ${scrapedKeys.size} known LCA-id keys, ${existingJobIds.size} existing Jobs rows for dedup`);

  let totalContacts = 0;
  let totalJobs = 0;

  for (let i = 0; i < employers.length; i++) {
    const emp = employers[i];
    console.log(`\n[${i + 1}/${employers.length}] ${emp.slug} (rank ${emp.visaRank})`);
    try {
      const { allRows, lcasFound, emptyParses, attempted, listingErrors, detailErrors } =
        await scrapeEmployer(emp, scrapedKeys);
      console.log(
        `  found=${lcasFound} parsed=${allRows.length} empty=${emptyParses}/${attempted} listingErr=${listingErrors} detailErr=${detailErrors}`,
      );

      // Jobs: one row per LCA, dedup by lcaId
      const newJobs = allRows.filter((r) => !existingJobIds.has(r.lcaId));
      const jobsWritten = await appendJobs(newJobs);
      newJobs.forEach((r) => existingJobIds.add(r.lcaId));
      totalJobs += jobsWritten;

      // LCA_Contacts: dedup by contactEmail within this employer
      const byEmail = new Map();
      const noEmail = [];
      for (const r of allRows) {
        const key = r.contactEmail?.toLowerCase();
        if (key) {
          if (!byEmail.has(key)) byEmail.set(key, r);
        } else {
          noEmail.push(r);
        }
      }
      const toWrite = [...byEmail.values(), ...noEmail];
      const contactsWritten = await appendLcaContacts(toWrite);
      totalContacts += contactsWritten;

      // Only mark LCAs_Last_Scraped if we ACTUALLY scraped something successfully.
      // Marking on failed listings would prevent retry for 90 days. The cron
      // schedule will re-pick employers with empty LCAs_Last_Scraped.
      const scrapeWasUseful = lcasFound > 0 && listingErrors < LCA_YEARS.length;
      if (scrapeWasUseful) {
        await markEmployerScraped(emp.rowNumber, emp.lcaScrapedColIdx);
        console.log(`  wrote ${jobsWritten} job rows, ${contactsWritten} contact rows. Marked LCAs_Last_Scraped.`);
      } else {
        console.log(`  wrote ${jobsWritten} job rows, ${contactsWritten} contact rows. Skipped marking (will retry).`);
      }
    } catch (err) {
      console.error(`  [${emp.slug}] aborted: ${err.message}`);
    }
  }

  console.log(`\nDone. Total: ${totalJobs} jobs + ${totalContacts} contacts across ${employers.length} employers.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
