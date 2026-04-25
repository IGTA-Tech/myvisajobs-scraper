// Parses every .html file in ./seed-html/ and emits seed-html/candidates.json
// with a deduped array of { talentId, profileUrl, discoverySource } items.
//
// Run:  node scripts/parse-seed-html.mjs
//
// Then copy the JSON contents into the Trigger.dev "seed-talent-queue" task
// test panel and run it — it will append the items to the Talent_Queue tab.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { load as loadHtml } from "cheerio";

const seedDir = resolve(process.cwd(), "seed-html");
const outFile = join(seedDir, "candidates.json");

const files = readdirSync(seedDir)
  .filter((f) => f.toLowerCase().endsWith(".html"))
  .sort();

if (files.length === 0) {
  console.error(`No .html files found in ${seedDir}`);
  process.exit(1);
}

const seen = new Set();
const items = [];
const perFile = [];

for (const f of files) {
  const html = readFileSync(join(seedDir, f), "utf8");
  const $ = loadHtml(html);
  let foundInFile = 0;
  let newInFile = 0;

  $('a[href*="/candidate/"]').each((_, a) => {
    const href = ($(a).attr("href") ?? "").trim();
    const m = href.match(/\/candidate\/([a-z0-9-]+)-(\d+)\/?$/i);
    if (!m) return;
    foundInFile++;
    const slug = m[1];
    const id = m[2];
    if (seen.has(id)) return;
    seen.add(id);
    newInFile++;
    items.push({
      talentId: id,
      profileUrl: `https://www.myvisajobs.com/candidate/${slug}-${id}/`,
      discoverySource: `seed:${basename(f, ".html")}`,
    });
  });

  perFile.push({ file: f, totalLinks: foundInFile, uniqueAdded: newInFile });
}

writeFileSync(outFile, JSON.stringify({ candidates: items }, null, 2));

console.log(`\nParsed ${files.length} files\n`);
console.table(perFile);
console.log(`\nTotal unique candidates: ${items.length}`);
console.log(`Wrote ${outFile}\n`);
console.log("Next step:");
console.log("  1. Open Trigger.dev dashboard → task 'myvisajobs.seed-talent-queue'");
console.log("  2. Click 'Test task'");
console.log(`  3. Paste the contents of ${outFile} as the payload`);
console.log("  4. Run — it will dedupe against the sheet and append new rows.\n");
