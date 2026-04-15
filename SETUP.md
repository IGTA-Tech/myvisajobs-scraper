# Setup Checklist

Complete these steps once before the first deploy. Estimated time: **20–25 min**.

---

## 1. Google Cloud — Service Account (5 min)

1. Go to https://console.cloud.google.com/ → create a new project (or reuse one). Name it `myvisajobs-scraper`.
2. In the left menu: **APIs & Services → Library** → search "Google Sheets API" → **Enable**.
3. **APIs & Services → Credentials** → **Create Credentials → Service Account**.
   - Name: `myvisajobs-scraper`
   - Role: skip (click Continue → Done)
4. Click the newly created service account → **Keys** tab → **Add Key → Create new key → JSON** → download.
5. Open the downloaded JSON file. You'll paste its entire contents as one Trigger.dev env var below.
6. Copy the `client_email` field (looks like `myvisajobs-scraper@...iam.gserviceaccount.com`).

## 2. Google Sheet — Share + Add Tabs (5 min)

1. Open your sheet: https://docs.google.com/spreadsheets/d/1GB76CeFWGQo5YdQvsQvXLOFfs33fpZKAN-oaZOshfsg/edit
2. Click **Share** → paste the service account email from step 1.6 → give it **Editor** access → uncheck "Notify people" → **Share**.
3. Add three new tabs (right-click any tab → New sheet):

### Tab: `Queue`
Row 1 headers: `URL | Status | Error | ProcessedAt`

Paste myvisajobs employer URLs into column A. Leave B/C/D blank — the task fills them.

### Tab: `Dashboard`
Row 1 headers: `Timestamp | Metric | Value`

Leave empty — the task appends counters after each run.

### Tab: `Failed`
Row 1 headers: `Timestamp | URL | Error | HtmlPreview`

Leave empty — failed scrapes are logged here.

### Tab: `Control` (kill switch)
Row 1:
- A1: `Paused`
- B1: `FALSE`

Flip B1 to `TRUE` any time to pause the scraper at the next cron tick. Flip back to `FALSE` to resume. In-flight runs keep going — use the Trigger.dev dashboard to cancel those.

Verify the existing `IA_Employer_Leads` tab is present and untouched.

## 3. Telegram Bot (5 min)

1. Open Telegram → message `@BotFather` → send `/newbot`.
2. Follow prompts — name it anything, username must end in `bot` (e.g., `myvisajobs_scraper_bot`).
3. BotFather replies with a token like `123456789:ABCdef...` — save it.
4. **Message your new bot once** (send it "hi") — this is required before it can DM you.
5. Open in a browser (replace `<TOKEN>`):
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
6. Find `"chat":{"id":123456789,...}` — that number is your `TELEGRAM_CHAT_ID`.

## 4. Trigger.dev Env Vars (3 min)

In your Trigger.dev dashboard → **Project Settings → Environment Variables**. Add these to **Production** (and optionally Dev):

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic key (reuse from the old Apps Script if you like) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | **Entire contents** of the JSON file from step 1.4 — paste as one line |
| `SHEET_ID` | `1GB76CeFWGQo5YdQvsQvXLOFfs33fpZKAN-oaZOshfsg` |
| `TELEGRAM_BOT_TOKEN` | From step 3.3 |
| `TELEGRAM_CHAT_ID` | From step 3.6 |

> **Tip for `GOOGLE_SERVICE_ACCOUNT_JSON`**: two formats work:
> - **Raw JSON** — paste the file contents as-is (multiline is fine in Trigger.dev)
> - **Base64** — run `base64 -w0 service-account.json` (or paste into an online encoder) and paste the resulting single-line string. The code auto-detects both.

## 5. Deploy

Trigger.dev auto-deploys when you push to the connected GitHub repo. So:

```bash
git add .
git commit -m "Initial scraper build"
git push origin main
```

Watch the Trigger.dev dashboard — the deploy should appear within 1–2 minutes. Verify the three tasks show up:

- `myvisajobs.scrape-employer`
- `myvisajobs.process-queue` (scheduled, every 15 min)
- `myvisajobs.daily-summary` (scheduled, 9 AM Africa/Lagos)

## 6. First Run (test with 1 URL)

1. Paste one URL into the `Queue` tab (e.g., `https://www.myvisajobs.com/employer/nb-ventures/`).
2. In Trigger.dev dashboard → `myvisajobs.process-queue` → **Test → Run**.
3. Watch the run logs. On success you should see a new row in `IA_Employer_Leads` and the Queue row marked `done`.
4. If it fails: check the `Failed` tab and Trigger.dev logs.

---

## Tuning knobs

All in `src/lib/config.ts`:

| Constant | Default | What it does |
|---|---|---|
| `BATCH_SIZE` | 50 | Max URLs per scheduled run |
| `CONCURRENCY` | 5 | Parallel scrape tasks |
| `REQUEST_DELAY_MIN_MS` / `MAX_MS` | 2000 / 4000 | Per-worker jitter between requests |
| `CIRCUIT_BREAKER_THRESHOLD` | 0.20 | Trip if >20% of batch falls to AI |

Change → commit → push → Trigger.dev redeploys.

## Pause / Resume

**Fast pause (sheet kill switch):** set `Control!B1` to `TRUE`. The next 15-min tick will exit immediately without processing anything. Set back to `FALSE` to resume. Works from the mobile Sheets app.

**Hard stop (Trigger.dev):** Dashboard → Schedules → `myvisajobs.process-queue` → disable. Stops all future cron fires until re-enabled. Use this for long pauses.

**Cancel in-flight runs:** Dashboard → Runs → click a running run → Cancel. Use alongside a pause to stop everything immediately.

## Troubleshooting

- **Service account can't read sheet** → forgot to Share in step 2.2.
- **`SHEET_ID is not set`** → Trigger.dev env var missing; set in Production environment.
- **429 or 403 from myvisajobs** → Telegram alert fires automatically. Increase `REQUEST_DELAY_MIN_MS` and reduce `CONCURRENCY`.
- **Circuit breaker trips** → cheerio selectors drifted. Open `src/lib/parser.ts`, refresh selectors against a current page, push.
- **Nothing in Queue processes** → rows must have blank `Status` or `pending`; anything else is skipped.
