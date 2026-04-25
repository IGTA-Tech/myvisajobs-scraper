import { logger, task } from "@trigger.dev/sdk";
import { CookieExpiredError, RateLimitError } from "../lib/fetcher.js";
import { fetchTalentPage, isTalentLoggedOut } from "../lib/talent-fetcher.js";
import { parseTalentProfile } from "../lib/talent-parser.js";
import { enrichTalentWithAI } from "../lib/anthropic.js";
import { TalentSchema, Talent } from "../lib/schema.js";
import { CONFIG } from "../lib/config.js";
import { appendTalent, updateTalentQueueRow } from "../lib/sheets.js";
import { sendTelegramAlert } from "../lib/telegram.js";

export type ScrapeTalentPayload = {
  talentId: string;
  profileUrl: string;
  queueRowNumber: number;
  discoverySource: string | null;
};

export type ScrapeTalentResult = {
  talentId: string;
  written: boolean;
  reason?: string;
  aiScore?: number | null;
};

export const scrapeTalent = task({
  id: "myvisajobs.scrape-talent",
  queue: { concurrencyLimit: 5 },
  maxDuration: 120,
  retry: { maxAttempts: 2, minTimeoutInMs: 2000, maxTimeoutInMs: 10000, factor: 2 },
  run: async (payload: ScrapeTalentPayload): Promise<ScrapeTalentResult> => {
    const { talentId, profileUrl, queueRowNumber } = payload;
    logger.info("Scraping talent", { talentId, profileUrl });

    let html: string;
    try {
      html = await fetchTalentPage(profileUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof RateLimitError) {
        await sendTelegramAlert("warning", "Talent fetch rate-limited", `${profileUrl}\n${msg}`);
      }
      await updateTalentQueueRow(queueRowNumber, "error", msg);
      throw err;
    }

    if (isTalentLoggedOut(html)) {
      await sendTelegramAlert(
        "critical",
        "MYVISAJOBS_TALENT_COOKIE expired",
        `Talent profile fetch returned a sign-in page. Refresh MYVISAJOBS_TALENT_COOKIE env var on Trigger.dev.`,
      );
      await updateTalentQueueRow(queueRowNumber, "error", "talent-cookie-expired");
      throw new CookieExpiredError();
    }

    const parsed = parseTalentProfile(html, profileUrl);
    parsed.talentId = talentId; // ensure we use the queue's id
    parsed.scrapedAt = new Date().toISOString();

    // AI enrichment: Haiku -> Sonnet -> OpenAI -> rule-based (never throws)
    let aiSummary: string | null = null;
    let aiScore: number | null = null;
    if (CONFIG.TALENT_AI_ENRICH) {
      try {
        const enrich = await enrichTalentWithAI({
          fullName: parsed.fullName,
          lookingFor: parsed.lookingFor,
          occupationCategory: parsed.occupationCategory,
          careerLevel: parsed.careerLevel,
          degree: parsed.degree,
          mostRecentSchool: parsed.mostRecentSchool,
          mostRecentMajor: parsed.mostRecentMajor,
          skills: parsed.skills,
          country: parsed.country,
          city: parsed.city,
          visaStatus: parsed.visaStatus,
          workAuthorization: parsed.workAuthorization,
          expectedSalary: parsed.expectedSalary,
          targetUsLocations: parsed.targetUsLocations,
          yearsExperience: parsed.yearsExperience,
          currentCompany: parsed.currentCompany,
          currentTitle: parsed.currentTitle,
          goal: parsed.goal,
          certifications: parsed.certifications,
          honors: parsed.honors,
          experiencesFull: parsed.experiencesFull,
          educationFull: parsed.educationFull,
        });
        aiSummary = enrich.aiSummary;
        aiScore = enrich.aiScore;
      } catch (err) {
        logger.warn("Talent AI enrichment failed (non-fatal)", {
          talentId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    parsed.aiSummary = aiSummary;
    parsed.aiScore = aiScore;
    parsed.notes = parsed.notes ?? null;

    const validated = TalentSchema.safeParse(parsed);
    if (!validated.success) {
      const issues = JSON.stringify(validated.error.issues).slice(0, 500);
      await updateTalentQueueRow(queueRowNumber, "error", `validation: ${issues}`);
      logger.error("Talent validation failed", { talentId, issues });
      return { talentId, written: false, reason: `validation-failed` };
    }

    await appendTalent(validated.data as Talent);
    await updateTalentQueueRow(queueRowNumber, "done");

    logger.info("Talent written", {
      talentId,
      name: validated.data.fullName,
      aiScore,
    });

    return { talentId, written: true, aiScore };
  },
});
