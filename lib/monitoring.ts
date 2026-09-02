/**
 * =====================================================================
 * PHASE 2 — GENERIC LEARNING MONITORING DATA ACCESS LAYER
 *
 * A single, task-agnostic way to read structured monitoring information
 * from the user's persisted learning state. Nothing here is hard-coded to
 * a specific topic name ("Django", "SQL", …) — it works with ANY task.
 *
 * These functions are PURE (they never mutate, never fetch) so both the
 * UI and the chatbot can call them with the same real, persisted data.
 *
 * Guidelines honoured:
 *  - No invented metrics: scores/times/days all derive from PracticeTask.
 *  - Active-time only: days & roadmaps are summed from step.practicedSeconds
 *    (breaks/pauses are NOT counted because practicedSeconds only accumulates
 *    while the timer is live).
 *  - Compact/token-efficient: buildMonitoringContext emits a tight summary
 *    (seconds, not full histories) so the chatbot never needs the whole JSON.
 *  - Evidence-based knowledge: "knowledge" derives from real scored
 *    assessments (final exam weighted with day assessments); when no scored
 *    assessment exists we return null and the caller shows "Not enough
 *    assessment data yet" — never a random confidence percentage.
 * =====================================================================
 */
import type { AssessmentAttempt, PracticeTask, RoadmapStep, TaskAssessment } from "./types";
import {
  isStepReallyComplete,
  roadmapDayNumbers,
  stepsForDay,
  taskAssessment,
  totalEstimatedMinutes,
  totalPracticedSeconds,
} from "./task-roadmap";

/** Duration formatter used across the whole app. */
export function formatMonitoringDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return s > 0 ? `${s}s` : "0m";
}

/** True when a step is both marked done AND verified by its question. */
export function stepVerified(taskStep: RoadmapStep | undefined): boolean {
  return !!taskStep && isStepReallyComplete(taskStep);
}
interface DaySummary {
  day: number;
  title: string;
  stepTotal: number;
  stepDone: number;
  estimatedMinutes: number;
  practicedSeconds: number;
  assessment?: { score: number; total: number; pct: number; passed: boolean };
  submittedAt?: number;
}

/**
 * Per-task structured monitoring. This is the "getTaskPerformance()" /
 * "getAssessmentHistory()" single source for a given task.
 */
export interface TaskMonitoring {
  taskId: string;
  name: string;
  currentDay: number;
  totalDays: number;
  completedDays: number;
  totalSteps: number;
  completedSteps: number;
  completedVerifiedSteps: number;
  currentStepNumber: number;
  estimatedMinutes: number;
  practicedSeconds: number;
  estimatedLabel: string;
  practicedLabel: string;
  earlyLateSeconds: number;
  completionPct: number;
  days: DaySummary[];
  assessment: {
    dayScores: { day: number; pct: number; passed: boolean; submittedAt: number }[];
    finalExam?: { score: number; total: number; pct: number; passed: boolean; submittedAt: number };
  };
  attempts: AssessmentAttempt[];
  knowledgePct: number | null;
  verifiedSteps: number;
  status: string;
}

/** Ordered step list (entry order == display order). */
function orderedSteps(stepPool: RoadmapStep[] | undefined): RoadmapStep[] {
  return stepPool ?? [];
}

/**
 * Resolves the task a user is referring to by NAME. Returns undefined when
 * no existing task matches — the caller must say so (Req 9/10). Case and
 * partial matches are supported.
 */
export function resolveTaskByQuery(
  tasks: PracticeTask[] | undefined,
  query: string,
): PracticeTask | undefined {
  const q = (query || "").trim().toLowerCase();
  if (!q) return undefined;
  const list = tasks ?? [];
  return (
    list.find((t) => t.name.trim().toLowerCase() === q) ??
    list.find(
      (t) =>
        t.name.trim().toLowerCase().includes(q) ||
        q.includes(t.name.trim().toLowerCase()),
    )
  );
}
/**
 * Derives the CURRENT progress day following the same sequential rule the
 * rest of the app uses: the first day (from 1) that is not yet
 * (steps-done AND assessed). Mirrors dayUnlockState's intent.
 */
function deriveCurrentDay(
  stepPool: RoadmapStep[] | undefined,
  a: TaskAssessment,
  totalDays: number,
): number {
  const steps = orderedSteps(stepPool);
  for (let d = 1; d <= totalDays; d++) {
    const daySteps = stepsForDay(steps, d);
    const done =
      daySteps.length > 0 &&
      daySteps.every((s) => s.isDone) &&
      a.completedDays.includes(d);
    if (!done) return d;
  }
  return Math.max(1, totalDays);
}

