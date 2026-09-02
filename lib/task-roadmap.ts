/**
 * Task + Roadmap architecture — pure business logic for task-owned roadmaps.
 *
 * A task's roadmap is an ORDERED list of RoadmapStep values embedded in the
 * task object itself (see PracticeTask.roadmap). Because steps live inside
 * exactly one task, two tasks can never share roadmap data — isolation is
 * guaranteed by construction rather than by convention.
 *
 * Array order IS the display order ("Step 1", "Step 2", …); reordering is a
 * plain array move. All functions here are pure and unit-testable.
 */
import type {
  ExamQuestion,
  PracticeTask,
  RoadmapStep,
  StepSource,
  TaskAssessment,
  TaskExamResult,
  TimingOutcome,
} from "./types";

/** Generates a unique step id (same fallback pattern as lib/storage.ts). */
function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const SOURCE_TYPES = new Set(["docs", "article", "video"]);

/**
 * Validates/clamps an unknown value into a clean StepSource[] so hand-edited
 * localStorage or a misbehaving LLM can never inject broken links into the
 * UI. Only https/http URLs survive; everything else is dropped.
 */
export function normalizeSources(raw: unknown): StepSource[] {
  if (!Array.isArray(raw)) return [];
  const out: StepSource[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const title =
      typeof r.title === "string" && r.title.trim()
        ? r.title.trim().slice(0, 160)
        : "";
    const urlRaw = typeof r.url === "string" ? r.url.trim() : "";
    let url = "";
    try {
      const parsed = new URL(urlRaw);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        url = parsed.toString();
      }
    } catch {
      url = "";
    }
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    const channel =
      typeof r.channel === "string" && r.channel.trim()
        ? r.channel.trim().slice(0, 80)
        : undefined;
    out.push({
      // Default to "docs"; anything unrecognized falls back safely.
      type:
        typeof r.type === "string" && SOURCE_TYPES.has(r.type)
          ? (r.type as StepSource["type"])
          : "docs",
      title,
      url,
      ...(channel ? { channel } : {}),
    });
  }
  return out.slice(0, 8); // plenty; keeps payloads small
}

/**
 * Default per-step estimate (minutes) applied to manually added steps and
 * AI steps that arrived without one, so Start is always enabled
 * (requirement 4: time must not require the pencil/edit button first).
 */
export const DEFAULT_STEP_MINUTES = 25;

/** Creates a fresh, not-done step. Trims and caps lengths defensively. */
export function makeStep(
  title: string,
  note?: string,
  opts?: {
    dayNumber?: number;
    dayTitle?: string;
    sources?: StepSource[];
    /** Default estimate so Start works without the pencil (req 4). */
    estimatedMinutes?: number;
  }
): RoadmapStep {
  const step: RoadmapStep = {
    id: uid(),
    title: title.trim().slice(0, 160),
    isDone: false,
    practicedSeconds: 0,
    elapsedSeconds: 0,
    timerStatus: "idle",
  };
  const cleanNote = note?.trim();
  if (cleanNote) step.note = cleanNote.slice(0, 400);
  if (opts?.dayNumber && opts.dayNumber > 0) {
    const day = Math.floor(opts.dayNumber);
    if (Number.isFinite(day)) step.dayNumber = day;
  }
  const cleanDayTitle = opts?.dayTitle?.trim();
  if (cleanDayTitle) step.dayTitle = cleanDayTitle.slice(0, 160);
  const est =
    typeof opts?.estimatedMinutes === "number" && opts.estimatedMinutes > 0
      ? Math.floor(opts.estimatedMinutes)
      : DEFAULT_STEP_MINUTES; // Start must work with no pencil needed
  if (est > 0) step.estimated_minutes = est;
  if (Array.isArray(opts?.sources) && opts.sources.length) {
    step.sources = normalizeSources(opts.sources);
  }
  return step;
}

/**
 * Normalizes an unknown parsed value into a valid RoadmapStep[] so older or
 * hand-edited localStorage payloads can never crash the UI. Timer/time fields
 * are defaulted so every step has a working timer regardless of when it was
 * created.
 */
