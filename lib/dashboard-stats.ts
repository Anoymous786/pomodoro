/**
 * lib/dashboard-stats.ts — pure aggregates for the OVERALL dashboard.
 *
 * The dashboard answers "how am I doing overall?" across every saved task,
 * not "what is one task doing". All metrics here derive from persisted data
 * (practiceTasks + roadmap step timers + daily activity) and never touch UI.
 */
import type { PracticeTask } from "./types";
import { practiceWindow } from "./practice";
import { istTodayKey } from "./date-ist";
import { isActiveDay } from "./activity";
import type { DayStats } from "./types";
import {
  totalEstimatedMinutes,
  totalSimSeconds,
  roadmapTimeProgress,
} from "./task-roadmap";

export interface TaskOverviewRow {
  id: string;
  name: string;
  status: string;
  /** 0-100 (roadmap-weighted; falls back to day-check-in progress). */
  progressPct: number;
  /** Practiced seconds across the task's roadmap step timers. */
  practicedSeconds: number;
  /** Estimated minutes across roadmap steps (0 = none set). */
  estimatedMinutes: number;
  /** Deadline "YYYY-MM-DD" (IST). */
  deadlineKey: string;
  /** How many roadmap steps are done vs total. */
  stepsDone: number;
  stepsTotal: number;
}

/** Seconds of real timer practice a step has accrued (live-aware). */
function stepPracticedSeconds(task: PracticeTask, nowMs: number): number {
  return totalSimSeconds(task.roadmap, nowMs);
}

/**
 * Builds a compact row for each task — used by the dashboard's "Your
 * workspaces" list and the History searchable saved-tasks list.
 */
export function taskOverview(
  tasks: PracticeTask[],
  nowMs: number = Date.now()
): TaskOverviewRow[] {
  return tasks.map((t) => {
    const w = practiceWindow(t);
    const steps = t.roadmap ?? [];
    const stepsDone = steps.filter((s) => s.isDone).length;
    const stepsTotal = steps.length;
    let progressPct = w.progressPct;
    if (stepsTotal > 0) {
      // Roadmap-weighted progress is more meaningful when steps exist.
      const doneOnly = Math.round((stepsDone / stepsTotal) * 100);
      progressPct = Math.max(doneOnly, w.progressPct);
    }
    return {
      id: t.id,
      name: t.name,
      status: w.status,
      progressPct,
      practicedSeconds: stepPracticedSeconds(t, nowMs),
      estimatedMinutes: totalEstimatedMinutes(steps),
      deadlineKey: w.deadlineKey,
      stepsDone,
      stepsTotal,
    };
  });
}

export interface DashboardStats {
  totalTasks: number;
  activeTasks: number;
  completedTasks: number;
  overdueTasks: number;
  activeRoadmaps: number;
  /** Total practiced seconds across ALL task roadmap step timers. */
  totalPracticeSeconds: number;
  /** Current day streak (passed in from computeStreaks). */
  currentStreak: number;
  practiceDays: number;
  /** Today's focus minutes — real timer activity today. */
  todayPracticeMinutes: number;
}

export function dashboardStats(
  tasks: PracticeTask[],
  history: Record<string, DayStats>,
  activeRoadmaps: number,
  currentStreak: number,
  todayStats?: DayStats,
  nowMs: number = Date.now()
): DashboardStats {
  const rows = taskOverview(tasks, nowMs);
  let totalPracticeSeconds = 0;
  let active = 0;
  let completed = 0;
  let overdue = 0;
  for (const r of rows) {
    totalPracticeSeconds += r.practicedSeconds;
    if (r.status === "Completed") completed += 1;
    else if (r.status === "Overdue") overdue += 1;
    else active += 1;
  }
  // Practice days: any day with a recorded practice signal.
  let practiceDays = 0;
  for (const k of Object.keys(history))
    if (isActiveDay(history[k])) practiceDays += 1;

  const today = todayStats ?? history[istTodayKey()];
  const todayFocusMinutes = today?.focus_minutes ?? 0;

  return {
    totalTasks: rows.length,
    activeTasks: active,
    completedTasks: completed,
    overdueTasks: overdue,
    activeRoadmaps,
    totalPracticeSeconds,
    currentStreak,
    practiceDays,
    todayPracticeMinutes: todayFocusMinutes,
  };
}