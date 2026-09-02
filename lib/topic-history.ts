/**
 * lib/topic-history.ts — per-topic progress summaries for the History view.
 * Pure aggregation over persisted state: roadmaps carry day completion,
 * estimationLog carries real focus minutes per roadmap/day (recorded by the
 * timer). No LLM call, no extra persistence — same source of truth as the
 * heatmap and streaks.
 */
import type { EstimationRecord, Roadmap } from "./types";

export interface TopicSummary {
  id: string;
  topic: string;
  icon: string;
  status: "in_progress" | "completed";
  doneDays: number;
  totalDays: number;
  pct: number;
  /** Real focused minutes logged against this roadmap (0 when none yet). */
  focusMinutes: number;
}

export function topicSummaries(
  roadmaps: Roadmap[],
  estimationLog: EstimationRecord[]
): TopicSummary[] {
  const focusByRoadmap = new Map<string, number>();
  for (const e of estimationLog) {
    if (!e.roadmapId) continue;
    focusByRoadmap.set(
      e.roadmapId,
      (focusByRoadmap.get(e.roadmapId) ?? 0) + (e.actual_minutes || 0)
    );
  }

  return roadmaps.map((r) => {
    const doneDays = r.days.filter((d) => d.is_completed).length;
    const totalDays = r.days.length || 1;
    const minutes = focusByRoadmap.get(r.id) ?? 0;
    return {
      id: r.id,
      topic: r.topic_name,
      icon: r.badge_reward?.icon ?? "🎯",
      status: r.status,
      doneDays,
      totalDays: r.days.length,
      pct: Math.round((doneDays / totalDays) * 100),
      focusMinutes: minutes,
    };
  });
}

/** "3h 40m" style formatting for logged focus time. */
export function formatFocusMinutes(total: number): string {
  if (total <= 0) return "0m";
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}