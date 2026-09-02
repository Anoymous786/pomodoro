/**
 * lib/learning-data.ts — GENERIC USER LEARNING DATA ACCESS LAYER (server).
 *
 * The chatbot's single source for a user's COMPLETE, CURRENT, PERSISTED
 * learning data. Task-agnostic by construction: discovery comes purely from
 * the caller's persisted task records, so ANY task (Zoology, Django, SaaS,
 * 5G, …) is automatically visible with zero code changes and zero hard-coded
 * names/questions.
 *
 * Design:
 *  - buildFullLearningContext(tasks) -> COMPACT structured JSON (Req 13):
 *    global summary, per-task monitoring (days/steps/time/assessments/final
 *    exam/remaining work/day titles), and dated activity derived from the
 *    real step/attempt audit timestamps (Req 6). Raw roadmaps are NEVER sent.
 *  - extractAttemptReview(tasks, query) -> on-demand per-question review
 *    (question / your answer / correct answer / correctness / explanation)
 *    for "what did I get wrong in X?" style intents (Req 5/13 — fetched on
 *    demand instead of bloating every message).
 *  - Nothing is invented: every number comes from the task record. When
 *    evidence is missing, the field is null / "not_completed" / "unknown"
 *    and the model is instructed to say so (Req 7).
 */
import type { PracticeTask } from "./types";
import {
  formatMonitoringDuration,
  getLearningProgress,
  getLearningSummary,
  resolveTaskByQuery,
} from "./monitoring";
import { roadmapDayNumbers } from "./task-roadmap";

/** "YYYY-MM-DD" (local) for an epoch-ms timestamp — used to bucket activity. */
function dateKeyOf(epochMs: number): string {
  try {
    return new Date(epochMs).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

/** Short human date ("2026-09-01") for task creation/start fields. */
function dateLabel(epochMs: number | undefined): string | null {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs) || epochMs <= 0) {
    return null;
  }
  return dateKeyOf(epochMs);
}

interface ActivityEvent {
  at: string;
  task: string;
  kind:
    | "step_started"
    | "step_completed"
    | "day_assessment_completed"
    | "day_assessment_interrupted"
    | "final_exam_completed"
    | "final_exam_interrupted";
  detail: string;
}

/** Collects real, timestamped activity events from one task's audit trail. */
function activityForTask(task: PracticeTask): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const name = task.name;
  for (const s of task.roadmap ?? []) {
    if (typeof s.firstStartedAt === "number" && s.firstStartedAt > 0) {
      const at = dateKeyOf(s.firstStartedAt);
      if (at) {
        events.push({
          at,
          task: name,
          kind: "step_started",
          detail: `started step "${s.title}"`,
        });
      }
    }
    if (typeof s.completedAt === "number" && s.completedAt > 0 && s.isDone) {
      const at = dateKeyOf(s.completedAt);
      if (at) {
        const actual =
          typeof s.actual_minutes === "number" && s.actual_minutes > 0
            ? ` in ${formatMonitoringDuration(s.actual_minutes * 60)}`
            : "";
        events.push({
          at,
          task: name,
          kind: "step_completed",
          detail: `completed step "${s.title}"${actual}`,
        });
      }
    }
  }
  for (const a of task.assessment?.attempts ?? []) {
    const at = dateKeyOf(a.submittedAt);
    if (!at) continue;
    if (a.attemptState === "interrupted") {
      events.push({
        at,
        task: name,
        kind: a.kind === "exam" ? "final_exam_interrupted" : "day_assessment_interrupted",
        detail: `${a.kind === "exam" ? "final exam" : `Day ${a.day} assessment`} attempt ${a.attempt} interrupted`,
      });
    } else {
      events.push({
        at,
        task: name,
        kind: a.kind === "exam" ? "final_exam_completed" : "day_assessment_completed",
        detail: `${a.kind === "exam" ? "final exam" : `Day ${a.day} assessment`} attempt ${a.attempt} scored ${a.score}/${a.total} (${a.pct}%)`,
      });
    }
  }
  return events;
}
export interface FullLearningContext {
  summary: {
    tasks: number;
    completed_tasks: number;
    assessments_taken: number;
    exams_taken: number;
    days: string;
    steps: string;
    estimated: string;
    actual: string;
  };
  /** Per-task compact monitoring — works for ANY task name (Req 2). */
  tasks: Record<string, unknown>[];
  /** Dated real activity (Req 6) — newest last, capped. */
  recent_activity: ActivityEvent[];
  /** On-demand question review (Req 5); present only when relevant. */
  review_context?: Record<string, unknown>;
}

