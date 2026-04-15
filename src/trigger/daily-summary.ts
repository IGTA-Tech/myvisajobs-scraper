import { logger, schedules } from "@trigger.dev/sdk";
import { CONFIG } from "../lib/config.js";
import { getDashboardSummaryForToday } from "../lib/sheets.js";
import { sendTelegramAlert } from "../lib/telegram.js";

export const dailySummary = schedules.task({
  id: "myvisajobs.daily-summary",
  cron: { pattern: "0 9 * * *", timezone: CONFIG.TIMEZONE },
  maxDuration: 60,
  run: async () => {
    const stats = await getDashboardSummaryForToday();
    logger.info("Daily summary", stats);

    const body = [
      `Scraped today: ${stats.scrapedToday}`,
      `Failed today: ${stats.failedToday}`,
      `Duplicates today: ${stats.duplicatesToday}`,
      `AI fallback today: ${stats.aiFallbackToday}`,
      `Last run: ${stats.lastRun || "n/a"} (${stats.lastRunStatus || "n/a"})`,
    ].join("\n");

    await sendTelegramAlert("info", "MyVisaJobs — Daily Summary", body);
    return stats;
  },
});
