/**
 * lib/insights.ts — pure aggregation over the app's OWN data (the `history`
 * map of DayStats + the `roadmaps` array). No LLM call, no new backend
 * service: everything is computed client-side from what the app already
 * persists, so this stays on the always-free tier by construction.
 */
import type { DayStats, Roadmap } from "./types";
import { getTodayKey } from "./storage";

/** ISO weekday index: 0 = Sunday … 6 = Saturday. */
export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export interface BestDayInsight {
  weekday: string;
  avgFocusMinutes: number;
  completionPct: number;
  activeDays: number;
}

/**
 * Insight 1 — best day of the week for focus.
 *
 * "Best" is measured by completion rate (share of that day's tasks finished),
 * aggregated per weekday over all history; average focus minutes on that day
 * is reported as context. NOTE: the app persists per-DAY aggregates only (no
 * hour-of-day data), so "best time of day" would be fabricated — we return
 * the best DAY, which the data truthfully supports.
 */
export function bestFocusDay(
  history: Record<string, DayStats>
): BestDayInsight | null {
  const totals = Array.from({ length: 7 }, () => ({
    focus: 0,
    completed: 0,
    total: 0,
    active: 0,
  }));

  for (const key of Object.keys(history)) {
    const s = history[key];
    if (!s || !s.date) continue;
    if ((s.sessions_count ?? 0) <= 0 && (s.tasks_completed ?? 0) <= 0) continue;
    const dow = new Date(`${s.date}T00:00:00`).getDay();
    totals[dow].focus += s.focus_minutes ?? 0;
    totals[dow].completed += s.tasks_completed ?? 0;
    totals[dow].total += s.total_tasks ?? 0;
    totals[dow].active += 1;
  }

  let bestIdx = -1;
  let bestRate = -1;
  let bestActive = 0;
  for (let i = 0; i < 7; i++) {
    const t = totals[i];
    if (t.active === 0) continue;
    const rate = t.total > 0 ? t.completed / t.total : 0;
    if (rate > bestRate || (rate === bestRate && t.active > bestActive)) {
      bestRate = rate;
      bestIdx = i;
      bestActive = t.active;
    }
  }
  if (bestIdx < 0) return null;

  const b = totals[bestIdx];
  return {
    weekday: WEEKDAY_NAMES[bestIdx],
    avgFocusMinutes: b.active > 0 ? Math.round(b.focus / b.active) : 0,
    completionPct: Math.round(bestRate * 100),
    activeDays: b.active,
  };
}