/** Max step rows per task in the compact context (token budget guard). */
const MAX_STEPS_IN_CONTEXT = 25;
/** Max review questions attached on demand. */
const MAX_REVIEW_ITEMS = 12;

/**
 * Builds the COMPACT structured learning context over the user's FULL
 * persisted task list. Every task present in `tasks` is discoverable —
 * including one created seconds ago (no cache, no snapshot, Req 8/14).
 */
export function buildFullLearningContext(
  tasks: PracticeTask[],
  review?: Record<string, unknown>,
): FullLearningContext {
  const list = tasks ?? [];
  const roll = getLearningProgress(list);
  const perTask = list.map((t) => {
    const s = getLearningSummary(t) as Record<string, unknown>;
    const p = roll.tasks.find((x) => x.taskId === t.id);
    const dayNumbers = roadmapDayNumbers(t.roadmap);
    const daysRows = (p?.days ?? []).map((d) => ({
      day: d.day,
      title: d.title.slice(0, 60),
      est: d.estimatedMinutes,
      act_min: Math.round(d.practicedSeconds / 60),
      done: d.stepDone,
      steps: d.stepTotal,
      assessed: !!d.assessment,
      pct: d.assessment?.pct ?? null,
    }));
    // Compact per-step timing rows (Req 3): "title|est|act|done".
    const stepRows = (t.roadmap ?? [])
      .slice(0, MAX_STEPS_IN_CONTEXT)
      .map((st) => ({
        t: st.title.slice(0, 48),
        day: st.dayNumber ?? 1,
        est: st.estimated_minutes ?? 0,
        act: Math.round((st.practicedSeconds ?? 0) / 60),
        done: !!st.isDone,
        verified: !!(st.checkIn && !st.checkIn.skipped && st.isDone),
        started: typeof st.firstStartedAt === "number" ? dateKeyOf(st.firstStartedAt) : null,
        finished: typeof st.finishedAt === "number" ? dateKeyOf(st.finishedAt) : null,
      }));
    const attempts = t.assessment?.attempts ?? [];
    const dayAttempts = attempts.filter((a) => a.kind === "day").length;
    const examAttempts = attempts.filter((a) => a.kind === "exam").length;
    return {
      ...s,
      id: t.id,
      description: t.description ?? null,
      created: dateLabel(t.createdAt),
      start_date: t.startDate,
      deadline: deadlineOf(t),
      status: p?.status ?? "active",
      total_days_planned: t.durationDays,
      roadmap_days_present: dayNumbers.length,
      current_day: p?.currentDay ?? 1,
      locked_days: Math.max(0, (p?.totalDays ?? 1) - (p?.completedDays ?? 0)),
      remaining_steps: Math.max(0, (p?.totalSteps ?? 0) - (p?.completedSteps ?? 0)),
      day_assessment_attempts: dayAttempts,
      final_exam_attempts: examAttempts,
      interrupted_attempts: attempts.filter((a) => a.attemptState === "interrupted").length,
      // NOTE: `days`/`steps` (compact "1/2" strings from the summary) are
      // kept intact — detailed rows use distinct names so nothing collides.
      day_rows: daysRows,
      step_rows: stepRows,
    };
  });

  const assessmentsTaken = list.reduce(
    (n, t) => n + (t.assessment?.attempts ?? []).filter((a) => a.kind === "day" && a.attemptState !== "interrupted").length,
    0,
  );
  const examsTaken = list.reduce(
    (n, t) => n + (t.assessment?.attempts ?? []).filter((a) => a.kind === "exam" && a.attemptState !== "interrupted").length,
    0,
  );

  const activity = list
    .flatMap(activityForTask)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .slice(-60);

  const out: FullLearningContext = {
    summary: {
      tasks: roll.totalTasks,
      completed_tasks: roll.completedTasks,
      assessments_taken: assessmentsTaken,
      exams_taken: examsTaken,
      days: `${roll.completedDays}/${roll.totalDays}`,
      steps: `${roll.completedSteps}/${roll.totalSteps}`,
      estimated: formatMonitoringDuration(roll.totalEstimatedMinutes * 60),
      actual: formatMonitoringDuration(roll.totalPracticedSeconds),
    },
    tasks: perTask,
    recent_activity: activity,
  };
  if (review) out.review_context = review;
  return out;
}

