# LCA Contacts — Sheet Setup Script

One-time Apps Script to create the `LCA_Contacts` tab and add the `LCAs_Last_Scraped` column to `IA_Employer_Leads`. Run after you approve the LCA scraper build.

## How to run

1. Open your Google Sheet → **Extensions** → **Apps Script**
2. Click the **+** next to "Files" → **Script** → name it `lca-setup`
3. Delete any default content in the new file (Ctrl+A, Delete)
4. Paste the code block below, **Ctrl+S** to save
5. Select `runLcaSetup` from the function dropdown → click **Run**
6. Allow permissions on first run
7. Wait for the "Done!" alert

## The script

```javascript
function runLcaSetup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var HEADER_BG = '#1a73e8';
  var HEADER_FG = '#ffffff';

  // --- 1. Create LCA_Contacts tab ---
  var lca = ss.getSheetByName('LCA_Contacts');
  if (!lca) {
    lca = ss.insertSheet('LCA_Contacts');
  }

  var headers = [
    'LCA_ID', 'Employer_Slug', 'Employer_Name', 'Year',
    'Case_Status', 'Job_Title', 'Salary_Min', 'Salary_Max',
    'Work_City', 'Work_State', 'Law_Firm',
    'Contact_Last_Name', 'Contact_First_Name', 'Contact_Title',
    'Contact_Email', 'Contact_Phone',
    'LCA_URL', 'Scraped_At'
  ];

  lca.getRange(1, 1, 1, headers.length).setValues([headers]);
  lca.getRange(1, 1, 1, headers.length)
    .setBackground(HEADER_BG)
    .setFontColor(HEADER_FG)
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  lca.setFrozenRows(1);

  // Column widths
  var widths = [100, 160, 220, 70, 110, 240, 100, 100, 130, 80, 220, 140, 140, 180, 220, 130, 320, 160];
  for (var i = 0; i < widths.length; i++) {
    lca.setColumnWidth(i + 1, widths[i]);
  }

  // --- 2. Add LCAs_Last_Scraped column to IA_Employer_Leads ---
  var leads = ss.getSheetByName('IA_Employer_Leads');
  if (!leads) {
    throw new Error('IA_Employer_Leads tab not found');
  }

  var neededCols = 162;
  if (leads.getMaxColumns() < neededCols) {
    leads.insertColumnsAfter(leads.getMaxColumns(), neededCols - leads.getMaxColumns());
  }

  leads.getRange('FF1').setValue('LCAs_Last_Scraped');
  leads.getRange('FF1')
    .setBackground(HEADER_BG)
    .setFontColor(HEADER_FG)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setWrap(true);
  leads.setColumnWidth(162, 170);

  SpreadsheetApp.getUi().alert('Done! Created LCA_Contacts tab and added LCAs_Last_Scraped column (FF) to IA_Employer_Leads.');
}
```

## What this creates

**New tab `LCA_Contacts`** with 18 columns:

| Col | Header | Notes |
|---|---|---|
| A | LCA_ID | Numeric ID from myvisajobs URL |
| B | Employer_Slug | Used for dedup + linking back |
| C | Employer_Name | Readable |
| D | Year | Fiscal year of filing |
| E | Case_Status | Certified / Denied / Withdrawn |
| F | Job_Title | Exact title from LCA |
| G | Salary_Min | In dollars |
| H | Salary_Max | In dollars (midpoint if single value) |
| I | Work_City | |
| J | Work_State | |
| K | Law_Firm | Attorney firm handling filing (if any) |
| L | Contact_Last_Name | Section D field 1 |
| M | Contact_First_Name | Section D field 2 |
| N | Contact_Title | Section D field 4 |
| O | Contact_Email | |
| P | Contact_Phone | |
| Q | LCA_URL | Full URL for reference |
| R | Scraped_At | ISO timestamp |

**New column FF on `IA_Employer_Leads`**: `LCAs_Last_Scraped` — ISO timestamp when the LCA scraper last processed this employer. Used to dedup re-scrapes (skip if scraped within 90 days).