/** ISO "YYYY-Www" week key for a "YYYY-MM-DD" date. */
function isoWeekKey(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00`);
  const day = (d.getDay() + 6) % 7; // Mon = 0
  const thursday = new Date(d);
  thursday.setDate(d.getDate() - day + 3);
  const firstThu = new Date(thursday.getFullYear(), 0, 4);
  firstThu.setDate(firstThu.getDate() - ((firstThu.getDay() + 6) % 7) + 3);
  const weekNo =
    1 + Math.round((thursday.getTime() - firstThu.getTime()) / (7 * 86400000));
  return `${thursday.getFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export interface WeeklyTrendInsight {
  deltaPct: number;
  direction: "improving" | "declining" | "steady";
  thisWeekMinutes: number;
  lastWeekMinutes: number;
}

/**
 * Insight 2 — week-over-week focus trend.
 *
 * Sums focus minutes per ISO week, then compares the two most recent weeks.
 * The current (possibly partial) week is compared to the previous one, with
 * a ±10% dead-band so normal noise reads as "steady", not a fake trend.
 */
export function focusWeeklyTrend(
  history: Record<string, DayStats>,
  referenceToday: string = getTodayKey()
): WeeklyTrendInsight | null {
  const byWeek = new Map<string, number>();
  for (const key of Object.keys(history)) {
    const s = history[key];
    if (!s || !s.date || s.date > referenceToday) continue; // ignore clock-skew future dates
    const wk = isoWeekKey(s.date);
    byWeek.set(wk, (byWeek.get(wk) ?? 0) + (s.focus_minutes ?? 0));
  }

  const weeks = Array.from(byWeek.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (weeks.length < 2) return null;

  const thisWeekMinutes = weeks[weeks.length - 1][1];
  const lastWeekMinutes = weeks[weeks.length - 2][1];
  if (thisWeekMinutes === 0 && lastWeekMinutes === 0) return null;

  let deltaPct = 0;
  if (lastWeekMinutes > 0) {
    deltaPct = Math.round(((thisWeekMinutes - lastWeekMinutes) / lastWeekMinutes) * 100);
  } else if (thisWeekMinutes > 0) {
    deltaPct = 100; // started from nothing
  }
  const direction: WeeklyTrendInsight["direction"] =
    deltaPct >= 10 ? "improving" : deltaPct <= -10 ? "declining" : "steady";

  return { deltaPct, direction, thisWeekMinutes, lastWeekMinutes };
}

export interface RoadmapPaceInsight {
  topic: string;
  completedDays: number;
  totalDays: number;
  daysPerWeek: number;
  avgPastDaysPerWeek: number | null;
  vs: "ahead" | "behind" | "on pace" | "baseline";
  label: string;
}

/**
 * Insight 3 — current roadmap pace vs past roadmaps' pace.
 *
 * Pace = completed roadmap-days per elapsed calendar week (a fair
 * normalisation because roadmaps differ in length and start date). The
 * baseline is the mean pace of COMPLETED roadmaps; the compared subject is
 * the most recent in-progress one. With no completed roadmap yet there is
 * no baseline — we say so rather than inventing a comparison.
 */
export function roadmapPace(roadmaps: Roadmap[]): RoadmapPaceInsight | null {
  const usable = roadmaps.filter((r) => r.createdAt > 0 && r.days.length > 0);
  if (usable.length === 0) return null;

  const now = Date.now();
  const paced = usable
    .map((r) => {
      const completedDays = r.days.filter((d) => d.is_completed).length;
      const elapsedDays = Math.max(1, (now - r.createdAt) / 86400000);
      return {
        topic: r.topic_name,
        status: r.status,
        createdAt: r.createdAt,
        completedDays,
        totalDays: r.days.length,
        daysPerWeek: (completedDays / elapsedDays) * 7,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt); // newest first

  // Baseline: average pace of finished roadmaps only.
  const past = paced.filter((p) => p.status === "completed");
  const avgPastDaysPerWeek =
    past.length > 0
      ? past.reduce((s, p) => s + p.daysPerWeek, 0) / past.length
      : null;

  // Compare the newest in-progress roadmap; fall back to the newest overall.
  const focus = paced.find((p) => p.status !== "completed") ?? paced[0];

  let vs: RoadmapPaceInsight["vs"] =
    avgPastDaysPerWeek == null ? "baseline" : "on pace";
  if (avgPastDaysPerWeek != null && avgPastDaysPerWeek > 0) {
    vs =
      focus.daysPerWeek > avgPastDaysPerWeek * 1.1
        ? "ahead"
        : focus.daysPerWeek < avgPastDaysPerWeek * 0.9
        ? "behind"
        : "on pace";
  }

  const rateLabel = `${focus.daysPerWeek.toFixed(1)} days/wk`;
  let label: string;
  if (avgPastDaysPerWeek != null && avgPastDaysPerWeek > 0) {
    const dir =
      vs === "ahead" ? "ahead of" : vs === "behind" ? "behind" : "in line with";
    label = `Current "${focus.topic}" is at ${rateLabel} — ${dir} your ${avgPastDaysPerWeek.toFixed(1)} days/wk past-roadmap pace.`;
  } else {
    label = `"${focus.topic}" is at ${rateLabel}. Finish a roadmap to unlock a pace comparison.`;
  }

  return {
    topic: focus.topic,
    completedDays: focus.completedDays,
    totalDays: focus.totalDays,
    daysPerWeek: Math.round(focus.daysPerWeek * 10) / 10,
    avgPastDaysPerWeek:
      avgPastDaysPerWeek != null
        ? Math.round(avgPastDaysPerWeek * 10) / 10
        : null,
    vs,
    label,
  };
}