export function normalizeRoadmap(raw: unknown): RoadmapStep[] {
  if (!Array.isArray(raw)) return [];
  const out: RoadmapStep[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const title =
      typeof r.title === "string" && r.title.trim() ? r.title.trim() : null;
    if (!title) continue;
    const note =
      typeof r.note === "string" && r.note.trim()
        ? r.note.trim().slice(0, 400)
        : undefined;

    const isDone = r.isDone === true;
    // Estimated time in minutes; only accept positive finite numbers.
    const est =
      typeof r.estimated_minutes === "number" &&
      Number.isFinite(r.estimated_minutes) &&
      r.estimated_minutes > 0
        ? r.estimated_minutes
        : undefined;

    const practicedSeconds =
      typeof r.practicedSeconds === "number" &&
      Number.isFinite(r.practicedSeconds) &&
      r.practicedSeconds > 0
        ? Math.floor(r.practicedSeconds)
        : 0;
    const elapsedSeconds =
      typeof r.elapsedSeconds === "number" &&
      Number.isFinite(r.elapsedSeconds) &&
      r.elapsedSeconds > 0
        ? Math.floor(r.elapsedSeconds)
        : 0;

    // Timer must always reflect a consistent persisted snapshot. A step that
    // was mid-run when saved must not keep "running" forever on reload, so a
    // saved running/paused timer folds its elapsedSeconds into practiced and
    // resets to a clean idle (or finished) state.
    const rawTimerStatus =
      typeof r.timerStatus === "string" ? r.timerStatus : "idle";
    const timerStatus: RoadmapStep["timerStatus"] =
      rawTimerStatus === "finished" ? "finished" : "idle";
    // Seconds the run accumulated while it was live; fold into practiced.
    const carried =
      timerStatus === "idle" &&
      (rawTimerStatus === "running" || rawTimerStatus === "paused")
        ? elapsedSeconds
        : 0;

    const dayNumber =
      typeof r.dayNumber === "number" &&
      Number.isFinite(r.dayNumber) &&
      r.dayNumber > 0
        ? Math.floor(r.dayNumber)
        : undefined;
    const dayTitle =
      typeof r.dayTitle === "string" && r.dayTitle.trim()
        ? r.dayTitle.trim().slice(0, 160)
        : undefined;
    const sources = normalizeSources(r.sources);

    const isFinished = timerStatus === "finished";

    // Phase C/D: per-step timing + exam metadata survive reloads (scoped to
    // this exact step — never merged into the global dashboard).
    const timingRaw =
      isFinished && r.timingRecord && typeof r.timingRecord === "object"
        ? (r.timingRecord as Record<string, unknown>)
        : null;
    const examRaw =
      r.exam && typeof r.exam === "object"
        ? (r.exam as Record<string, unknown>)
        : null;

    out.push({
      id: typeof r.id === "string" && r.id ? r.id : uid(),
      title: title.slice(0, 160),
      ...(note ? { note } : {}),
      ...(dayNumber ? { dayNumber } : {}),
      ...(dayTitle ? { dayTitle } : {}),
      isDone,
      ...(est ? { estimated_minutes: est } : {}),
      practicedSeconds: practicedSeconds + carried,
      elapsedSeconds: 0,
      timerStatus,
      // WORKFLOW AUDIT TRAIL (req §4): real timer timestamps survive reloads.
      ...(typeof r.firstStartedAt === "number" && r.firstStartedAt > 0
        ? { firstStartedAt: r.firstStartedAt }
        : {}),
      ...(typeof r.finishedAt === "number" && r.finishedAt > 0
        ? { finishedAt: r.finishedAt }
        : {}),
      ...(typeof r.pauseCount === "number" && r.pauseCount > 0
        ? { pauseCount: Math.floor(r.pauseCount) }
        : {}),
      ...(typeof r.lastPausedAt === "number" && r.lastPausedAt > 0
        ? { lastPausedAt: r.lastPausedAt }
        : {}),
      ...(sources.length ? { sources } : {}),
      // Phase C/D/E: carry per-step timing, exam, and search metadata across
      // reloads (scoped to this exact step — never merged into the global
      // dashboard).
      ...(isFinished && typeof r.actual_minutes === "number"
        ? { actual_minutes: Math.max(0, Math.floor(r.actual_minutes)) }
        : {}),
      ...(r.timing_outcome === "early" ||
      r.timing_outcome === "on-time" ||
      r.timing_outcome === "late"
        ? { timing_outcome: r.timing_outcome }
        : {}),
      ...(timingRaw
        ? {
            timingRecord: {
              estimated_minutes:
                typeof timingRaw.estimated_minutes === "number"
                  ? timingRaw.estimated_minutes
                  : (est ?? 25),
              actual_minutes:
                typeof timingRaw.actual_minutes === "number"
                  ? timingRaw.actual_minutes
                  : 0,
              timing_outcome:
                timingRaw.timing_outcome === "early" ||
                timingRaw.timing_outcome === "on-time" ||
                timingRaw.timing_outcome === "late"
                  ? timingRaw.timing_outcome
                  : "on-time",
              completedAt:
                typeof timingRaw.completedAt === "number"
                  ? timingRaw.completedAt
                  : Date.now(),
            },
          }
        : {}),
      ...(examRaw
        ? {
            exam: {
              stepName:
                typeof examRaw.stepName === "string"
                  ? examRaw.stepName.slice(0, 160)
                  : title,
              questions: Array.isArray(examRaw.questions)
                ? (examRaw.questions as ExamQuestion[])
                : [],
              createdAt:
                typeof examRaw.createdAt === "number"
                  ? examRaw.createdAt
                  : Date.now(),
            },
          }
        : {}),
      ...(r.examResult && typeof r.examResult === "object"
        ? { examResult: r.examResult as TaskExamResult }
        : {}),
      ...(typeof r.search === "string" && r.search.trim()
        ? { search: r.search.trim().slice(0, 200) }
        : {}),
    });
  }
  return out;
}

