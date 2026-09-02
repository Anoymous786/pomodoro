/**
 * lib/activity.ts — pure streak + heatmap math.
 *
 * Source of truth: the app's persisted daily activity — the `history` map of
 * DayStats (date -> sessions_count / focus_minutes / tasks_completed) stored
 * in localStorage alongside the rest of state. This is the canonical activity
 * data the app already writes on every session/task completion, so these
 * features need NO new backend service or DynamoDB sync to be truthful.
 *
 * (A future DynamoDB productivity_logs table could back the same shape; these
 * helpers already accept a Record<date, DayStats>, so the source is swap-able.)
 */

import type { DayStats } from "./types";
import { getTodayKey } from "./storage";

/**
 * Whether a calendar day counts as "active" for streak purposes:
 * at least one completed Pomodoro session OR at least one completed task.
 */
export function isActiveDay(stats?: DayStats): boolean {
  if (!stats) return false;
  return (
    (stats.sessions_count ?? 0) > 0 ||
    (stats.tasks_completed ?? 0) > 0 ||
    (stats.check_ins ?? 0) > 0
  );
}

/** Shifts a "YYYY-MM-DD" string by `days` (supports negatives). */
export function shiftDate(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00`);
  d.setDate(d.getDate() + days);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Computes current + longest streak (in days) from daily activity.
 *
 * - A day "counts" if isActiveDay(...) is true.
 * - Current streak counts consecutive days ending TODAY; if today isn't yet
 *   active we count the run ending YESTERDAY (a streak persists until a full
 *   day is missed — GitHub-style).
 * - Longest is the max consecutive run anywhere in the history.
 */
export function computeStreaks(
  history: Record<string, DayStats>,
  referenceDate: string = getTodayKey()
): { current: number; longest: number } {
  const isActive = (key: string) => isActiveDay(history[key]);

  // Walk backwards from today to find the current streak.
  let current = 0;
  let day = referenceDate;
  if (isActive(day)) {
    while (isActive(day)) {
      current += 1;
      day = shiftDate(day, -1);
    }
  } else {
    day = shiftDate(day, -1); // persist the run even though today is quiet
    while (isActive(day)) {
      current += 1;
      day = shiftDate(day, -1);
    }
  }

  // Longest: scan all active keys; gaps (by real calendar dates) break runs.
  const keys = Object.keys(history).filter((k) => isActive(k)).sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const key of keys) {
    run = prev !== null && shiftDate(prev, 1) === key ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = key;
  }

  return { current, longest };
}

/**
 * Builds the data for a GitHub-style contribution heatmap covering the last
 * `weeks` weeks (default 12), one column per week, Sunday-first, ending today.
 *
 * Each cell: { date, sessions, focusMinutes, tasksCompleted, active }.
 * Color intensity is derived from focus minutes in ActivityHeatmap.
 */
export interface HeatmapDay {
  date: string; // "YYYY-MM-DD"
  sessions: number;
  focusMinutes: number;
  tasksCompleted: number;
  active: boolean;
}

export function buildActivityHeatmap(
  history: Record<string, DayStats>,
  today: string = getTodayKey(),
  weeks = 12,
  todayStats?: {
    sessions_count?: number;
    focus_minutes?: number;
    tasks_completed?: number;
    check_ins?: number;
  }
): { columns: HeatmapDay[][]; weeks: number; today: string } {
  const end = new Date(`${today}T00:00:00`);
  // §2.1 FIX: walk back (weeks*7 - 1) days, then snap further back to that
  // week's SUNDAY. Every column is therefore Sun..Sat, and TODAY is always
  // the last real cell of its column (the old formula ended the range
  // BEFORE today, so the most recent days — including today itself — were
  // silently missing from the grid).
  const spanDays = weeks * 7;
  const start = new Date(end);
  start.setDate(start.getDate() - (spanDays - 1));
  start.setDate(start.getDate() - start.getDay());

  const columns: HeatmapDay[][] = [];
  let col: HeatmapDay[] = [];
  const cursor = new Date(start);

  const keyOf = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;

  while (cursor <= end) {
    const key = keyOf(cursor);
    // Live today values win so the grid updates in-session.
    const stats: DayStats =
      key === today && todayStats
        ? {
            date: key,
            sessions_count: todayStats.sessions_count ?? 0,
            focus_minutes: todayStats.focus_minutes ?? 0,
            tasks_completed: todayStats.tasks_completed ?? 0,
            check_ins: todayStats.check_ins ?? history[key]?.check_ins ?? 0,
            total_tasks: history[key]?.total_tasks ?? 0,
            productivity: history[key]?.productivity ?? 0,
          }
        : history[key];
    const sessions = stats?.sessions_count ?? 0;
    const focusMinutes = stats?.focus_minutes ?? 0;
    const tasksCompleted = stats?.tasks_completed ?? 0;
    col.push({
      date: key,
      sessions,
      focusMinutes,
      tasksCompleted,
      active:
        sessions > 0 ||
        tasksCompleted > 0 ||
        (stats?.check_ins ?? 0) > 0,
    });
    cursor.setDate(cursor.getDate() + 1);
    if (col.length === 7) {
      columns.push(col);
      col = [];
    }
  }
  if (col.length > 0) columns.push(col); // partial current-week column

  // Right-pad a trailing partial column so every column has 7 rows.
  if (columns.length > 0 && columns[columns.length - 1].length < 7) {
    const last = columns[columns.length - 1];
    let lastDate = last[last.length - 1].date;
    while (last.length < 7) {
      lastDate = shiftDate(lastDate, 1);
      last.push({
        date: lastDate,
        sessions: 0,
        focusMinutes: 0,
        tasksCompleted: 0,
        active: false,
      });
    }
  }

  return { columns, weeks, today };
}

/**
 * Maps focus minutes to a 0-4 heatmap intensity bucket (GitHub-style with no
 * arbitrary scale — buckets derive from the max seen in the window).
 */
export function focusIntensity(
  minutes: number,
  maxInWindow: number
): 0 | 1 | 2 | 3 | 4 {
  if (minutes <= 0) return 0;
  if (maxInWindow <= 0) return 1;
  const ratio = minutes / maxInWindow;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

/** Human label for a cell's tooltip. */
export function describeDay(d: HeatmapDay): string {
  if (!d.active) return `${d.date}: no activity`;
  const parts = [`${d.date}`];
  if (d.sessions > 0)
    parts.push(`${d.sessions} session${d.sessions === 1 ? "" : "s"}`);
  if (d.focusMinutes > 0) parts.push(`${d.focusMinutes} min focused`);
  if (d.tasksCompleted > 0)
    parts.push(`${d.tasksCompleted} task${d.tasksCompleted === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
