import { NextRequest, NextResponse } from "next/server";
import {
  deleteUserDocs,
  ensureUser,
  getAllStoredDocs,
  persistStore,
  resolveUserId,
  type StoredDoc,
} from "@/lib/progress-store-server";

/**
 * Phase 2 — durable progress sync (LOCAL DEV endpoint).
 *
 * Mirrors the deployed progress Lambda
 * (infrastructure/lambda-src/functions/progress/index.mjs) so local dev
 * behaves like production: conditional revision-guarded writes for one
 * progress document per task.
 *
 * There is no DynamoDB in local node, so documents live in a JSON file
 * under .next/ (gitignored) via the shared lib/progress-store-server.ts.
 * The chatbot reads through the SAME store so it always sees the latest
 * persisted task data (no stale snapshot, no second database).
 *
 * Deployed storage contract: ONE item per task in the EXISTING `roadmaps`
 * table (PK user_id / SK `PROGRESS#<taskId>`) — no new AWS service.
 */

const TIMING_OUTCOMES = ["early", "on-time", "late"] as const;

/** Validates + clamps one roadmap step; null when unusable. */
function sanitizeStep(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  const id = typeof s.id === "string" ? s.id.trim().slice(0, 128) : "";
  const title = typeof s.title === "string" ? s.title.trim().slice(0, 160) : "";
  if (!id || !title) return null;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const out: Record<string, unknown> = {
    id,
    title,
    isDone: s.isDone === true,
    practicedSeconds: Math.max(0, Math.floor(num(s.practicedSeconds) ?? 0)),
    elapsedSeconds: Math.max(0, Math.floor(num(s.elapsedSeconds) ?? 0)),
    timerStatus: (["idle", "running", "paused", "finished"] as const).includes(
      s.timerStatus as "idle"
    )
      ? (s.timerStatus as "idle")
      : "idle",
  };
  if (typeof s.note === "string" && s.note.trim()) out.note = s.note.slice(0, 400);
  const day = num(s.dayNumber);
  if (day !== null && day >= 1) out.dayNumber = Math.floor(day);
  if (typeof s.dayTitle === "string" && s.dayTitle.trim()) {
    out.dayTitle = s.dayTitle.trim().slice(0, 160);
  }
  const est = num(s.estimated_minutes);
  if (est !== null && est > 0) out.estimated_minutes = Math.floor(est);
  const started = num(s.startedAt);
  if (started !== null && started > 0) out.startedAt = started;
  const actual = num(s.actual_minutes);
  if (actual !== null && actual > 0) out.actual_minutes = actual;
  if (typeof s.timing_outcome === "string" &&
      (TIMING_OUTCOMES as readonly string[]).includes(s.timing_outcome)) {
    out.timing_outcome = s.timing_outcome;
  }
  if (s.checkIn && typeof s.checkIn === "object") {
    const c = s.checkIn as Record<string, unknown>;
    out.checkIn = {
      question: typeof c.question === "string" ? c.question.slice(0, 500) : "",
      answer: typeof c.answer === "string" ? c.answer.slice(0, 1000) : "",
      correct: c.correct === true,
      passed: c.passed === true,
      skipped: c.skipped === true,
      answeredAt: Math.floor(num(c.answeredAt) ?? Date.now()),
    };
  }
  if (Array.isArray(s.sources) && s.sources.length) {
    out.sources = s.sources.slice(0, 8);
  }
  if (typeof s.search === "string" && s.search.trim()) {
    out.search = s.search.slice(0, 200);
  }
  // WORKFLOW §3: the audit trail must survive round-trips so the server can
  // re-derive/enforce the real workflow (completed-without-start, finish
  // timestamps, question-pending state).
  const completedAt = num(s.completedAt);
  if (completedAt !== null && completedAt > 0) out.completedAt = completedAt;
  if (s.completedBy === "timer" || s.completedBy === "manual") {
    out.completedBy = s.completedBy;
  }
  const firstStarted = num(s.firstStartedAt);
  if (firstStarted !== null && firstStarted > 0) out.firstStartedAt = firstStarted;
  const finished = num(s.finishedAt);
  if (finished !== null && finished > 0) out.finishedAt = finished;
  if (s.questionPending === true) out.questionPending = true;
  if (typeof s.timingRecord === "object" && s.timingRecord !== null) {
    const tr = s.timingRecord as Record<string, unknown>;
    const trEst = num(tr.estimated_minutes);
    const trAct = num(tr.actual_minutes);
    if (trEst !== null && trAct !== null) {
      out.timingRecord = {
        estimated_minutes: Math.floor(trEst),
        actual_minutes: Math.floor(trAct),
        timing_outcome: (TIMING_OUTCOMES as readonly string[]).includes(
          String(tr.timing_outcome),
        )
          ? tr.timing_outcome
          : "on-time",
        completedAt: Math.floor(num(tr.completedAt) ?? Date.now()),
      };
    }
  }
  return out;
}

