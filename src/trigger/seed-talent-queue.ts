import { logger, task } from "@trigger.dev/sdk";
import {
  appendToTalentQueue,
  getKnownTalentIds,
  TalentQueueAppendItem,
} from "../lib/sheets.js";

export type SeedTalentQueuePayload = {
  candidates: Array<{
    talentId: string;
    profileUrl: string;
    discoverySource?: string;
  }>;
};

export type SeedTalentQueueResult = {
  received: number;
  appended: number;
  skippedKnown: number;
  skippedDuplicateInPayload: number;
};

/**
 * Bulk-loads candidate URLs into Talent_Queue from a payload produced by
 * scripts/parse-seed-html.mjs (locally parsed Match-and-Invite results pages).
 * Dedupes against existing Talents + Talent_Queue entries so re-runs are safe.
 */
export const seedTalentQueue = task({
  id: "myvisajobs.seed-talent-queue",
  maxDuration: 300,
  run: async (payload: SeedTalentQueuePayload): Promise<SeedTalentQueueResult> => {
    const candidates = payload?.candidates ?? [];
    logger.info("seed-talent-queue start", { received: candidates.length });

    if (candidates.length === 0) {
      return { received: 0, appended: 0, skippedKnown: 0, skippedDuplicateInPayload: 0 };
    }

    const known = await getKnownTalentIds();
    const seenInPayload = new Set<string>();
    const toAppend: TalentQueueAppendItem[] = [];
    let skippedKnown = 0;
    let skippedDuplicateInPayload = 0;

    for (const c of candidates) {
      const id = (c.talentId ?? "").toString().trim();
      const url = (c.profileUrl ?? "").toString().trim();
      if (!id || !url) continue;
      if (seenInPayload.has(id)) {
        skippedDuplicateInPayload++;
        continue;
      }
      seenInPayload.add(id);
      if (known.has(id)) {
        skippedKnown++;
        continue;
      }
      toAppend.push({
        talentId: id,
        profileUrl: url,
        discoverySource: c.discoverySource || "seed:manual",
      });
    }

    const appended = await appendToTalentQueue(toAppend);

    logger.info("seed-talent-queue done", {
      received: candidates.length,
      appended,
      skippedKnown,
      skippedDuplicateInPayload,
    });

    return {
      received: candidates.length,
      appended,
      skippedKnown,
      skippedDuplicateInPayload,
    };
  },
});