export interface RoadmapProgress {
  done: number;
  total: number;
  /** 0-100 rounded percentage of completed steps. */
  pct: number;
}

/** Completion stats for a task's roadmap (drives the progress bar). */
export function roadmapProgress(steps: RoadmapStep[] | undefined): RoadmapProgress {
  const total = steps?.length ?? 0;
  const done = steps?.filter((s) => s.isDone).length ?? 0;
  return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
}

/** Direction for moveRoadmapStep. */
export type MoveDirection = -1 | 1;

/**
 * Moves a step up (-1) or down (+1) one position. Returns a NEW array;
 * returns the original array untouched when the move is out of bounds.
 */
export function moveRoadmapStep(
  steps: RoadmapStep[],
  stepId: string,
  direction: MoveDirection
): RoadmapStep[] {
  const index = steps.findIndex((s) => s.id === stepId);
  if (index < 0) return steps;
  const target = index + direction;
  if (target < 0 || target >= steps.length) return steps;
  const next = [...steps];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

/**
 * Maps an AI-generated roadmap (the same shape /api/generate-roadmap has
 * always returned) onto THIS task's own steps.
 *
 * Requirement §2 — DAY → MULTIPLE STEPS: every day's `tasks[]` is flattened
 * into one distinct RoadmapStep PER task (never one collapsed step per day).
 * Each step keeps its plan-day number, its OWN estimated_minutes, and
 * inherits the day's curated references + search as ITS OWN study sources
 * (requirement §1: resources must match the exact step/topic, never a
 * generic shared list). Leading item markers ("3. ", "- ", "• ") are
 * stripped from task names so a step reads naturally.
 */
export function stepsFromGeneratedDays(
  days:
    | {
        day_number?: number;
        day_title?: string;
        tasks?: {
          name?: string;
          estimated_minutes?: number;
          priority?: string;
          reason?: string;
        }[];
        estimated_minutes?: number;
        references?: unknown;
        /** Phase E: per-day suggested search mapped onto the step. */
        search?: string;
      }[]
    | undefined
): RoadmapStep[] {
  if (!Array.isArray(days)) return [];
  const DAY_PREFIX = /^day\s*\d+\s*[:.\u2013\u2014-]\s*/i;
  const ITEM_PREFIX = /^(?:\d+[.)\]]\s*|[-*\u2022]\s+)+/;
  const out: RoadmapStep[] = [];

  for (const day of days) {
    const rawTitle =
      typeof day?.day_title === "string" ? day.day_title.trim() : "";
    if (!rawTitle) continue;
    const dayTitle = rawTitle.replace(DAY_PREFIX, "").trim().slice(0, 160);
    if (!dayTitle) continue;
    const dayNum =
      typeof day?.day_number === "number" && Number.isFinite(day.day_number)
        ? Math.max(1, Math.floor(day.day_number))
        : out.length + 1;

    const tasks = Array.isArray(day.tasks) ? day.tasks : [];
    // The day's curated references/search — every step on this day inherits
    // them as its own sources (they cover the day's subtopics).
    const sources = normalizeSources(day.references);
    const search =
      typeof day?.search === "string" && day.search.trim()
        ? day.search.trim().slice(0, 200)
        : undefined;
    // Fallback day-level estimate (day total) for tasks that omitted one.
    const dayEst =
      typeof day?.estimated_minutes === "number" &&
      Number.isFinite(day.estimated_minutes) &&
      day.estimated_minutes > 0
        ? Math.floor(day.estimated_minutes)
        : undefined;

    if (tasks.length === 0) {
      // Legacy one-topic-per-day fallback: keep a standalone step so the day
      // never renders empty, and give it the day's whole estimate.
      const step = makeStep(dayTitle, undefined, { dayNumber: dayNum, dayTitle, sources });
      if (search) step.search = search;
      if (dayEst) step.estimated_minutes = dayEst;
      out.push(step);
      continue;
    }

    tasks.forEach((taskRaw, idx) => {
      let name = typeof taskRaw?.name === "string" ? taskRaw.name.trim() : "";
      name = name.replace(ITEM_PREFIX, "").trim();
      if (!name) return;
      const taskEst =
        typeof taskRaw?.estimated_minutes === "number" &&
        Number.isFinite(taskRaw.estimated_minutes) &&
        taskRaw.estimated_minutes > 0
          ? Math.floor(taskRaw.estimated_minutes)
          : undefined;
      // Estimate: per-task first, else the day total split evenly, else a
      // positional default. EVERY step must carry an estimate so Start works
      // immediately (requirements §4/§5 — no pencil/edit required first).
      const est =
        taskEst ??
        (dayEst
          ? Math.max(10, Math.floor(dayEst / tasks.length))
          : defaultStepEstimate(idx));
      const reason =
        typeof taskRaw?.reason === "string" ? taskRaw.reason.trim() : "";
      const step = makeStep(name, reason ? reason.slice(0, 400) : undefined, {
        dayNumber: dayNum,
        dayTitle,
        sources,
      });
      step.estimated_minutes = est;
      if (search) step.search = search;
      out.push(step);
    });
  }
  return out;
}

