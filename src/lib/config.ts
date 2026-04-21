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
  HAIKU_MODEL: "claude-haiku-4-5-20251001",
  SONNET_MODEL: "claude-sonnet-4-5",
  OPENAI_MODEL: "gpt-4o-mini",
  TIMEZONE: "Africa/Lagos",
  MAX_DISCOVERY_APPEND: 5000,
} as const;
