# Talents Pipeline — Sheet Setup Script

One-time Apps Script to create the `Talents` tab (36 columns) and the
`Talent_Queue` tab (7 columns).

## How to run

1. Extensions → Apps Script
2. **+** next to Files → Script → name it `talents-setup`
3. Clear file, paste below, **Ctrl+S**
4. Run `runTalentsSetup`
5. Allow permissions if asked

## The script

```javascript
function runTalentsSetup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var HEADER_BG = '#1a73e8';
  var HEADER_FG = '#ffffff';

  // --- Talents tab (36 columns) ---
  var talents = ss.getSheetByName('Talents');
  if (!talents) talents = ss.insertSheet('Talents');

  var talentHeaders = [
    'Talent_ID', 'Profile_URL', 'Full_Name', 'First_Name', 'Last_Name',
    'Email', 'Phone', 'Country', 'City', 'Looking_For',
    'Occupation_Category', 'Career_Level', 'Degree', 'Most_Recent_School', 'Most_Recent_Major',
    'Skills', 'Languages', 'Visa_Status', 'Work_Authorization', 'Expected_Salary',
    'Target_US_Locations', 'Years_Experience', 'Current_Company', 'Current_Title', 'Goal',
    'Certifications', 'Honors', 'Experiences_Full', 'Education_Full', 'Resume_URL',
    'Contact_Candidate_URL', 'Interests_Hobbies', 'AI_Summary', 'AI_Score', 'Scraped_At',
    'Notes'
  ];
  talents.getRange(1, 1, 1, talentHeaders.length).setValues([talentHeaders]);
  talents.getRange(1, 1, 1, talentHeaders.length)
    .setBackground(HEADER_BG).setFontColor(HEADER_FG)
    .setFontWeight('bold').setHorizontalAlignment('center').setWrap(true);
  talents.setFrozenRows(1);

  // Reasonable widths; long-text cols use clip-style wrapping
  var widths = [90, 320, 200, 130, 130, 220, 140, 110, 130, 220,
                160, 110, 130, 220, 200, 320, 160, 110, 140, 130,
                300, 130, 200, 220, 320, 320, 220, 600, 600, 220,
                280, 220, 400, 90, 160, 220];
  for (var i = 0; i < widths.length; i++) talents.setColumnWidth(i + 1, widths[i]);

  // Clip wrapping on long-text columns so rows stay short
  ['P','Y','Z','AA','AB','AC','AF','AG'].forEach(function(col){
    talents.getRange(col + '2:' + col).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  });

  // --- Talent_Queue tab (7 columns) ---
  var queue = ss.getSheetByName('Talent_Queue');
  if (!queue) queue = ss.insertSheet('Talent_Queue');

  var queueHeaders = ['Talent_ID', 'Profile_URL', 'Status', 'Discovery_Source', 'Discovered_At', 'Error', 'Processed_At'];
  queue.getRange(1, 1, 1, queueHeaders.length).setValues([queueHeaders]);
  queue.getRange(1, 1, 1, queueHeaders.length)
    .setBackground(HEADER_BG).setFontColor(HEADER_FG)
    .setFontWeight('bold').setHorizontalAlignment('center');
  queue.setFrozenRows(1);

  var qWidths = [90, 320, 110, 220, 160, 320, 160];
  for (var j = 0; j < qWidths.length; j++) queue.setColumnWidth(j + 1, qWidths[j]);

  console.log('Done! Talents (36 cols) + Talent_Queue (7 cols) created.');
}
```

## What you get

- **Talents** tab — 36 columns matching the schema
- **Talent_Queue** tab — `Talent_ID | Profile_URL | Status | Discovery_Source | Discovered_At | Error | Processed_At`

Long-text columns (Skills, Goal, Certifications, Honors, Experiences_Full, Education_Full, Interests_Hobbies, AI_Summary) use clip-style wrapping so rows stay one line tall.