/** Finite-number clamp helper for the assessment sanitizer. */
function anum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
const MAX_ATTEMPTS = 10;
const MAX_EXAM_QUESTIONS = 25;

/**
 * PART 2 §8/§9/§15 — validates + clamps the per-task assessment record.
 * The server NEVER trusts scores blindly: every number is re-clamped and
 * the attempt history is append-capped so a tampered client cannot bloat
 * or corrupt the durable record. Historical attempts are preserved.
 */
function sanitizeAssessment(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as Record<string, unknown>;
  const completedDays = Array.isArray(a.completedDays)
    ? Array.from(
        new Set(
          a.completedDays
            .filter((d) => anum(d) !== null && (d as number) >= 1 && (d as number) <= 365)
            .map((d) => Math.floor(d as number)),
        ),
      ).sort((x, y) => x - y)
    : [];
  const sanitizeAnswers = (rawAnswers: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (rawAnswers && typeof rawAnswers === "object") {
      for (const [k, v] of Object.entries(rawAnswers as Record<string, unknown>)) {
        if (typeof v === "string" && v.length <= 400) {
          out[k.slice(0, 64)] = v;
        }
      }
    }
    return out;
  };
  const dayScores: Record<string, unknown> = {};
  if (a.dayScores && typeof a.dayScores === "object") {
    for (const [k, v] of Object.entries(a.dayScores as Record<string, unknown>)) {
      const day = anum(Number(k));
      if (day === null || day < 1 || typeof v !== "object" || v === null) continue;
      const d = v as Record<string, unknown>;
      dayScores[String(Math.floor(day))] = {
        score: Math.max(0, Math.floor(anum(d.score) ?? 0)),
        total: Math.max(0, Math.floor(anum(d.total) ?? 0)),
        pct: Math.min(100, Math.max(0, Math.floor(anum(d.pct) ?? 0))),
        passed: d.passed === true,
        submittedAt: Math.floor(anum(d.submittedAt) ?? Date.now()),
      };
    }
  }
  const attempts = Array.isArray(a.attempts)
    ? a.attempts
        .map((x) => {
          if (typeof x !== "object" || x === null) return null;
          const at = x as Record<string, unknown>;
          const kind =
            at.kind === "exam" ? "exam" : at.kind === "day" ? "day" : null;
          if (!kind) return null;
          const attempt = Math.max(1, Math.floor(anum(at.attempt) ?? 1));
          const day = anum(at.day);
          const questions = Array.isArray(at.questions)
            ? at.questions
                .map((q) => {
                  if (typeof q !== "object" || q === null) return null;
                  const qq = q as Record<string, unknown>;
                  if (typeof qq.id !== "string" || typeof qq.prompt !== "string")
                    return null;
                  return { id: qq.id.slice(0, 64), prompt: qq.prompt.slice(0, 500) };
                })
                .filter(Boolean)
                .slice(0, MAX_EXAM_QUESTIONS)
            : [];
          const correctAnswers: Record<string, string> = {};
          if (at.correctAnswers && typeof at.correctAnswers === "object") {
            for (const [k, v] of Object.entries(
              at.correctAnswers as Record<string, unknown>,
            )) {
              if (typeof v === "string" && v.length <= 300) {
                correctAnswers[k.slice(0, 64)] = v;
              }
            }
          }
          const explanations: Record<string, string> = {};
          if (at.explanations && typeof at.explanations === "object") {
            for (const [k, v] of Object.entries(
              at.explanations as Record<string, unknown>,
            )) {
              if (typeof v === "string" && v.length <= 700) {
                explanations[k.slice(0, 64)] = v;
              }
            }
          }
          // PART 2 §12/§14: per-question review rows survive the round-trip
          // so the chatbot can answer "what did I get wrong?" from the
          // AUTHORITATIVE server copy (not just the browser cache).
          const questionReview = Array.isArray(at.questionReview)
            ? at.questionReview
                .map((r) => {
                  if (typeof r !== "object" || r === null) return null;
                  const rr = r as Record<string, unknown>;
                  if (typeof rr.prompt !== "string") return null;
                  return {
                    id: typeof rr.id === "string" ? rr.id.slice(0, 64) : "",
                    prompt: rr.prompt.slice(0, 500),
                    selectedAnswer:
                      typeof rr.selectedAnswer === "string"
                        ? rr.selectedAnswer.slice(0, 300)
                        : "(no answer)",
                    correctAnswer:
                      typeof rr.correctAnswer === "string"
                        ? rr.correctAnswer.slice(0, 300)
                        : "",
                    correct: rr.correct === true,
                    ...(typeof rr.explanation === "string"
                      ? { explanation: rr.explanation.slice(0, 700) }
                      : {}),
                  };
                })
                .filter(Boolean)
                .slice(0, MAX_EXAM_QUESTIONS)
            : [];
          return {
            attempt,
            kind,
            ...(kind === "day" && day !== null && day >= 1
              ? { day: Math.floor(day) }
              : {}),
            score: Math.max(0, Math.floor(anum(at.score) ?? 0)),
            total: Math.max(0, Math.floor(anum(at.total) ?? 0)),
            pct: Math.min(100, Math.max(0, Math.floor(anum(at.pct) ?? 0))),
            passed: at.passed === true,
            answers: sanitizeAnswers(at.answers),
            questions,
            startedAt: Math.floor(anum(at.startedAt) ?? 0),
            submittedAt: Math.floor(anum(at.submittedAt) ?? Date.now()),
            // --- previously-dropped audit/review fields (Req 4/5) ---
            ...(questionReview.length ? { questionReview } : {}),
            ...(Object.keys(correctAnswers).length ? { correctAnswers } : {}),
            ...(Object.keys(explanations).length ? { explanations } : {}),
            ...(anum(at.durationSeconds) !== null
              ? { durationSeconds: Math.max(0, Math.floor(at.durationSeconds as number)) }
              : {}),
            ...(anum(at.fullscreenViolations) !== null
              ? { fullscreenViolations: Math.max(0, Math.floor(at.fullscreenViolations as number)) }
              : {}),
            ...(anum(at.visibilityViolations) !== null
              ? { visibilityViolations: Math.max(0, Math.floor(at.visibilityViolations as number)) }
              : {}),
            ...(at.attemptState === "interrupted" || at.attemptState === "completed"
              ? { attemptState: at.attemptState }
              : {}),
            ...(typeof at.interruptionReason === "string"
              ? { interruptionReason: at.interruptionReason.slice(0, 300) }
              : {}),
            ...(typeof at.examId === "string"
              ? { examId: at.examId.slice(0, 128) }
              : {}),
          };
        })
        .filter(Boolean)
        .slice(-MAX_ATTEMPTS)
    : [];
  const exam =
    a.exam && typeof a.exam === "object"
      ? (() => {
          const e = a.exam as Record<string, unknown>;
          return {
            score: Math.max(0, Math.floor(anum(e.score) ?? 0)),
            total: Math.max(0, Math.floor(anum(e.total) ?? 0)),
            pct: Math.min(100, Math.max(0, Math.floor(anum(e.pct) ?? 0))),
            passed: e.passed === true,
            submittedAt: Math.floor(anum(e.submittedAt) ?? Date.now()),
          };
        })()
      : undefined;
  let examDraft: Record<string, unknown> | undefined;
  if (a.examDraft && typeof a.examDraft === "object") {
    const d = a.examDraft as Record<string, unknown>;
    const questions = Array.isArray(d.questions)
      ? d.questions
          .map((q) => {
            if (typeof q !== "object" || q === null) return null;
            const qq = q as Record<string, unknown>;
            if (typeof qq.id !== "string" || typeof qq.prompt !== "string")
              return null;
            const options = Array.isArray(qq.options)
              ? qq.options
                  .filter((o) => typeof o === "string")
                  .map((o) => (o as string).slice(0, 300))
                  .slice(0, 6)
              : [];
            const out: Record<string, unknown> = {
              id: qq.id.slice(0, 64),
              topic: typeof qq.topic === "string" ? qq.topic.slice(0, 64) : "general",
              prompt: qq.prompt.slice(0, 600),
              options,
              referenceAnswer:
                typeof qq.referenceAnswer === "string"
                  ? qq.referenceAnswer.slice(0, 300)
                  : "",
            };
            const dayN = anum(qq.day_number);
            if (dayN !== null) out.day_number = Math.floor(dayN);
            if (typeof qq.difficulty === "string") {
              out.difficulty =
                ["easy", "medium", "hard"].includes(qq.difficulty)
                  ? qq.difficulty
                  : "medium";
            }
            if (typeof qq.explanation === "string") {
              out.explanation = qq.explanation.slice(0, 700);
            }
            if (typeof qq.source === "string") {
              out.source = qq.source.slice(0, 200);
            }
            return out;
          })
          .filter(Boolean)
          .slice(0, MAX_EXAM_QUESTIONS)
      : [];
    examDraft = {
      examId: typeof d.examId === "string" ? d.examId.slice(0, 128) : "exam",
      questions,
      answers: sanitizeAnswers(d.answers),
      currentQuestion: Math.max(0, Math.floor(anum(d.currentQuestion) ?? 0)),
      startedAt: Math.floor(anum(d.startedAt) ?? Date.now()),
      updatedAt: Math.floor(anum(d.updatedAt) ?? Date.now()),
    };
  }
  return {
    completedDays,
    dayScores,
    attempts,
    ...(exam ? { exam } : {}),
    ...(examDraft ? { examDraft } : {}),
    // PART 2 §9: the interrupted-attempt marker survives the round-trip so
    // the Assessment Hub keeps showing "Attempt Interrupted / Retry" after a
    // refresh (the exam requirement NEVER disappears — Phase 1 Req 9).
    ...(a.interruptedAttempt && typeof a.interruptedAttempt === "object"
      ? {
          interruptedAttempt: (() => {
            const m = a.interruptedAttempt as Record<string, unknown>;
            return {
              examId: typeof m.examId === "string" ? m.examId.slice(0, 128) : "exam",
              kind: m.kind === "exam" ? "exam" : "day",
              ...(anum(m.day) !== null ? { day: Math.floor(m.day as number) } : {}),
              reason: typeof m.reason === "string" ? m.reason.slice(0, 300) : "",
              answeredCount: Math.max(0, Math.floor(anum(m.answeredCount) ?? 0)),
              interruptedAt: Math.floor(anum(m.interruptedAt) ?? Date.now()),
            };
          })(),
        }
      : {}),
  };
}

