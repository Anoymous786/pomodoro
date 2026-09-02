/**
 * lib/progress-sync.ts — Phase 2 durable progress synchronization helpers.
 *
 * Pure and testable: doc building, change signatures and the
 * remote-adoption merge policy. The impure side (fetch/put + setState)
 * lives in hooks/usePomodoro.ts; the server side lives in
 * app/api/progress/route.ts (local dev) and
 * infrastructure/lambda-src/functions/progress/index.mjs (deployed).
 *
 * Model: ONE DynamoDB item per task (PROGRESS#<taskId> in the EXISTING
 * `roadmaps` table, PK user_id / SK sk). Each item carries a monotonically
 * increasing `rev`. Writes are conditional (expected rev must match);
 * a 409 means another tab/device won and the local copy is stale.
 * localStorage remains the offline/UI cache — the server doc is
 * authoritative whenever its rev is higher.
 */
import type { PracticeTask, TaskAssessment } from "./types";
import type { ProgressDoc } from "./api";

/** Wire/DB payload for one task's durable progress document. */
export type ProgressTaskPayload = Omit<PracticeTask, "rev" | "syncedAt" | "assessment"> &
  { assessment?: TaskAssessment };

/**
 * Builds the wire/DB payload for one task. Copies fields explicitly so
 * transport-only bookkeeping (rev/syncedAt) can never leak into the doc
 * and future PracticeTask fields must be added here deliberately.
 */
export function buildProgressDocPayload(
  task: PracticeTask
): ProgressTaskPayload {
  const payload: ProgressTaskPayload = {
    id: task.id,
    name: task.name,
    startDate: task.startDate,
    durationDays: task.durationDays,
    checkIns: [...(task.checkIns ?? [])],
    createdAt: task.createdAt ?? 0,
  };
  if (typeof task.description === "string" && task.description.trim()) {
    payload.description = task.description;
  }
  if (typeof task.is_completed === "boolean") {
    payload.is_completed = task.is_completed;
  }
  if (Array.isArray(task.roadmap)) {
    // Deep-ish copy so the snapshot is immune to later in-place edits.
    payload.roadmap = task.roadmap.map((s) => ({ ...s }));
  }
  // PART 2 §8/§9/§15: assessment state is durable progress too.
  if (task.assessment) {
    payload.assessment = {
      completedDays: [...(task.assessment.completedDays ?? [])],
      dayScores: { ...task.assessment.dayScores },
      attempts: (task.assessment.attempts ?? []).map((a) => ({ ...a })),
      ...(task.assessment.exam
        ? { exam: { ...task.assessment.exam } }
        : {}),
      ...(task.assessment.examDraft
        ? { examDraft: JSON.parse(JSON.stringify(task.assessment.examDraft)) }
        : {}),
      // PART 2 §9: the interrupted-attempt marker is durable progress too —
      // without it the "Attempt Interrupted / Retry" banner would vanish
      // after a refresh/server re-hydration (exam requirement must persist).
      ...(task.assessment.interruptedAttempt
        ? {
            interruptedAttempt: JSON.parse(
              JSON.stringify(task.assessment.interruptedAttempt),
            ),
          }
        : {}),
    };
  }
  return payload;
}

/**
 * Rebuilds a full PracticeTask from a server doc, stamping the doc's rev.
 * Returns null when the doc shape is unusable (defensive against a
 * misbehaving/legacy endpoint).
 */
export function taskFromProgressDoc(doc: ProgressDoc): PracticeTask | null {
  if (!doc || typeof doc !== "object") return null;
  const t = doc.task as Partial<PracticeTask> | undefined;
  if (!t || typeof doc.taskId !== "string" || !doc.taskId) return null;
  if (typeof t.id !== "string" || t.id !== doc.taskId) return null;
  if (typeof t.name !== "string" || !t.name.trim()) return null;
  if (typeof t.startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(t.startDate)) {
    return null;
  }
  const duration =
    typeof t.durationDays === "number" && Number.isFinite(t.durationDays)
      ? Math.max(1, Math.floor(t.durationDays))
      : 0;
  if (duration < 1) return null;
  return {
    ...t,
    id: doc.taskId,
    durationDays: duration,
    checkIns: Array.isArray(t.checkIns)
      ? t.checkIns.filter((d) => Number.isFinite(d))
      : [],
    roadmap: Array.isArray(t.roadmap) ? t.roadmap : [],
    assessment: t.assessment
      ? {
          completedDays: Array.isArray(t.assessment.completedDays)
            ? t.assessment.completedDays
            : [],
          dayScores: t.assessment.dayScores ?? {},
          attempts: Array.isArray(t.assessment.attempts)
            ? t.assessment.attempts
            : [],
          exam: t.assessment.exam,
          examDraft: t.assessment.examDraft,
        }
      : undefined,
    rev: typeof doc.rev === "number" && doc.rev > 0 ? doc.rev : 1,
    syncedAt: Date.now(),
  } as PracticeTask;
}

/**
 * Stable JSON stringify — object keys sorted recursively so equal
 * structures always serialize identically (arrays keep their order,
 * which is meaningful for steps/checkIns).
 */