/** Positional per-step estimate fallback (minutes) when nothing else is set. */
function defaultStepEstimate(index: number): number {
  // Realistic defaults: ~30-55 min per concrete practice step; deeper steps
  // in a day get slightly more time. Never below 10 minutes.
  return Math.min(60, Math.max(10, 30 + index * 5));
}

// =====================================================================
// Time tracking helpers (pure — safe to use in any component/test).
// All durations stored in SECONDS on the step; estimates in MINUTES.
// =====================================================================

/** Total ESTIMATED minutes across a task's steps. */
export function totalEstimatedMinutes(steps: RoadmapStep[] | undefined): number {
  return (steps ?? []).reduce(
    (sum, s) => sum + (s.estimated_minutes ?? 0),
    0
  );
}

/** Total PRACTICED seconds across a task's steps. */
export function totalPracticedSeconds(steps: RoadmapStep[] | undefined): number {
  return (steps ?? []).reduce((sum, s) => sum + (s.practicedSeconds ?? 0), 0);
}

/** Effective practiced seconds for ONE step, including its live run. */
export function stepSimSeconds(
  step: RoadmapStep | undefined,
  nowMs: number = Date.now()
): number {
  if (!step) return 0;
  if (step.timerStatus === "running" && typeof step.startedAt === "number") {
    return step.practicedSeconds + Math.max(0, Math.round((nowMs - step.startedAt) / 1000));
  }
  return step.practicedSeconds + step.elapsedSeconds;
}

/**
 * Effective total practiced seconds INCLUDING any live running step, so the
 * counter visibly ticks up while a timer is running.
 */
export function totalSimSeconds(
  steps: RoadmapStep[] | undefined,
  nowMs: number = Date.now()
): number {
  return (steps ?? []).reduce((sum, s) => sum + stepSimSeconds(s, nowMs), 0);
}

/** Remaining seconds = total estimated (minutes*60) − practiced, floor 0. */
export function totalRemainingSeconds(
  steps: RoadmapStep[] | undefined,
  nowMs: number = Date.now()
): number {
  const estTotal = totalEstimatedMinutes(steps) * 60;
  return Math.max(0, estTotal - totalSimSeconds(steps, nowMs));
}

/**
 * Weighed progress (0-100) — the "Progress: X%" shown in the task workspace.
 * Primary weight is STEP COMPLETION (done/total), matching the roadmap
 * example ("2 of 5 done => 40%"). A time bonus (practiced vs estimated,
 * up to +25%) nudges the bar so sustained practice moves progress even
 * before a step is ticked off. When there are no estimates yet, the bonus
 * is zero.
 */
export function roadmapTimeProgress(
  steps: RoadmapStep[] | undefined,
  nowMs: number = Date.now()
): { done: number; total: number; pct: number } {
  const pool = steps ?? [];
  const total = pool.length;
  const done = pool.filter((s) => s.isDone).length;
  if (total === 0) return { done: 0, total: 0, pct: 0 };

  const estTotalMin = totalEstimatedMinutes(pool);
  const practicedSec = totalSimSeconds(pool, nowMs);
  const completionPct = Math.round((done / total) * 100);
  const timeBonus =
    estTotalMin > 0
      ? Math.min(25, (practicedSec / (estTotalMin * 60)) * 25)
      : 0;
  return { done, total, pct: Math.min(100, completionPct + Math.round(timeBonus)) };
}

/**
 * Formats a duration (in seconds) as a compact "Hh Mm" string, e.g.
 * 7650 => "2h 7m", 2700 => "45m", 30 => "30s", 0 => "0m". Used for the
 * summary strip and per-step practiced/remaining badges.
 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return s > 0 ? `${s}s` : "0m";
}

/** Parses a free-form hours/minutes string into MINUTES. */
export function parseDurationInput(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n > 0 ? n : null; // bare number = minutes
  }
  const m = text.match(/^(\d+)\s*h(?:rs?|ours?)?(?:\s*(\d+)\s*m(?:ins?)?)?$|^(\d+)\s*m(?:in)?$/);
  if (!m) return null;
  if (m[1] !== undefined) {
    const h = Number(m[1]);
    const min = m[2] !== undefined ? Number(m[2]) : 0;
    const total = h * 60 + min;
    return total > 0 ? total : null;
  }
  if (m[3] !== undefined) {
    const min = Number(m[3]);
    return min > 0 ? min : null;
  }
  return null;
}

/** Formats MINUTES as "2h" / "45m" / "1h 30m" for per-step display. */
export function formatEstimated(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  if (m <= 0) return "";
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h > 0) return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
  return `${m}m`;
}

/** Short clock "00:00:00" / "00:12:34" for the running timer face. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${two(h)}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}

/* ============================================================
 * DERIVED DAY COMPLETION (requirement §4)
 * A day is NEVER marked complete by hand. It is complete when
 * every roadmap step assigned to that day is done.
 * ============================================================ */