/**
 * getTaskPerformance — full, structured monitoring for ONE task, computed
 * from persisted real data only. (Also the basis of the task-local UI.)
 */
export function getTaskPerformance(
  task: PracticeTask,
): TaskMonitoring {
  const steps = orderedSteps(task.roadmap);
  const a = taskAssessment(task);
  const totalDays = Math.max(1, Math.round(task.durationDays || 1));
  const dayNumbers = roadmapDayNumbers(steps);

  const totalSteps = steps.length;
  const doneSteps = steps.filter((s) => s.isDone).length;
  const verifiedSteps = steps.filter((s) => stepVerified(s)).length;

  const estimatedMinutes = totalEstimatedMinutes(steps);
  // Active time ONLY (practicedSeconds) — pauses/breaks never counted.
  const practicedSeconds = totalPracticedSeconds(steps);
  const earlyLateSeconds = practicedSeconds - estimatedMinutes * 60;

  const currentStepNumber = (() => {
    if (totalSteps === 0) return 0;
    const idx = steps.findIndex((s) => !s.isDone);
    return idx < 0 ? totalSteps : idx + 1;
  })();

  // Per-day summaries (Req 4): AI estimate vs ACTIVE actual per day.
  const dayRows: DaySummary[] = dayNumbers
    .filter((d) => stepsForDay(steps, d).length > 0)
    .map((d) => {
      const daySteps = stepsForDay(steps, d);
      const dayScore = a.dayScores?.[String(d)];
      const firstTitle =
        daySteps[0]?.dayTitle && !/^day\s*\d/i.test(daySteps[0].dayTitle)
          ? daySteps[0].dayTitle
          : `Day ${d}`;
      return {
        day: d,
        title: firstTitle,
        stepTotal: daySteps.length,
        stepDone: daySteps.filter((s) => s.isDone).length,
        estimatedMinutes: daySteps.reduce((s2, st) => s2 + (st.estimated_minutes ?? 0), 0),
        practicedSeconds: daySteps.reduce((s2, st) => s2 + (st.practicedSeconds ?? 0), 0),
        ...(dayScore
          ? {
              assessment: {
                score: dayScore.score,
                total: dayScore.total,
                pct: dayScore.pct,
                passed: dayScore.passed,
              },
              submittedAt: dayScore.submittedAt,
            }
          : {}),
      };
    });

  const completeDayCount = dayRows.filter((r) => a.completedDays.includes(r.day)).length;
  const currentDay = deriveCurrentDay(steps, a, totalDays);

  // Evidence-based knowledge (Req 11): score final exam highest, then days.
  const finalExam = a.exam;
  const dayScoresArr = Object.values(a.dayScores ?? {}).filter(
    (v): v is NonNullable<TaskAssessment["dayScores"]>[string] =>
      !!v && typeof v.pct === "number",
  );
  const dayAvgPct =
    dayScoresArr.length > 0
      ? Math.round(dayScoresArr.reduce((s2, v) => s2 + v.pct, 0) / dayScoresArr.length)
      : null;
  const knowledgePct =
    finalExam || dayAvgPct != null
      ? finalExam
        ? Math.round(finalExam.pct * 0.6 + (dayAvgPct ?? 0) * 0.4)
        : dayAvgPct
      : null;

  // Completion % — steps (60%) + assessment coverage (40%), so checkbox
  // progress alone never reads as "knowledge" (Req 13).
  const stepPct = totalSteps > 0 ? (doneSteps / totalSteps) * 100 : 0;
  const scoredDayPct =
    dayRows.length > 0 ? (completeDayCount / Math.max(1, dayRows.length)) * 100 : 0;
  const completionPct = Math.round(stepPct * 0.6 + scoredDayPct * 0.4);

  const status =
    finalExam
      ? "completed"
      : completeDayCount >= Math.max(1, dayRows.length) && dayRows.length > 0
        ? "final_exam_required"
        : "active";

  return {
    taskId: task.id,
    name: task.name,
    currentDay,
    totalDays,
    completedDays: completeDayCount,
    totalSteps,
    completedSteps: doneSteps,
    completedVerifiedSteps: verifiedSteps,
    currentStepNumber,
    estimatedMinutes,
    practicedSeconds,
    estimatedLabel: formatMonitoringDuration(estimatedMinutes * 60),
    practicedLabel: formatMonitoringDuration(practicedSeconds),
    earlyLateSeconds,
    completionPct,
    days: dayRows,
    assessment: {
      dayScores: dayRows
        .filter((r) => r.assessment)
        .map((r) => ({
          day: r.day,
          pct: r.assessment!.pct,
          passed: r.assessment!.passed,
          submittedAt: r.submittedAt ?? 0,
        })),
      finalExam: finalExam
        ? {
            score: finalExam.score,
            total: finalExam.total,
            pct: finalExam.pct,
            passed: finalExam.passed,
            submittedAt: finalExam.submittedAt,
          }
        : undefined,
    },
    attempts: a.attempts ?? [],
    knowledgePct,
    verifiedSteps,
    status,
  };
}
/**
 * getAssessmentHistory — all persisted scored assessments for one task
 * (day scores + final exam + every immutable attempt).
 */
