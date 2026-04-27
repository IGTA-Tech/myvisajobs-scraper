# Cleanup script: clear empty/junk rows from LCA_Contacts

One-shot Apps Script for the Google Sheet. Removes rows that were
written with only metadata columns (LCA_ID, Slug, Name, Year, URL,
Scraped_At) populated and every parser-derived field blank — the
result of cookie-degraded scrapes that the empty-parse gate now blocks
going forward.

## What it does

1. Walks `LCA_Contacts`. Identifies junk rows = ALL of these blank:
   `Case_Status`, `Job_Title`, `Contact_Last_Name`, `Contact_Email`.
2. Replaces the data rows with only the good rows kept.
3. Clears `LCAs_Last_Scraped` on `IA_Employer_Leads` for every employer
   whose junk rows we just deleted, so the next 6h LCA cron picks
   them up again and re-scrapes them with the working cookie + the
   new gate.

## How to run

1. Open the sheet → Extensions → Apps Script
2. Paste the script below into a new file (or replace existing)
3. Run `clearJunkLcaRows`
4. Watch the execution log for the deletion + reset summary

## The script

```javascript
function clearJunkLcaRows() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lcaSheet = ss.getSheetByName('LCA_Contacts');
  const leadsSheet = ss.getSheetByName('IA_Employer_Leads');

  if (!lcaSheet) throw new Error('LCA_Contacts tab not found');

  // ── Step 1: scan LCA_Contacts and partition rows into good vs junk ──
  const lcaLastRow = lcaSheet.getLastRow();
  if (lcaLastRow < 2) {
    console.log('LCA_Contacts has no data rows');
    return;
  }
  const lcaCols = 18; // A..R
  const data = lcaSheet.getRange(2, 1, lcaLastRow - 1, lcaCols).getValues();

  const goodRows = [];
  const junkSlugs = new Set();
  let junkCount = 0;

  for (const row of data) {
    const caseStatus       = String(row[4]  || '').trim(); // E
    const jobTitle         = String(row[5]  || '').trim(); // F
    const contactLastName  = String(row[11] || '').trim(); // L
    const contactEmail     = String(row[14] || '').trim(); // O

    const meaningful = caseStatus || jobTitle || contactLastName || contactEmail;
    if (meaningful) {
      goodRows.push(row);
    } else {
      junkCount++;
      const slug = String(row[1] || '').trim().toLowerCase();
      if (slug) junkSlugs.add(slug);
    }
  }

  console.log('LCA_Contacts scan: ' + data.length + ' rows scanned, '
    + goodRows.length + ' good, ' + junkCount + ' junk, '
    + junkSlugs.size + ' affected employer slugs');

  if (junkCount === 0) {
    console.log('Nothing to clean up.');
    return;
  }

  // ── Step 2: rewrite LCA_Contacts with only the good rows ──
  // Bulk overwrite is much faster than deleteRow in a loop.
  lcaSheet.getRange(2, 1, data.length, lcaCols).clearContent();
  if (goodRows.length > 0) {
    lcaSheet.getRange(2, 1, goodRows.length, lcaCols).setValues(goodRows);
  }
  console.log('LCA_Contacts now has ' + goodRows.length + ' rows.');

  // ── Step 3: clear LCAs_Last_Scraped for affected employers ──
  if (!leadsSheet) {
    console.log('IA_Employer_Leads tab not found — skipped re-scrape reset.');
    return;
  }
  const headers = leadsSheet.getRange(1, 1, 1, leadsSheet.getLastColumn()).getValues()[0];
  const urlIdx = headers.indexOf('MyVisaJobs_URL');
  const lcaScrapedIdx = headers.indexOf('LCAs_Last_Scraped');
  if (urlIdx === -1 || lcaScrapedIdx === -1) {
    console.log('Could not find MyVisaJobs_URL or LCAs_Last_Scraped column on IA_Employer_Leads.');
    console.log('Junk rows have been removed but employers will not be auto-re-scraped.');
    return;
  }

  const leadsLastRow = leadsSheet.getLastRow();
  const urlData = leadsSheet.getRange(2, urlIdx + 1, leadsLastRow - 1, 1).getValues();
  const rowsToClear = [];
  for (let i = 0; i < urlData.length; i++) {
    const url = String(urlData[i][0] || '').trim();
    const m = url.match(/\/employer\/([a-z0-9-]+)/i);
    const slug = m ? m[1].toLowerCase() : '';
    if (slug && junkSlugs.has(slug)) {
      rowsToClear.push(i + 2); // sheet row number
    }
  }

  // Clear in batched range writes
  for (const r of rowsToClear) {
    leadsSheet.getRange(r, lcaScrapedIdx + 1).clearContent();
  }

  console.log('Cleared LCAs_Last_Scraped on ' + rowsToClear.length
    + ' employers — next LCA cron will re-pick them.');

  console.log('Done. Summary:');
  console.log('  - Junk rows deleted: ' + junkCount);
  console.log('  - Good rows kept:    ' + goodRows.length);
  console.log('  - Employers reset:   ' + rowsToClear.length);
}
```