/** All plan-day numbers present across a task's steps, ascending. */
export function roadmapDayNumbers(
  steps: RoadmapStep[] | undefined
): number[] {
  const set = new Set<number>();
  for (const s of steps ?? []) set.add(s.dayNumber ?? 1);
  return Array.from(set).sort((a, b) => a - b);
}

/** Steps scheduled on one plan day (steps without a day count as Day 1). */
export function stepsForDay(
  steps: RoadmapStep[] | undefined,
  dayNumber: number
): RoadmapStep[] {
  return (steps ?? []).filter((s) => (s.dayNumber ?? 1) === dayNumber);
}

/** DERIVED: a day is complete only when ALL its steps are done. */
export function isDayComplete(
  steps: RoadmapStep[] | undefined,
  dayNumber: number
): boolean {
  const daySteps = stepsForDay(steps, dayNumber);
  if (daySteps.length === 0) return false;
  return daySteps.every((s) => s.isDone);
}

/** All day numbers whose steps are all done (derived, ascending). */
export function completedDayNumbers(steps: RoadmapStep[] | undefined): number[] {
  return roadmapDayNumbers(steps).filter((d) => isDayComplete(steps, d));
}

/**
 * §4 + §5 auto-completion sync.
 *
 * Returns the canonical list of completed day-numbers (1..durationDays)
 * derived purely from which steps are done. A day counts as completed even
 * before its scheduled date arrives if its steps are all finished, and a
 * step with no dayNumber is treated as belonging to Day 1 (the only day
 * present for tasks created without an explicit roadmap layout).
 *
 * `existing` carries previously auto-completed days so we never lose
 * completed days when intermediate steps are re-opened (un-done). The union
 * of existing-completed and newly-completed days is returned.
 */
export function syncCompletedDays(
  steps: RoadmapStep[] | undefined,
  _existing: number[] = []
): number[] {
  const prefix: number[] = [];
  for (const d of roadmapDayNumbers(steps)) {
    if (d !== prefix.length + 1) break; // must be consecutive from day 1
    if (!isDayComplete(steps, d)) break;
    prefix.push(d);
  }
  return prefix;
}

/* ============================================================
 * PART 2 — Day Assessment gating + server-authoritative day locks
 * ============================================================ */

/** PART 2 §2: the day-assessment attempt size (10-12 questions). */
export const DAY_ASSESSMENT_MIN = 10;
export const DAY_ASSESSMENT_MAX = 12;
/** PART 2 §6: the final task exam size (20-25 questions). */
export const EXAM_MIN_QUESTIONS = 20;
export const EXAM_MAX_QUESTIONS = 25;

/**
 * The task's assessment record with all optional fields normalized so UI +
 * tests can rely on arrays/objects always existing.
 */
export function taskAssessment(task: PracticeTask): TaskAssessment {
  return {
    completedDays: task.assessment?.completedDays ?? [],
    dayScores: task.assessment?.dayScores ?? {},
    attempts: task.assessment?.attempts ?? [],
    exam: task.assessment?.exam,
    examDraft: task.assessment?.examDraft,
    dayQuestions: task.assessment?.dayQuestions,
    finalQuestions: task.assessment?.finalQuestions,
    interruptedAttempt: task.assessment?.interruptedAttempt,
  };
}

/** True when the Day Assessment for `dayNumber` has been submitted. */
export function isDayAssessed(task: PracticeTask, dayNumber: number): boolean {
  return taskAssessment(task).completedDays.includes(dayNumber);
}

/**
 * PART 2 §3/§13 — the SERVER- AUTHORITATIVE day unlock rule.
 *
 * A day is unlocked only when EVERY previous day has BOTH:
 *   1. all of its steps genuinely done, AND
 *   2. its Day Assessment submitted.
 *
 * This single pure function drives the UI lock AND the backend transition
 * validation, so a patched localStorage flag or a hand-crafted API call
 * cannot unlock a day that the learning flow has not earned.
 */
export function dayUnlockState(
  task: PracticeTask,
  _todayKey?: string
): { currentDay: number; isUnlocked: (day: number) => boolean } {
  const totalDays = Math.max(1, Math.round(task.durationDays));
  const steps = task.roadmap ?? [];
  const a = taskAssessment(task);
  const isUnlocked = (day: number): boolean => {
    if (day <= 1) return true; // Day 1 is always open
    for (let d = 1; d < day; d++) {
      const daySteps = steps.filter((s) => (s.dayNumber ?? 1) === d);
      // A scheduled day with NO steps cannot be a gate (nothing to learn
      // or assess there) — but a day WITH steps must be fully done AND
      // assessed before the next day opens.
      if (daySteps.length > 0) {
        if (!daySteps.every((s) => s.isDone)) return false;
        if (!a.completedDays.includes(d)) return false;
      }
    }
    return true;
  };
  // The "current" day = the first day that is unlocked but not yet fully
  // done+assessed; falls back to the last day once everything is complete.
  let currentDay = totalDays;
  for (let d = 1; d <= totalDays; d++) {
    const daySteps = steps.filter((s) => (s.dayNumber ?? 1) === d);
    const done =
      daySteps.length === 0 ||
      (daySteps.every((s) => s.isDone) && a.completedDays.includes(d));
    if (isUnlocked(d) && !done) {
      currentDay = d;
      break;
    }
  }
  return { currentDay, isUnlocked };
}

