# Google Sheet Setup Script

One-time script to create all required tabs and add the discovery columns to `IA_Employer_Leads`.

## How to run

1. Open your Google Sheet
2. **Extensions** -> **Apps Script**
3. In the file tree on the left, either:
   - Click an existing `.gs` file (like `Code.gs`) and **Ctrl+A** then **Delete** to clear it, OR
   - Click the **+** next to "Files" -> **Script** -> name it `setup`
4. Paste the entire code block below into the empty file
5. **Ctrl+S** to save
6. At the top, select `runSetup` from the function dropdown
7. Click **Run**
8. First run will ask for permissions -> **Review permissions** -> pick your account -> **Advanced** -> **Go to (project) (unsafe)** -> **Allow**
9. Wait for the "Done!" alert

When the alert appears, you're finished. Tell me and I'll push the scraper code.

## The script

```javascript
function runSetup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var HEADER_BG = '#1a73e8';
  var HEADER_FG = '#ffffff';

  function ensureTab(name, headers) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
    }
    if (headers && headers.length > 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length)
        .setBackground(HEADER_BG)
        .setFontColor(HEADER_FG)
        .setFontWeight('bold')
        .setHorizontalAlignment('center');
      sheet.setFrozenRows(1);
    }
    return sheet;
  }

  var queue = ensureTab('Queue', ['URL', 'Status', 'Error', 'ProcessedAt', 'Discovery_Source', 'Discovery_Notes']);
  queue.setColumnWidth(1, 400);
  queue.setColumnWidth(2, 110);
  queue.setColumnWidth(3, 300);
  queue.setColumnWidth(4, 160);
  queue.setColumnWidth(5, 180);
  queue.setColumnWidth(6, 500);

  ensureTab('Dashboard', ['Timestamp', 'Metric', 'Value']);
  ensureTab('Failed', ['Timestamp', 'URL', 'Error', 'HtmlPreview']);

  var control = ensureTab('Control', null);
  control.getRange('A1').setValue('Paused');
  control.getRange('B1').setValue('FALSE');
  control.getRange('A1:B1')
    .setBackground(HEADER_BG)
    .setFontColor(HEADER_FG)
    .setFontWeight('bold')
    .setHorizontalAlignment('center');

  var leads = ss.getSheetByName('IA_Employer_Leads');
  if (!leads) {
    throw new Error('IA_Employer_Leads tab not found');
  }

  var neededCols = 161;
  if (leads.getMaxColumns() < neededCols) {
    leads.insertColumnsAfter(leads.getMaxColumns(), neededCols - leads.getMaxColumns());
  }

  leads.getRange('FD1').setValue('Discovery_Source');
  leads.getRange('FE1').setValue('Discovery_Notes');

  leads.getRange('FD1:FE1')
    .setBackground(HEADER_BG)
    .setFontColor(HEADER_FG)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true);

  leads.setColumnWidth(160, 180);
  leads.setColumnWidth(161, 500);

  SpreadsheetApp.getUi().alert('Done! Tabs created and discovery columns added.');
}
```

## What it creates

- `Queue` tab with 6 columns: URL, Status, Error, ProcessedAt, Discovery_Source, Discovery_Notes
- `Dashboard` tab with 3 columns: Timestamp, Metric, Value
- `Failed` tab with 4 columns: Timestamp, URL, Error, HtmlPreview
- `Control` tab with A1=Paused, B1=FALSE (the kill switch)
- Adds `Discovery_Source` (column FD) and `Discovery_Notes` (column FE) to `IA_Employer_Leads`

All headers get the standard blue/white/bold formatting and row 1 frozen on each new tab. Safe to re-run — skips anything that already exists.

## If you still get a syntax error

It means a previous paste is still in the file. Make sure the file is **completely empty** before pasting (Ctrl+A then Delete), then paste this exact code and save.