export function stableStringify(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) out[k] = canon(obj[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(canon(value));
}

/**
 * Cheap change signature for one task's durable fields. A push is only
 * attempted when this string differs from the last synced/applying one —
 * keeps the 500ms state ticks and pure-UI updates from hitting the API.
 */
export function progressSignature(
  task: Pick<PracticeTask, "name" | "description" | "startDate" | "durationDays" | "checkIns" | "is_completed" | "roadmap" | "assessment" | "rev">
): string {
  return stableStringify([
    task.name,
    task.description ?? null,
    task.startDate,
    Math.round(task.durationDays),
    [...(task.checkIns ?? [])],
    task.is_completed ?? null,
    (task.roadmap ?? []).map((s) => [
      s.id,
      s.title,
      s.note ?? null,
      s.dayNumber ?? null,
      s.isDone ? 1 : 0,
      s.estimated_minutes ?? null,
      Math.round(s.practicedSeconds ?? 0),
      Math.round(s.elapsedSeconds ?? 0),
      s.timerStatus ?? "idle",
      s.startedAt ?? null,
      s.actual_minutes ?? null,
      s.timing_outcome ?? null,
      s.checkIn
        ? [
            s.checkIn.answer,
            s.checkIn.correct ? 1 : 0,
            s.checkIn.passed ? 1 : 0,
            s.checkIn.skipped ? 1 : 0,
          ]
        : null,
      s.sources ?? null,
      s.search ?? null,
    ]),
    // PART 2: assessment state is durable progress — the draft included,
    // so multi-device merges adopt whichever side truly advanced.
    task.assessment
      ? [
          task.assessment.completedDays ?? [],
          task.assessment.dayScores ?? {},
          task.assessment.attempts ?? [],
          task.assessment.exam ?? null,
          task.assessment.examDraft ?? null,
        ]
      : null,
    task.rev ?? null,
  ]);
}

/**
 * Merge policy when the server has NEWER data for a task (remote rev >
 * local rev): adopt the remote snapshot but preserve purely-local,
 * under-our-control advantages — a mid-run live timer must not be killed
 * by an older remote snapshot, so a locally RUNNING step keeps its local
 * status/startedAt and its accumulated seconds win via max().
 */
export function adoptRemoteTask(local: PracticeTask, remote: PracticeTask): PracticeTask {
  const localRunning =
    (local.roadmap ?? []).find((s) => s.timerStatus === "running") ?? null;
  if (!localRunning) return remote;
  const mergedRoadmap = (remote.roadmap ?? []).map((s) => {
    if (s.id !== localRunning.id) return s;
    return {
      ...s,
      timerStatus: "running" as const,
      startedAt: localRunning.startedAt,
      practicedSeconds: Math.max(s.practicedSeconds ?? 0, localRunning.practicedSeconds ?? 0),
    };
  });
  return { ...remote, roadmap: mergedRoadmap };
}

/** True when local has strictly MORE durable content than the remote doc. */
function isLocalRicher(local: PracticeTask, remote: PracticeTask): boolean {
  const localSteps = local.roadmap ?? [];
  const remoteSteps = remote.roadmap ?? [];
  if (localSteps.length !== remoteSteps.length) return localSteps.length > remoteSteps.length;
  const localDone = localSteps.filter((s) => s.isDone).length;
  const remoteDone = remoteSteps.filter((s) => s.isDone).length;
  if (localDone !== remoteDone) return localDone > remoteDone;
  const localPrac = localSteps.reduce((a, s) => a + (s.practicedSeconds ?? 0), 0);
  const remotePrac = remoteSteps.reduce((a, s) => a + (s.practicedSeconds ?? 0), 0);
  return localPrac > remotePrac;
}

/**
 * Decides which snapshot a task takes after server hydration, using BOTH
 * the revision and the actual content.
 *
 * Rules:
 *  - local.rev defined && local.rev >= doc.rev  -> keep local (server not ahead)
 *  - local.rev defined && local.rev <  doc.rev  -> adopt remote (server genuinely ahead)
 *  - local.rev UNDEFINED (this device never acked a push) -> we cannot prove
 *    which side is newer. If the remote is EMPTY/AHEAD in content we adopt it
 *    (fresh-device case). But if local is RICHER (a same-device task created &
 *    edited before its first push round-tripped a rev), we KEEP local content
 *    while seeding the remote's rev as the baseline — so the change-driven push
 *    increments from that rev (a 409-free upgrade) instead of letting the stale
 *    server snapshot wipe the richer local roadmap.
 */
export function mergeHydratedTask(
  local: PracticeTask | undefined,
  remote: PracticeTask,
  remoteRev: number
): { task: PracticeTask; baselineRev: number } {
  if (!local) return { task: remote, baselineRev: remoteRev };
  if (typeof local.rev === "number") {
    if (local.rev >= remoteRev) return { task: local, baselineRev: local.rev };
    return { task: adoptRemoteTask(local, remote), baselineRev: remoteRev };
  }
  // local.rev undefined
  if (isLocalRicher(local, remote)) {
    // Keep richer local content; seed the baseline rev so the next push
    // increments the server doc instead of clobbering via a re-create.
    return { task: { ...local, rev: remoteRev }, baselineRev: remoteRev };
  }
  return { task: adoptRemoteTask(local, remote), baselineRev: remoteRev };
}