/**
 * PART 2 §5/§7 — the FINAL EXAM gate. The exam section becomes available
 * only when EVERY day in the roadmap is both step-complete and assessed.
 */
export function examGate(task: PracticeTask): {
  available: boolean;
  missingDays: number[];
} {
  const steps = task.roadmap ?? [];
  const days = roadmapDayNumbers(steps);
  const a = taskAssessment(task);
  const missingDays: number[] = [];
  for (const d of days) {
    const daySteps = steps.filter((s) => (s.dayNumber ?? 1) === d);
    if (daySteps.length === 0) continue;
    if (!daySteps.every((s) => s.isDone) || !a.completedDays.includes(d)) {
      missingDays.push(d);
    }
  }
  return { available: missingDays.length === 0 && days.length > 0, missingDays };
}

/* ============================================================
 * PART 2 §3/§5 — explicit exam-gating predicates (server-authoritative).
 *
 * These are the SINGLE source of truth for "may this exam be STARTED or
 * SUBMITTED?". They are pure functions over persisted task data, so a
 * hand-crafted API call / patched localStorage flag cannot unlock an exam
 * the learning flow has not earned. Both the client callbacks and any
 * server-side guard use them.
 * ============================================================ */

/** True when every required roadmap day exists and all its steps genuinely
 *  completed (isDone + verified). Mirrors isStepReallyComplete. */
export function allStepsVerified(steps: RoadmapStep[] | undefined): boolean {
  const pool = steps ?? [];
  if (pool.length === 0) return false;
  return pool.every((s) => isStepReallyComplete(s));
}

/** Requirement 2: a Day Assessment may be STARTED only once that day's steps
 *  are ALL genuinely complete AND verified, and every earlier day (if any) is
 *  fully step-complete + assessed (sequential progression, requirement 3). */
export function dayAssessmentEligible(
  task: PracticeTask,
  day: number,
): { ready: boolean; reason: string } {
  const steps = task.roadmap ?? [];
  const a = taskAssessment(task);
  const daySteps = steps.filter((s) => (s.dayNumber ?? 1) === day);

  // Every earlier day must be fully done + assessed before this day opens.
  for (let d = 1; d < day; d++) {
    const prior = steps.filter((s) => (s.dayNumber ?? 1) === d);
    if (prior.length === 0) continue; // no steps = no gate
    if (!prior.every((s) => isStepReallyComplete(s))) {
      return { ready: false, reason: `Complete all Day ${d} steps first.` };
    }
    if (!a.completedDays.includes(d)) {
      return { ready: false, reason: `Complete the Day ${d} assessment first.` };
    }
  }

  if (daySteps.length === 0) {
    // A scheduled day with no steps: treat as requiring nothing (nothing to
    // assess), but the day still must not bypass progression for later days.
    return { ready: true, reason: "" };
  }
  if (!daySteps.every((s) => isStepReallyComplete(s))) {
    return {
      ready: false,
      reason: `Day ${day} is not ready: complete every step and its verification question first.`,
    };
  }
  if (a.completedDays.includes(day)) {
    return { ready: false, reason: `Day ${day} assessment already completed.` };
  }
  return { ready: true, reason: "" };
}

/** Requirement 4: the FINAL EXAM unlocks only when EVERY required day exists,
 *  every step of every day is completed AND verified, and every required Day
 *  Assessment is completed. Step-percentage alone is NOT sufficient. */
export function finalExamEligible(
  task: PracticeTask,
): { ready: boolean; reason: string; missingDays: number[] } {
  const steps = task.roadmap ?? [];
  const a = taskAssessment(task);
  const days = roadmapDayNumbers(steps);
  const missingDays: number[] = [];

  if (days.length === 0) {
    return { ready: false, reason: "No roadmap days exist yet.", missingDays: [] };
  }

  for (const d of days) {
    const daySteps = stepsForDay(steps, d);
    if (daySteps.length === 0) continue;
    if (!daySteps.every((s) => isStepReallyComplete(s))) {
      missingDays.push(d);
      continue;
    }
    if (!a.completedDays.includes(d)) {
      missingDays.push(d);
    }
  }

  if (missingDays.length > 0) {
    return {
      ready: false,
      reason: `Complete and assess all ${days.length} day(s) first (missing: Day ${missingDays.join(", ")}).`,
      missingDays,
    };
  }
  return { ready: true, reason: "", missingDays };
}

