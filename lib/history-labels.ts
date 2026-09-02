import type { CompletedItem, Roadmap } from "./types";

/**
 * v2 Fix 5 — single labeling rule for every history surface (sidebar,
 * History modal, study-history lists):
 *  - roadmap-backed entries render "<Topic> · Day <N>"
 *  - genuine no-roadmap activity renders "Unplanned focus session"
 * A generic placeholder like "General focus work" must never appear
 * (legacy occurrences are migrated at load time in lib/storage.ts).
 */
export const UNPLANNED_LABEL = "Unplanned focus session";

export function entryLabel(item: CompletedItem, roadmaps: Roadmap[]): string {
  if (item.roadmapId && item.dayNumber) {
    const roadmap = roadmaps.find((rm) => rm.id === item.roadmapId);
    if (roadmap) return `${roadmap.topic_name} · Day ${item.dayNumber}`;
  }
  return item.name?.trim() ? item.name : UNPLANNED_LABEL;
}