const MAX_TASKS = 500;
const MAX_ROADMAP_STEPS = 400;

/** Validates + clamps one progress task payload; null when unusable. */
function sanitizeTaskPayload(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as Record<string, unknown>;
  const id = typeof t.id === "string" ? t.id.trim().slice(0, 128) : "";
  const name = typeof t.name === "string" ? t.name.trim().slice(0, 200) : "";
  if (!id || !name) return null;
  const startDate =
    typeof t.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.startDate)
      ? t.startDate
      : "";
  if (!startDate) return null;
  const durationDays =
    typeof t.durationDays === "number" &&
    Number.isFinite(t.durationDays) &&
    t.durationDays >= 1 &&
    t.durationDays <= 365
      ? Math.floor(t.durationDays)
      : 0;
  if (!durationDays) return null;
  const out: Record<string, unknown> = {
    id,
    name,
    startDate,
    durationDays,
    checkIns: Array.isArray(t.checkIns)
      ? Array.from(
          new Set(
            t.checkIns
              .filter((d) => typeof d === "number" && d >= 1 && d <= durationDays)
              .map((d) => Math.floor(d))
          )
        ).sort((a, b) => a - b)
      : [],
    createdAt:
      typeof t.createdAt === "number" && Number.isFinite(t.createdAt)
        ? t.createdAt
        : Date.now(),
  };
  if (typeof t.description === "string" && t.description.trim()) {
    out.description = t.description.trim().slice(0, 1000);
  }
  if (t.is_completed === true) out.is_completed = true;
  if (Array.isArray(t.roadmap)) {
    out.roadmap = t.roadmap.map(sanitizeStep).filter(Boolean).slice(0, MAX_ROADMAP_STEPS);
  }
  if (t.assessment !== undefined) {
    const assessment = sanitizeAssessment(t.assessment);
    if (assessment) out.assessment = assessment;
  }
  return out;
}