export function getAssessmentHistory(task: PracticeTask) {
  const perf = getTaskPerformance(task);
  return {
    taskName: task.name,
    dayScores: perf.assessment.dayScores,
    finalExam: perf.assessment.finalExam ?? null,
    attempts: perf.attempts,
  };
}

/**
 * getLearningProgress — whole-library rollup across ALL tasks. Used by the
 * chatbot for "overall progress" / cross-task comparison questions.
 */
export interface LearningProgress {
  totalTasks: number;
  completedTasks: number;
  totalDays: number;
  completedDays: number;
  totalSteps: number;
  completedSteps: number;
  totalEstimatedMinutes: number;
  totalPracticedSeconds: number;
  tasks: TaskMonitoring[];
}

export function getLearningProgress(tasks: PracticeTask[] | undefined): LearningProgress {
  const list = tasks ?? [];
  const perfs = list.map((t) => getTaskPerformance(t));
  const daysTotal = perfs.reduce((s, p) => s + p.totalDays, 0);
  const daysDone = perfs.reduce((s, p) => s + p.completedDays, 0);
  return {
    totalTasks: list.length,
    completedTasks: perfs.filter((p) => p.status === "completed").length,
    totalDays: daysTotal,
    completedDays: daysDone,
    totalSteps: perfs.reduce((s, p) => s + p.totalSteps, 0),
    completedSteps: perfs.reduce((s, p) => s + p.completedSteps, 0),
    totalEstimatedMinutes: perfs.reduce((s, p) => s + p.estimatedMinutes, 0),
    totalPracticedSeconds: perfs.reduce((s, p) => s + p.practicedSeconds, 0),
    tasks: perfs,
  };
}

/**
 * getLearningSummary — a compact, human-family summary of one task's
 * monitoring, suitable for direct embedding into a chatbot reply.
 */
export function getLearningSummary(
  task: PracticeTask,
): Record<string, unknown> {
  const p = getTaskPerformance(task);
  const scores = p.assessment.dayScores.map((d) => `${d.day}:${d.pct}%`).join(",");
  return {
    task: p.name,
    days: `${p.completedDays}/${p.totalDays}`,
    steps: `${p.completedSteps}/${p.totalSteps}`,
    verified: p.verifiedSteps,
    current_day: p.currentDay,
    estimated: p.estimatedLabel,
    actual: p.practicedLabel,
    practice_seconds: p.practicedSeconds,
    assessments: scores ? `[${scores}]` : "none",
    day_average_pct: p.assessment.dayScores.length
      ? Math.round(
          p.assessment.dayScores.reduce((s, d) => s + d.pct, 0) /
            p.assessment.dayScores.length,
        )
      : null,
    final_exam: p.assessment.finalExam
      ? `${p.assessment.finalExam.pct}%`
      : "not_completed",
    completion_pct: p.completionPct,
    knowledge_pct: p.knowledgePct,
  };
}

/**
 * buildMonitoringContext — COMPACT, token-efficient grounding for the
 * chatbot (Req 15). Emits only summary numbers, never the full roadmap or
 * full historical JSON. The inherent 6000-char cap in /api/chat is NOT hit
 * because each task yields a few short lines.
 */
export function buildMonitoringContext(
  tasks: PracticeTask[] | undefined,
): string {
  const list = tasks ?? [];
  const roll = getLearningProgress(list);
  const perTask = list.map((t) => getLearningSummary(t));
  return JSON.stringify({
    summary: {
      tasks: roll.totalTasks,
      completed_tasks: roll.completedTasks,
      days: `${roll.completedDays}/${roll.totalDays}`,
      steps: `${roll.completedSteps}/${roll.totalSteps}`,
      estimated: roll.totalEstimatedMinutes
        ? formatMonitoringDuration(roll.totalEstimatedMinutes * 60)
        : "0m",
      actual: formatMonitoringDuration(roll.totalPracticedSeconds),
      actual_seconds: roll.totalPracticedSeconds,
    },
    tasks: perTask,
  });
}