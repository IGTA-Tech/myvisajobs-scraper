# MyVisaJobs Scraper — Progress & Context

Reference doc for picking up where we left off. Updated 2026-04-20.

## TL;DR

Automated scraper pulling H-1B/Green Card visa sponsor data from myvisajobs.com into a Google Sheet. Runs entirely on Trigger.dev v4. Currently ~11,200+ employer rows populated at 97% success rate. Graph-traversal discovery has saturated — queue is empty and daily runs find 0 new employers from the existing connected component.

**Current initiative (as of 2026-04-20):** Building the LCA contact scraper to unlock role-specific hiring manager contacts from individual LCA filings.

## Repo

- GitHub: https://github.com/IGTA-Tech/myvisajobs-scraper
- Local: `C:\Coding Projects\myvisajob employer screper\`
- Trigger.dev project ref: `proj_ldimmjkyevggdsmijhdy`
- Org: IGTA
- Plan: Hobby ($10/mo)
- Owner: Sherrod Sports Visas (Yusuf Awodire / yusufawodire@gmail.com)
- Auto-deploy: GitHub integration on push to main

## Stack

- Node 20+ / TypeScript / ESM
- Trigger.dev v4 (`@trigger.dev/sdk` ^4.4.4) — scheduling, concurrency, retries
- `cheerio` — primary HTML parser (deterministic selectors, no AI tokens)
- `@googleapis/sheets` + `google-auth-library` — Sheet API (NOT full `googleapis` — that hit Trigger.dev build timeout)
- `@anthropic-ai/sdk` — Claude Haiku 4.5 (enrichment) + Sonnet 4.5 (fallback)
- `openai` — gpt-4o-mini final fallback (cross-provider safety net)
- `zod` — schema validation on every parse before sheet write

## Environment variables (Trigger.dev Production)

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude enrichment + AI fallback tiers |
| `OPENAI_API_KEY` | Cross-provider final fallback |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Base64-encoded service account JSON. Code auto-detects base64 vs raw JSON |
| `SHEET_ID` | `1GB76CeFWGQo5YdQvsQvXLOFfs33fpZKAN-oaZOshfsg` |
| `MYVISAJOBS_COOKIE` | Full browser session cookie from logged-in premium myvisajobs.com. Contact emails/phones are premium-gated. When expired, code detects "Premium Member Only" placeholder and fires critical Telegram alert + throws `CookieExpiredError` |
| `TELEGRAM_BOT_TOKEN` | For alerts |
| `TELEGRAM_CHAT_ID` | `5696015163` (Yusuf's personal DM) |

Service account email: `sheet-reader@cold-email-o1dmatch.iam.gserviceaccount.com` (reused from another project). Has Editor access to the sheet.

## Google Sheet tabs

- **`IA_Employer_Leads`** — 161 columns (original 159 from `EMPLOYER LEAD MANAGEMENT SYSTEM.txt` + 2 new discovery cols at FD/FE)
- **`Queue`** — URL pipeline: A=URL, B=Status, C=Error, D=ProcessedAt, E=Discovery_Source, F=Discovery_Notes
- **`Dashboard`** — 3 cols: Timestamp, Metric, Value (append-only counters)
- **`Failed`** — 4 cols: Timestamp, URL, Error, HtmlPreview (dead letter)
- **`Control`** — A1=Paused (label), B1=TRUE/FALSE (kill switch cell)

### New columns added to IA_Employer_Leads beyond original 159

| Col | Letter | Name | Purpose |
|---|---|---|---|
| 160 | FD | Discovery_Source | Short tag like `top_h1b_sponsors`, `related_from:tesla`, `manual` |
| 161 | FE | Discovery_Notes | Rich multi-line note with timestamp, source, position, company profile, AI insight |

Assigned_To column is DQ (position 121), strictly validated to dropdown: Sherrod, Ankit, Ryan, Bran, Lola, Unassigned. Automated runs default to "Sherrod".

## Trigger.dev tasks

| Task | Type | Schedule | Purpose |
|---|---|---|---|
| `myvisajobs.discover-employers` | scheduled | 6am Lagos | Crawls top H-1B + top GC rankings + cap-exempt list, extracts `/employer/{slug}/` URLs, dedups vs leads+queue, appends new to Queue |
| `myvisajobs.process-queue` | scheduled | Every 15 min | Reads up to 50 pending Queue rows, batch-scrapes via `batchTriggerAndWait`, writes results. **Checks Control!B1 kill switch at start** |
| `myvisajobs.scrape-employer` | on-demand | Called by process-queue | Fetches one employer page, parses, enriches, writes row. Also extracts ~13 Related & Recommended employer URLs and feeds back to Queue for graph traversal |
| `myvisajobs.daily-summary` | scheduled | 9am Lagos | Reads Dashboard counters, sends Telegram summary |

Concurrency: `scrape-employer` has `queue.concurrencyLimit: 5` so parallel fan-out is bounded.

## Extraction fallback cascade (in scrape-employer)

1. **cheerio selectors** (free, 99.96% hit rate in practice)
2. **Zod validation gate** — if company name missing or both visaRank and totalH1BLCAs3yr are null, drop through
3. **Claude Haiku 4.5** structured extraction
4. **Claude Sonnet 4.5** same prompt
5. **OpenAI gpt-4o-mini** cross-provider
6. **Dead-letter** — writes to `Failed` tab, Telegram alert

Circuit breaker in `process-queue`: halts task if >20% of batch hit AI fallback (drift signal).

## Hard-won lessons

1. **Trigger.dev v4 forbids `Promise.all` around `triggerAndWait`.** Throws `TASK_DID_CONCURRENT_WAIT`. Use `batchTriggerAndWait` instead. `Promise.all` around regular async (like `getExistingUrls` + `getQueuedUrls`) is fine.
2. **The full `googleapis` package is ~30MB and timed out Trigger.dev's managed build.** Swapped to `@googleapis/sheets` + `google-auth-library`.
3. **myvisajobs returns scientific-notation phones** like `1.20367e+010` in Green Card sections (ASP.NET float rendering). `cleanPhone()` in parser.ts discards these — email is what matters anyway.
4. **Contact emails/phones are PREMIUM-GATED.** Logged-out pages replace them with "Premium Member Only, Sign Up Now!" link. Detected by `isLoggedOut()` in fetcher.ts.
5. **Service account JSON can be pasted as base64 OR raw JSON** — `getSheets()` auto-detects. Base64 is cleaner (no multiline escaping).
6. **State URLs don't filter by state** — `/reports/h1b/state/california/` silently returns the national top-100. Had to remove Phase 2 state discovery and replace with graph traversal.
7. **Assigned_To column has strict dropdown validation.** Values outside the list trigger red warning triangles on every row. Default is "Sherrod" now.

## Build decisions log

- **Cookie auth over programmatic login** — simpler, works. Manual refresh when it expires (alert fires automatically). User provides fresh cookie; paste into env var; no redeploy needed.
- **Dropped Playwright from plan** — user wanted lean. Not needed for current site (all content is SSR). Dead-letter queue catches edge cases.
- **No custom monitoring UI** — Trigger.dev dashboard + Dashboard sheet tab + Telegram alerts are enough.
- **Kill switch in Control!B1** — mobile-accessible pause without touching Trigger.dev.
- **Graph traversal over state/industry expansion** — state URLs broken; industry requires ASP.NET POST with VIEWSTATE. Graph traversal yielded ~11,000 unique employers from 200-URL seed.

## Current state — 2026-04-20

- ~11,200+ rows in IA_Employer_Leads
- 97% scrape success rate, 0.04% AI fallback rate
- Daily cost: ~$1-2 (almost entirely Haiku enrichment — cheerio is free)
- Queue empty (graph saturated since 2026-04-18 23:45 UTC)
- Discovery finds 0 new URLs daily
- System idle but alive; daily summaries still fire

## Next build — LCA contacts (scope "A" — approved 2026-04-20)

**Goal:** Pull Section D "Employer Point of Contact Information" from individual LCA filings to surface role-specific hiring managers beyond the generic immigration reps we already have.

**URL pattern:**
- Employer's LCA list: `/h1b/search.aspx?e={slug}&st=certified&y={year}` — returns paginated job cards
- Each card has a "Job Details" link → full LCA page at `/h1b-visa/lcafull.aspx?id={N}&y={year}`
- Fully premium-gated, requires same `MYVISAJOBS_COOKIE`

**Scope (option A):**
- Years: 2025 + 2026
- Max LCAs per employer per year: 20
- Only `st=certified`
- Priority order: top 2,000 employers by visa rank (lowest rank first)
- Expected: ~80,000 LCA pages, ~22 days at current rate, ~160k new contact rows

**New sheet tab `LCA_Contacts`:**
- LCA_ID, Employer_Slug, Employer_Name, Year
- Case_Status, Job_Title, Salary_Min, Salary_Max
- Work_City, Work_State, Law_Firm
- Contact_Last_Name, Contact_First_Name, Contact_Title, Contact_Email, Contact_Phone
- LCA_URL, Scraped_At

**New column on IA_Employer_Leads (position 162 = FG):** `LCAs_Last_Scraped` — timestamp. Set by the LCA scraper when it finishes an employer. Dedup check before re-scraping.

**New tasks:**
- `myvisajobs.scrape-lcas-for-employer` — one employer × one year → parse list, fetch top 20 LCA pages, write rows
- `myvisajobs.enqueue-lca-employers` — scheduled daily, pulls top N unscraped employers from leads, fans out to the per-employer task via `batchTriggerAndWait`

**Dedup:** check `LCAs_Last_Scraped` column before enqueueing an employer. Skip if set within last 90 days.

## How to pause/resume

- **Fast:** flip `Control!B1` to `TRUE` — process-queue + future LCA tasks skip next tick. Flip to `FALSE` to resume.
- **Cron off:** Trigger.dev dashboard → Schedules tab → toggle schedule Enabled off.
- **In-flight:** Trigger.dev dashboard → Runs tab → click running run → Cancel.

## How to handle cookie expiry

Telegram alert fires on first logged-out response. To refresh:
1. Log in to myvisajobs.com in browser (premium)
2. F12 → Network → refresh → click any request → Request Headers → copy full `Cookie:` value
3. Trigger.dev → Env Vars → Production → edit `MYVISAJOBS_COOKIE` → paste → Save
4. Next run picks up the new cookie. No redeploy needed.

## Files map

- `trigger.config.ts` — Trigger.dev project config, retry defaults
- `src/lib/config.ts` — all tuning knobs (batch size, concurrency, thresholds, model IDs, sheet tab names)
- `src/lib/schema.ts` — Zod schemas (EmployerData, Contact, Enrichment) + `isParseHealthy()`
- `src/lib/columns.ts` — LEAD_COLUMNS array (must match live sheet 1:1) + `colIndex()` helper
- `src/lib/parser.ts` — cheerio parser, `parseContacts`, `cleanPhone`, `extractRelatedEmployers`
- `src/lib/anthropic.ts` — Haiku/Sonnet extraction + enrichment + OpenAI final fallback
- `src/lib/openai.ts` — OpenAI extractor/enrichment for fallback
- `src/lib/sheets.ts` — Sheets API wrapper: `readQueue`, `appendToQueue`, `getExistingUrls`, `getQueuedUrls`, `appendEmployer`, `updateDashboard`, `isPaused`
- `src/lib/telegram.ts` — `sendTelegramAlert(level, title, body)`
- `src/lib/fetcher.ts` — `fetchEmployerPage` (sends cookie), `isLoggedOut`, `RateLimitError`, `CookieExpiredError`, `sleep`
- `src/trigger/scrape-employer.ts` — per-employer scraper task
- `src/trigger/process-queue.ts` — batch orchestrator (15-min cron)
- `src/trigger/discover-employers.ts` — source crawler (6am cron)
- `src/trigger/daily-summary.ts` — Telegram summary task (9am cron)
- `SETUP.md` — original setup checklist (service account, env vars, sheet tabs)
- `SHEET_SETUP_SCRIPT.md` — Apps Script snippet to create Queue/Dashboard/Failed/Control tabs + discovery columns
- `README.md` — public project overview
