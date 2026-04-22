export const CONFIG = {
  BATCH_SIZE: 50,
  CONCURRENCY: 5,
  REQUEST_DELAY_MIN_MS: 2000,
  REQUEST_DELAY_MAX_MS: 4000,
  CIRCUIT_BREAKER_THRESHOLD: 0.20,
  RATE_LIMIT_PAUSE_MS: 10 * 60 * 1000,
  MAX_CONTACTS_PER_EMPLOYER: 10,
  USER_AGENT:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  SHEET_TAB_LEADS: "IA_Employer_Leads",
  SHEET_TAB_QUEUE: "Queue",
  SHEET_TAB_DASHBOARD: "Dashboard",
  SHEET_TAB_FAILED: "Failed",
  SHEET_TAB_CONTROL: "Control",
  SHEET_TAB_LCA: "LCA_Contacts",
  SHEET_TAB_JOBS: "Jobs",
  SHEET_TAB_OUTREACH: "Outreach_Companies",
  SHEET_TAB_JOB_DESCRIPTIONS: "Job_Descriptions",
  // LCA scraper scope (option A, approved 2026-04-20)
  LCA_YEARS: [2025, 2026] as const,
  LCA_MAX_PER_EMPLOYER_YEAR: 20,
  LCA_TOP_N_EMPLOYERS: 2000,
  LCA_RESCRAPE_AFTER_DAYS: 90,
  LCA_ENQUEUE_BATCH_SIZE: 20,
  // Only keep LCAs filed within the last N days. Older filings have
  // stale hiring-manager contacts (candidate hired, role filled, staff
  // changes). Set higher to widen, lower to tighten.
  LCA_MAX_AGE_DAYS: 120,
  // --- Outreach job-description scraper (Firecrawl primary + Serper) ---
  OUTREACH_BATCH_SIZE: 50, // employers per daily cron tick
  OUTREACH_TOP_JOBS_PER_EMPLOYER: 3,
  OUTREACH_MAX_FIRECRAWL_RETRIES: 1, // if quality gate fails, try one more URL
  OUTREACH_MIN_DESCRIPTION_CHARS: 300, // quality gate for Description_Full
  OUTREACH_FIRECRAWL_MONTHLY_BUDGET: 3000, // Hobby plan refresh
  OUTREACH_FIRECRAWL_BREAKER_FRACTION: 0.8, // halt + alert at 80% used
  SERPER_ENDPOINT: "https://google.serper.dev/search",
  FIRECRAWL_SCRAPE_ENDPOINT: "https://api.firecrawl.dev/v1/scrape",
  HAIKU_MODEL: "claude-haiku-4-5-20251001",
  SONNET_MODEL: "claude-sonnet-4-5",
  OPENAI_MODEL: "gpt-4o-mini",
  TIMEZONE: "Africa/Lagos",
  MAX_DISCOVERY_APPEND: 5000,
} as const;
