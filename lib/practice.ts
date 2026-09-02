/**
 * v5 — pure business logic for practice goals (§16):
 *   currentDay = today - startDate + 1   (clamped to the plan)
 *   status     = Not Started | In Progress | Completed | Overdue
 * Deadlines NEVER silently extend; an uncompleted past-due goal is Overdue
 * and is excluded from "success" counts on the dashboard while staying in
 * History.
 */
import type { PracticeTask } from "./types";
import { istTodayKey, shiftIST, labelIST } from "./date-ist";
import { syncCompletedDays, isTaskAutoCompleted } from "./task-roadmap";

export type PracticeStatus =
  | "Not Started"
  | "In Progress"
  | "Completed"
  | "Overdue";

export interface PracticeWindow {
  deadlineKey: string;
  currentDay: number;
  completedDays: number;
  progressPct: number;
  daysRemaining: number;
  status: PracticeStatus;
  rangeLabel: string;
  durationLabel: string;
}

export function practiceWindow(
  task: Pick<
    PracticeTask,
    "startDate" | "durationDays" | "checkIns" | "is_completed" | "roadmap"
  >,
  todayKey: string = istTodayKey()
): PracticeWindow {
  const duration = Math.max(1, Math.round(task.durationDays));
  const deadlineKey = shiftIST(task.startDate, duration - 1);

  // §4: day completion is DERIVED from step completion, not manual check-ins.
  // Auto-sync completed days from the task's own roadmap steps.
  const autoDays = syncCompletedDays(task.roadmap ?? [], task.checkIns ?? []);

  const completedDays = Math.min(autoDays.length, duration);
  const allStepsDone = isTaskAutoCompleted(task.roadmap) && (task.roadmap?.length ?? 0) > 0;

    // §5: a task is Completed the moment every roadmap step is done (saved).
    // All step completion is derived live from the steps, so un-doing a
    // step automatically removes the Completed status again. The persisted
    // `is_completed` flag is a cache, not the source of truth.
  const doneAll = allStepsDone;

  // Current day index (1-based), clamped: before start → 1, after end → N.
  let currentDay = 1;
  if (todayKey >= task.startDate) {
    let cursor = task.startDate;
    let n = 1;
    while (cursor < todayKey && n < duration) {
      cursor = shiftIST(cursor, 1);
      n += 1;
    }
    currentDay = n;
  }

  const pastDue = todayKey > deadlineKey;
  const status: PracticeStatus = doneAll
    ? "Completed"
    : pastDue
    ? "Overdue"
    : completedDays === 0 && currentDay === 1
    ? "Not Started"
    : "In Progress";

  return {
    deadlineKey,
    currentDay,
    completedDays,
    progressPct: Math.round((completedDays / duration) * 100),
    daysRemaining: Math.max(0, duration - completedDays),
    status,
    rangeLabel: `${labelIST(task.startDate)} → ${labelIST(deadlineKey)}`,
    durationLabel: `${duration} Day${duration === 1 ? "" : "s"}`,
  };
}

/** Aggregate counters for the overall dashboard (§10). */
export function practiceCounts(
  tasks: PracticeTask[],
  todayKey: string = istTodayKey()
): {
  total: number;
  active: number;
  completed: number;
  overdue: number;
} {
  let active = 0;
  let completed = 0;
  let overdue = 0;
  for (const t of tasks) {
    const s = practiceWindow(t, todayKey).status;
    if (s === "Completed") completed += 1;
    else if (s === "Overdue") overdue += 1;
    else active += 1;
  }
  return { total: tasks.length, active, completed, overdue };
}