/** Ensures the user partition stays inside the free-tier envelope. */
function enforceTaskLimit(userId: string, taskId: string): boolean {
  const userStore = ensureUser(userId);
  if (userStore.has(taskId)) return true;
  if (userStore.size >= MAX_TASKS) return false;
  return true;
}
/**
 * WORKFLOW §18 — SERVER-SIDE TRANSITION VALIDATION.
 * Re-derives the same pure rules the client uses and rejects any write that
 * would produce an impossible workflow state:
 *  - a step completed (isDone+completedAt) with zero real practice
 *  - a step completed while an earlier step in the same day is still open
 *  - a day's steps done while a prior day's assessment is missing
 * This is a soft-guard (it validates the PAYLOAD, not the intent) because the
 * document protocol is snapshot-based — but it makes hand-crafted payloads
 * (tampered localStorage, raw API calls) unable to fake progress.
 */
function validateWorkflow(
  task: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  const roadmap = Array.isArray(task.roadmap)
    ? (task.roadmap as Record<string, unknown>[])
    : [];
  const assessment = (task.assessment ?? null) as
    | { completedDays?: unknown }
    | null;
  const completedDays = Array.isArray(assessment?.completedDays)
    ? (assessment?.completedDays as unknown[]).filter(
        (d): d is number => typeof d === "number",
      )
    : [];

  const done = (s: Record<string, unknown>) =>
    s.isDone === true && typeof s.completedAt === "number";

  const completedWithoutQuestion = (s: Record<string, unknown>): boolean => {
    if (!done(s)) return false;
    // WORKFLOW §5: a genuinely completed step must carry ANSWERED question
    // evidence. Skipped/absent evidence means the client bypassed the gate.
    const ci = s.checkIn as Record<string, unknown> | undefined;
    return !(ci && typeof ci === "object" && ci.skipped !== true &&
      typeof ci.answeredAt === "number");
  };

  let previousDayAllDone = true;
  for (let d = 1; d <= 60; d++) {
    const daySteps = roadmap.filter(
      (s) => typeof s.dayNumber === "number" && s.dayNumber === d,
    );
    if (daySteps.length === 0) {
      if (d > 1 && completedDays.includes(d)) {
        return { ok: false, error: `Day ${d} has no steps but is marked assessed.` };
      }
      continue;
    }
    // Sequence: within this day, a done step must not precede an open one.
    let sawOpen = false;
    for (const s of daySteps) {
      if (done(s)) {
        // §2 no completion before start: real practice is mandatory.
        const practiced = typeof s.practicedSeconds === "number" ? s.practicedSeconds : 0;
        if (practiced <= 0) {
          return {
            ok: false,
            error: `Step \"${String(s.title ?? "")}\" is completed with zero practice time.`,
          };
        }
        // §5 the mandatory per-step question must have been answered.
        if (completedWithoutQuestion(s)) {
          return {
            ok: false,
            error: `Step \"${String(s.title ?? "")}\" is completed without answering its required question.`,
          };
        }
        if (sawOpen) {
          return {
            ok: false,
            error: `Step \"${String(s.title ?? "")}\" is completed before an earlier step of Day ${d}.`,
          };
        }
      } else {
        sawOpen = true;
      }
    }
    const dayAllDone = daySteps.every(done);
    if (dayAllDone) {
      // §8 day lock: this day can only be assessed when all prior days are.
      if (completedDays.includes(d) && !previousDayAllDone) {
        return {
          ok: false,
          error: `Day ${d} is assessed before earlier days were completed.`,
        };
      }
    } else {
      if (completedDays.includes(d)) {
        return {
          ok: false,
          error: `Day ${d} is assessed but not all of its steps are done.`,
        };
      }
      previousDayAllDone = false;
    }
    if (!dayAllDone) previousDayAllDone = false;
    else if (!completedDays.includes(d)) previousDayAllDone = previousDayAllDone && false;
  }
  return { ok: true };
}