/* ============================================================
 * WORKFLOW §2/§5 — the step-completion predicate + day status.
 *
 * A step is ONLY genuinely complete when it has BOTH:
 *   - a completedAt timestamp from an explicit completing action, AND
 *   - a non-skipped check-in (the mandatory per-step question answered).
 * `isDone` alone is a half-state; deriving day/task completion from it
 * (as the old code did) is exactly what let "Day 1 completed / 0 assessed"
 * happen. Every caller must use isStepReallyComplete()/dayStatus()
 * instead of raw isDone-per-day.
 * ============================================================ */

/** True only when a step is BOTH marked done AND verified by its question. */
export function isStepReallyComplete(step: RoadmapStep | undefined): boolean {
  if (!step) return false;
  if (!step.isDone) return false;
  if (typeof step.completedAt !== "number") return false;
  // A skipped/unanswered question means it is NOT genuinely complete.
  if (!step.checkIn || step.checkIn.skipped) return false;
  if (step.questionPending) return false;
  return true;
}

/** Has the step's timer ever genuinely run (a valid session exists)? */
export function hasRealPractice(step: RoadmapStep | undefined): boolean {
  if (!step) return false;
  return typeof step.firstStartedAt === "number" && (step.practicedSeconds ?? 0) > 0;
}

export type DayStatus =
  | "locked"
  | "active"          // its current day, steps not all done
  | "in_progress"     // prior days done+assessed, this day is current & started
  | "assessment_ready"; // all steps done, NOT yet assessed
  // (the Assessment Hub treats "assessment_ready" + already-assessed as
  //  "completed"; kept separate so the counter derives from assessment only)

/**
 * WORKFLOW §6 — the authoritative day status for the task workspace.
 * A day is ONLY "assessment_ready" when all its steps are done; it is never
 * considered final until its assessment is submitted (assessment.completedDays).
 * `assessedDays` = the task's persisted assessment.completedDays.
 */
export function dayStatus(
  steps: RoadmapStep[] | undefined,
  dayNumber: number,
  assessedDays: number[] = [],
): { status: DayStatus; done: number; total: number; assessed: boolean } {
  const pool = steps ?? [];
  const daySteps = pool.filter((s) => (s.dayNumber ?? 1) === dayNumber);
  const done = daySteps.filter((s) => isStepReallyComplete(s) || s.isDone).length;
  const total = daySteps.length;
  if (total === 0) return { status: "locked", done, total, assessed: false };
  const allDone = daySteps.every((s) => isStepReallyComplete(s) || s.isDone);
  const assessed = assessedDays.includes(dayNumber);
  let status: DayStatus = "active";
  if (allDone) status = assessed ? "active" : "assessment_ready";
  else if (done > 0) status = "in_progress";
  return { status, done, total, assessed };
}

/**
 * WORKFLOW §14 — the overall task status.
 *   active                    — not all steps done
 *   day_assessment_required   — all steps done, some day unassessed
 *   final_exam_required       — all days assessed, final exam NOT submitted
 *   completed                 — all days assessed AND final exam submitted
 * This replaces "is_completed = all steps done" (which always equated step
 * progress with task completion and let the task finish with 0 assessments).
 */
export function taskStatus(task: PracticeTask): {
  status: "active" | "day_assessment_required" | "final_exam_required" | "completed";
  daysDone: number;
  daysTotal: number;
} {
  const steps = task.roadmap ?? [];
  const days = roadmapDayNumbers(steps);
  const a = taskAssessment(task);
  const daysTotal = days.filter((d) => steps.some((s) => (s.dayNumber ?? 1) === d)).length;
  const allStepsDone = steps.length > 0 && steps.every((s) => isStepReallyComplete(s) || s.isDone);
  if (!allStepsDone) return { status: "active", daysDone: 0, daysTotal };
  const missing = days.filter(
    (d) => steps.some((s) => (s.dayNumber ?? 1) === d) && !a.completedDays.includes(d),
  );
  const daysDone = daysTotal - missing.length;
  if (daysTotal === 0) return { status: "active", daysDone: 0, daysTotal };
  if (missing.length > 0)
    return { status: "day_assessment_required", daysDone, daysTotal };
  if (!a.exam)
    return { status: "final_exam_required", daysDone, daysTotal };
  return { status: "completed", daysDone, daysTotal };
}

/* ============================================================
 * WORKFLOW SEQUENTIAL STEP LOCKING (requirement §1)
 * Steps are strictly sequential WITHIN a day: Step 1 must be
 * genuinely completed before Step 2 may start. Across days the
 * day-lock (§9) also applies. Pure so UI + server agree.
 * ============================================================ */

/**
 * True when `index` (0-based within the WHOLE roadmap order) is startable:
 * every earlier step in the same day is done, and every earlier day is
 * done + assessed. Day 1's Step 1 is always startable.
 */
export function isStepStartable(
  steps: RoadmapStep[] | undefined,
  index: number,
  assessment?: { completedDays: number[] },
): boolean {
  const pool = steps ?? [];
  if (index < 0 || index >= pool.length) return false;
  const step = pool[index];
  const day = step.dayNumber ?? 1;

  // Cross-day gate: every prior day must be done + assessed.
  for (let d = 1; d < day; d++) {
    const prior = pool.filter((s) => (s.dayNumber ?? 1) === d);
    if (prior.length === 0) continue;
    if (!prior.every((s) => s.isDone)) return false;
    if (assessment && !assessment.completedDays.includes(d)) return false;
  }

  // Within-day sequence: every earlier step of THIS day must be done.
  const sameDay = pool.filter((s) => (s.dayNumber ?? 1) === day);
  const position = sameDay.indexOf(step);
  return sameDay.slice(0, position).every((s) => s.isDone);
}

