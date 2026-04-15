# MyVisaJobs Employer Scraper

Automated scraper that pulls employer visa-sponsorship data from myvisajobs.com and writes it to a Google Sheet. Runs on Trigger.dev.

## Architecture

- **Tier 1:** cheerio selector-based parser (fast, free, default path)
- **Tier 2:** Zod validation gate (catches silent parse drift)
- **Tier 3:** Claude Haiku 4.5 extraction fallback (cheap AI)
- **Tier 4:** Claude Sonnet 4.6 extraction fallback (smart AI)
- **Dead-letter:** failed rows marked in sheet, Telegram alert fired
- **Enrichment:** Claude Haiku 4.5 scoring/priority (with Sonnet fallback)
- **Dedup:** skips URLs already present in `IA_Employer_Leads`
- **Circuit breaker:** task halts if >20% of a batch hits AI fallback

## Tasks

| Task | Trigger | Purpose |
|---|---|---|
| `myvisajobs.process-queue` | Cron every 15 min | Reads `Queue` tab, scrapes pending URLs |
| `myvisajobs.scrape-employer` | Called by queue processor | Scrapes one employer (runs up to 5 in parallel) |
| `myvisajobs.daily-summary` | Cron 9am WAT | Telegram daily stats |

## Setup

See [SETUP.md](./SETUP.md).

## Tuning

All knobs at top of `src/lib/config.ts`:
- `BATCH_SIZE` (default 50)
- `CONCURRENCY` (default 5)
- `REQUEST_DELAY_MS` (default 2000-4000 jitter)
- `CIRCUIT_BREAKER_THRESHOLD` (default 0.20)