export async function GET(req: NextRequest) {
  const userId = resolveUserId(req.headers);
  const docs = getAllStoredDocs(userId);
  return NextResponse.json({ docs, local: true });
}

export async function DELETE(req: NextRequest) {
  // Dev-only convenience for tests: wipe one user's progress docs.
  const userId = resolveUserId(req.headers);
  deleteUserDocs(userId);
  return NextResponse.json({ ok: true });
}

export async function PUT(req: NextRequest) {
  const userId = resolveUserId(req.headers);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const obj = (body ?? {}) as Record<string, unknown>;
  const expectedRev =
    typeof obj.expectedRev === "number" &&
    Number.isFinite(obj.expectedRev) &&
    obj.expectedRev >= 0
      ? Math.floor(obj.expectedRev)
      : -1;
  if (expectedRev < 0) {
    return NextResponse.json(
      { error: "expectedRev must be a non-negative integer." },
      { status: 400 }
    );
  }
  const task = sanitizeTaskPayload(obj.task);
  if (!task || typeof task.id !== "string") {
    return NextResponse.json(
      { error: "Invalid progress payload (id/name/startDate/durationDays required)." },
      { status: 400 }
    );
  }
  // WORKFLOW §18: reject impossible workflow states before persisting.
  const wf = validateWorkflow(task);
  if (!wf.ok) {
    return NextResponse.json({ error: wf.error }, { status: 422 });
  }
  const taskId: string = task.id;
  if (!enforceTaskLimit(userId, taskId)) {
    return NextResponse.json({ error: "Too many tasks." }, { status: 413 });
  }
  const userStore = ensureUser(userId);
  const existing = userStore.get(taskId);
  const currentRev = existing?.rev ?? 0;
  if (expectedRev !== currentRev) {
    // Conditional-write guard: another tab/device advanced this doc first.
    return NextResponse.json(
      { error: "Revision conflict — re-hydrate before writing.", currentRev },
      { status: 409 }
    );
  }
  const doc: StoredDoc = {
    taskId,
    rev: currentRev + 1,
    task: { ...task, id: taskId },
  };
  userStore.set(taskId, doc);
  persistStore();
  return NextResponse.json({ doc: { taskId, rev: doc.rev, task: doc.task } });
}