/**
 * The sequential rule for STARTING a step's timer: the step must not be
 * done, must not already be running/paused, and must be startable per the
 * pure sequence rule.
 */
export function canStartStep(
  steps: RoadmapStep[] | undefined,
  index: number,
  assessment?: { completedDays: number[] },
): boolean {
  const pool = steps ?? [];
  const step = pool[index];
  if (!step) return false;
  if (step.isDone) return false;
  if (step.timerStatus === "running" || step.timerStatus === "paused") return true; // already engaged
  return isStepStartable(steps, index, assessment);
}

/**
 * WHY NO COMPLETION BEFORE START (req §2): a step with zero real practice
 * can never be completed. Combined with the min-practice gate this makes
 * "READY → START → RUNNING → FINISH → QUESTION → COMPLETED" the only path.
 */
export function canCompleteStep(step: RoadmapStep | undefined): boolean {
  if (!step) return false;
  if (step.isDone) return false;
  // Must have a real timer history: started at least once AND accumulated
  // genuine practice time. Zero-practice steps are hard-blocked.
  if (typeof step.firstStartedAt !== "number") return false;
  return (step.practicedSeconds ?? 0) > 0;
}

/** Human-readable reason a step cannot start (for UI titles/toasts). */
export function stepLockReason(
  steps: RoadmapStep[] | undefined,
  index: number,
  assessment?: { completedDays: number[] },
): string {
  const pool = steps ?? [];
  const step = pool[index];
  if (!step) return "Step not found";
  if (step.isDone) return "Step already completed";
  const day = step.dayNumber ?? 1;
  for (let d = 1; d < day; d++) {
    const prior = pool.filter((s) => (s.dayNumber ?? 1) === d);
    if (prior.length === 0) continue;
    if (!prior.every((s) => s.isDone)) return `Complete Day ${d} first`;
    if (assessment && !assessment.completedDays.includes(d))
      return `Complete the Day ${d} assessment first`;
  }
  const sameDay = pool.filter((s) => (s.dayNumber ?? 1) === day);
  const position = sameDay.indexOf(step);
  const blocker = sameDay.slice(0, position).find((s) => !s.isDone);
  if (blocker) return `Complete \"${blocker.title}\" first`;
  return "";
}

/* MIN-PRACTICE RULE (pure) - finishing early never grants completion.
 *   minimum required practice = min(50% of estimate, 10 minutes)
 * with an absolute 5-minute floor.
 *   45-min step -> 10 min  |  20-min step -> 10 min
 *   8-min step  -> 5 min   |  no estimate -> 10 min (safe default)  */
export const MIN_PRACTICE_FLOOR_SECONDS = 5 * 60;
export const MIN_PRACTICE_CAP_SECONDS = 10 * 60;

/** Minimum practice SECONDS required before a step may be completed. */
export function minPracticeSeconds(estimatedMinutes?: number): number {
  const est =
    typeof estimatedMinutes === "number" && estimatedMinutes > 0
      ? estimatedMinutes
      : 20; // safe default when an estimate is somehow absent
  const half = Math.floor((est * 60) / 2);
  const capped = Math.max(MIN_PRACTICE_FLOOR_SECONDS, Math.min(half, MIN_PRACTICE_CAP_SECONDS));
  return Math.min(capped, Math.floor(est * 60)); // never more than the estimate
}

/**
 * True when a step has genuinely practiced enough to be completable.
 * `liveExtraSeconds` lets a RUNNING timer count toward the requirement.
 */
export function meetsMinPractice(
  step: Pick<RoadmapStep, "practicedSeconds" | "estimated_minutes"> | undefined,
  liveExtraSeconds = 0
): boolean {
  if (!step) return false;
  const practiced =
    Math.max(0, Math.floor(step.practicedSeconds ?? 0)) +
    Math.max(0, Math.floor(liveExtraSeconds));
  return practiced >= minPracticeSeconds(step.estimated_minutes);
}

/** Human-readable minimum-practice label, e.g. "10m" / "5m 30s". */
export function minPracticeLabel(estimatedMinutes?: number): string {
  return formatDuration(minPracticeSeconds(estimatedMinutes));
}

/**
 * §5 auto-completion: a task is fully complete when every roadmap step it
 * owns is marked done. Tasks with zero steps are NOT auto-completed by this
 * rule (they stay In Progress / Overdue as their day-window dictates).
 */
export function isTaskAutoCompleted(steps: RoadmapStep[] | undefined): boolean {
  const pool = steps ?? [];
  if (pool.length === 0) return false;
  return pool.every((s) => s.isDone);
}