# Jobs Tab Setup Script

One-time Apps Script to create the `Jobs` tab. Run after the next deploy lands.

## How to run

1. Extensions → Apps Script
2. **+** next to Files → Script → name it `jobs-setup`
3. Clear the file (Ctrl+A, Delete)
4. Paste the code below, **Ctrl+S**
5. Select `runJobsSetup` → **Run**
6. Allow permissions if asked

## The script

```javascript
function runJobsSetup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var HEADER_BG = '#1a73e8';
  var HEADER_FG = '#ffffff';

  var jobs = ss.getSheetByName('Jobs');
  if (!jobs) jobs = ss.insertSheet('Jobs');

  var headers = [
    'LCA_ID', 'Case_Number', 'Filing_Date', 'Year', 'Status',
    'Employer_Name', 'Employer_Slug', 'Job_Title', 'Occupation',
    'Salary_Min', 'Salary_Max', 'Work_City', 'Work_State',
    'Law_Firm', 'Contact_Email', 'LCA_URL', 'Scraped_At'
  ];

  jobs.getRange(1, 1, 1, headers.length).setValues([headers]);
  jobs.getRange(1, 1, 1, headers.length)
    .setBackground(HEADER_BG)
    .setFontColor(HEADER_FG)
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  jobs.setFrozenRows(1);

  var widths = [90, 160, 110, 70, 100, 220, 160, 240, 200, 100, 100, 130, 80, 220, 220, 320, 160];
  for (var i = 0; i < widths.length; i++) jobs.setColumnWidth(i + 1, widths[i]);

  console.log('Done! Jobs tab ready.');
}
```

## What you get

A fresh `Jobs` tab with 17 columns. Every LCA scraped by the existing per-employer task now writes a row here (one row = one job posting). Duplicate LCA IDs are skipped automatically.

## How to see "latest" jobs

In any blank cell of a view tab (or directly in the sheet), use:

```
=SORT(Jobs!A2:Q, 3, FALSE)
```

Sorts by Filing_Date descending (newest first).

For "last 30 days only":

```
=QUERY(Jobs!A:Q, "SELECT * WHERE C >= date '"&TEXT(TODAY()-30,"yyyy-mm-dd")&"' ORDER BY C DESC", 1)
```
