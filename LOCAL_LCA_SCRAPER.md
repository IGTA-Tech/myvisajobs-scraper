# Local LCA scraper

Standalone Node script that scrapes LCA detail pages from your machine's
residential IP. Sidesteps the cloud IP-gating that blocks the deployed
Trigger.dev `scrape-lcas-for-employer` task on `/h1b-visa/lcafull.aspx`.

Confirmed working: from your IP, Node fetch returns the full 78 KB LCA
page with `table.tbl` summary + 13 `infoList` sections. From Trigger.dev's
cloud IPs, the same request returns degraded empty content.

## One-time setup

1. Create `.env.local` in the project root (already gitignored):

   ```
   MYVISAJOBS_COOKIE=<paste the full cookie string here>
   SHEET_ID=1GB76CeFWGQo5YdQvsQvXLOFfs33fpZKAN-oaZOshfsg
   GOOGLE_SERVICE_ACCOUNT_JSON=<paste base64 or raw JSON of service account>
   ```

   - `MYVISAJOBS_COOKIE`: same cookie you've been pasting into Trigger.dev's env var
   - `SHEET_ID`: the visible portion of the sheet URL between `/d/` and `/edit`
   - `GOOGLE_SERVICE_ACCOUNT_JSON`: the same value already on Trigger.dev. Either base64-encoded JSON or the raw JSON wrapped in single quotes. The script auto-detects.

2. Install dependencies if not already done: `npm install`

## Running

```sh
node scripts/scrape-lcas-locally.mjs                 # default: top 20 next-up
node scripts/scrape-lcas-locally.mjs --limit=50      # take 50 employers
node scripts/scrape-lcas-locally.mjs --slugs=oblockz,modernatx   # specific employers
```

Picks employers from `IA_Employer_Leads` ordered by `Visa_Rank` ascending,
filtered to those with empty/old `LCAs_Last_Scraped`. Same selection logic
as the cloud `enqueue-lca-employers` task — they won't double-scrape.

## What it writes

- `LCA_Contacts` rows (with full Section D contact info)
- `Jobs` rows (one per LCA)
- `LCAs_Last_Scraped` timestamp on the employer's `IA_Employer_Leads` row

## What it doesn't touch

- Trigger.dev cloud tasks — keep running unchanged
- Cookie env vars on Trigger.dev — separate from `.env.local`
- Any other sheet tabs

## Cookie tips

- The cookie expires when you log out of myvisajobs or sit idle for hours
- If the script exits with "Cookie may be degraded — refresh MYVISAJOBS_COOKIE",
  re-capture from a working LCA detail page (use F12 → Network → click any
  request → copy the `Cookie:` header) and update `.env.local`
- Don't navigate myvisajobs in your browser between capturing and running —
  rolls `QVWROLES` and may invalidate the snapshot

## Stopping the cloud LCA spam alerts (optional)

While this local script handles the work, the cloud `enqueue-lca-employers`
cron still fires every 6h and emits "MyVisaJobs cookie likely degraded"
Telegram alerts. To silence:

1. Trigger.dev dashboard → Schedules tab
2. Find `myvisajobs.enqueue-lca-employers`
3. Toggle Enabled → off

The schedule definition stays in code, just inactive on prod. Reversible
in 1 click if cloud LCA scraping ever becomes viable (e.g., we add a
residential proxy).