/** Deadline = startDate + durationDays (IST plan window). */
function deadlineOf(task: PracticeTask): string | null {
  try {
    const d = new Date(`${task.startDate}T00:00:00+05:30`);
    if (Number.isNaN(d.getTime())) return null;
    d.setUTCDate(d.getUTCDate() + Math.max(1, task.durationDays));
    return d.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}
/**
 * extractAttemptReview — ON-DEMAND per-question review (Req 5/13).
 *
 * Resolves the task the user is asking about (by name, generic — no
 * hard-coded names), finds the best-matching persisted attempt (optionally
 * filtered by kind/day/attempt numbers found in the free-text query), and
 * returns the real question / user's answer / correct answer / correctness
 * / explanation rows. When nothing matches, returns { found: false, ... }
 * with the available task names so the model answers honestly instead of
 * guessing.
 */
export function extractAttemptReview(
  tasks: PracticeTask[],
  query: string,
): {
  found: boolean;
  task?: string;
  reason?: string;
  available_tasks?: string[];
  questions?: unknown[];
  attempt?: { kind: string; day: number | null; attempt: number; pct: number };
} {
  const q = (query || "").toLowerCase();

  // Only engage for review-ish intents; otherwise skip entirely (compact).
  const reviewish =
    /(wrong|incorrect|mistake|missed|review|explain|explanation|which (question|answer)|got (right|correct)|answer(ed)?)/.test(q) ||
    /exam|assessment|test|quiz|final/.test(q);
  if (!reviewish) return { found: false, reason: "not a review question" };

  // Resolve the task generically by name mention.
  const all = tasks ?? [];
  let target: PracticeTask | undefined;
  for (const t of all) {
    const n = t.name.trim().toLowerCase();
    if (n.length >= 3 && q.includes(n)) {
      target = t;
      break;
    }
  }
  if (!target) {
    // Fall back to the first task that has any attempts when the user asks
    // generically ("what did I get wrong?").
    target = all.find((t) => (t.assessment?.attempts ?? []).length > 0);
    if (!target) {
      return {
        found: false,
        reason: "no completed assessments or exams found",
        available_tasks: all.map((t) => t.name),
      };
    }
  }

  const attempts = target.assessment?.attempts ?? [];
  const completed = attempts.filter((a) => a.attemptState !== "interrupted");

  // Prefer the final exam when the user says exam/final, else the latest day.
  const wantsExam = /exam|final/.test(q);
  const dayMatch = /\bday\s*(\d+)/.exec(q);
  let pick = undefined as (typeof completed)[number] | undefined;
  if (wantsExam) pick = [...completed].reverse().find((a) => a.kind === "exam");
  else if (dayMatch) {
    const d = Number(dayMatch[1]);
    pick = [...completed].reverse().find((a) => a.kind === "day" && a.day === d);
  }
  if (!pick) pick = [...completed].reverse().find((a) => (wantsExam ? a.kind === "exam" : a.kind === "day"));
  if (!pick) pick = completed[completed.length - 1];
  if (!pick) {
    return {
      found: false,
      task: target.name,
      reason: "no completed attempts for this task yet",
      available_tasks: all.map((t) => t.name),
    };
  }

  const reviewRows =
    pick.questionReview && pick.questionReview.length > 0
      ? pick.questionReview
      : (pick.questions ?? []).map((qq) => ({
          id: qq.id,
          prompt: qq.prompt,
          selectedAnswer: pick.answers?.[qq.id] ?? "(no answer)",
          correctAnswer: pick.correctAnswers?.[qq.id] ?? "",
          correct: pick.answers?.[qq.id] === pick.correctAnswers?.[qq.id],
          explanation: pick.explanations?.[qq.id],
        }));

  const wrong = reviewRows.filter((r) => !r.correct);
  const rows = (wrong.length > 0 && /wrong|incorrect|mistake|missed/.test(q) ? wrong : reviewRows)
    .slice(0, MAX_REVIEW_ITEMS)
    .map((r) => ({
      question: r.prompt,
      your_answer: r.selectedAnswer,
      correct_answer: r.correctAnswer,
      correct: r.correct,
      explanation: r.explanation ?? null,
    }));

  return {
    found: true,
    task: target.name,
    attempt: { kind: pick.kind, day: pick.day ?? null, attempt: pick.attempt, pct: pick.pct },
    questions: rows,
  };
}