"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, HelpCircle, Loader2, X } from "lucide-react";
import { apiPost } from "@/lib/api";

export interface PendingCheckInData {
  taskId: string;
  stepId: string;
  stepTitle: string;
  topic: string;
  completedBy: "timer" | "manual";
  /**
   * Phase 1 (token saving): a previously generated question persisted on the
   * step. When present the modal reuses it instead of calling the LLM again
   * (refresh / navigation / reopening never regenerate).
   */
  cachedQuestion?: {
    question: string;
    options: string[];
    correctIndex: number;
    explanation?: string;
    difficulty?: "easy" | "medium" | "hard";
    source?: string;
  };
}

/** Object shape passed to completeStep. */
export interface CheckInAnswer {
  question: string;
  options?: string[];
  answer: string;
  correct: boolean;
  passed: boolean;
  explanation?: string;
  /** True when the user marked done WITHOUT answering (unverified). */
  skipped?: boolean;
  /** §P2: difficulty of the question asked. */
  difficulty?: "easy" | "medium" | "hard";
  /** §P5: which step/task the question was drawn from. */
  source?: string;
}

interface GeneratedCheckIn {
  question: string;
  options: string[];
  correctIndex: number;
  explanation?: string;
  /** §P2: mix difficulty in check-ins. */
  difficulty?: "easy" | "medium" | "hard";
  /** §P5: which step/task the question was drawn from. */
  source?: string;
}

interface CheckInModalProps {
  pending: PendingCheckInData;
  onCancel: () => void;
  onAnswer: (answer: CheckInAnswer) => void;
  /**
   * Phase 1 (token saving): called ONCE when a question is freshly generated
   * so the parent can persist it on the step (reopening then reuses it).
   */
  onGeneratedQuestion?: (q: GeneratedCheckIn) => void;
}

/**
 * §11 per-step check-in modal. Asks ONE short MCQ specific to the step's topic
 * to confirm genuine understanding before the step is marked done. If the LLM
 * is unavailable, a graceful fallback still lets the learner progress (the
 * answer is recorded as "unverified") so a provider outage never hard-blocks.
 */
export default function CheckInModal({
  pending,
  onCancel,
  onAnswer,
  onGeneratedQuestion,
}: CheckInModalProps) {
  const [q, setQ] = useState<GeneratedCheckIn | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  /** Bumped by "Try again" to re-run the question generation effect. */
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Phase 1 (token saving): reuse the persisted question when present —
    // reopening/refreshing a step NEVER calls the LLM again for it.
    if (pending.cachedQuestion) {
      setQ(pending.cachedQuestion);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const load = async () => {
      try {
        const res = await apiPost("/api/generate-checkin", {
          stepTitle: pending.stepTitle,
          topic: pending.topic,
        });
        const data = (await res.json()) as {
          checkIn?: GeneratedCheckIn;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || !data.checkIn) {
          throw new Error(data.error ?? "Couldn't prepare the check-in.");
        }
        setQ(data.checkIn);
        // Persist-once: hand the fresh question to the parent so the NEXT
        // open of this step (refresh/navigation) reuses it.
        onGeneratedQuestion?.(data.checkIn);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Check-in unavailable.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
    // onGeneratedQuestion intentionally excluded (stable callback, avoid loops).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.stepId, pending.stepTitle, pending.topic, pending.cachedQuestion, retry]);
  const grade = (): CheckInAnswer => {
    if (!q || selected === null) {
      return {
        question: q?.question ?? "",
        answer: "(skipped — unverified)",
        correct: false,
        passed: true,
        skipped: true,
        explanation: "Marked done without answering the check-in.",
      };
    }
    const pick = selected;
    const correct = pick === q.correctIndex;
    return {
      question: q.question,
      options: q.options,
      answer: q.options[pick] ?? "",
      correct,
      passed: true, // quick gate nudges, never hard-blocks — recorded for skill profile
      // §P2: show explanation on BOTH correct and wrong answers (generated
      // inline with the question — no second round-trip).
      explanation: q.explanation,
      difficulty: q.difficulty,
      source: q.source,
    };
  };

  const submit = () => {
    if (!q) return;
    setBusy(true);
    onAnswer(grade());
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div
        data-testid="checkin-modal"
        className="flex max-h-[90vh] w-full max-w-md flex-col rounded-2xl border border-white/10 bg-surface p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-start justify-between gap-2">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-habeet-500/15 text-habeet-300 ring-1 ring-habeet-400/30">
              <HelpCircle className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-gray-50">
                Quick check
              </h2>
              <p className="text-xs text-gray-400">
                Confirm you understood “{pending.stepTitle}” before marking it
                done.
              </p>
            </div>
          </div>
          <button
            onClick={onCancel}
            aria-label="Close check-in"
            className="rounded-md p-1 text-gray-400 outline-none transition hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-habeet-400"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <Loader2 className="h-7 w-7 animate-spin text-habeet-500" />
            <p className="text-sm text-gray-400">Preparing your question…</p>
          </div>
        )}

        {!loading && error && (
          <div className="py-4 text-center">
            <p className="mb-3 text-sm text-amber-300">{error}</p>
            <button
              onClick={() => {
                // Re-run the generation effect by toggling the request key.
                setError(null);
                setLoading(true);
                setRetry((r) => r + 1);
              }}
              data-testid="checkin-retry"
              className="rounded-lg bg-habeet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-habeet-700"
            >
              Try again
            </button>
            <p className="mt-3 text-[11px] text-gray-500">
              This step&apos;s question is required — the step cannot be marked
              done until it is answered.
            </p>
          </div>
        )}
        {!loading && !error && q && (
          <>
            <div className="mb-1 flex items-center gap-2">
              <p className="mb-3 text-sm font-medium leading-snug text-gray-100">
                {q.question}
              </p>
              {q.difficulty && (
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
                    q.difficulty === "easy"
                      ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/30"
                      : q.difficulty === "medium"
                      ? "bg-amberAccent-500/15 text-amberAccent-300 ring-1 ring-amberAccent-400/30"
                      : "bg-red-500/15 text-red-300 ring-1 ring-red-400/30"
                  }`}
                >
                  {q.difficulty}
                </span>
              )}
            </div>
            <div className="space-y-2">
              {q.options.map((opt, i) => {
                const picked = selected === i;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setSelected(i)}
                    data-testid={`checkin-option-${i}`}
                    className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2.5 text-left text-sm transition ${
                      picked
                        ? "border-habeet-500 bg-habeet-500/10 text-gray-50"
                        : "border-white/10 bg-surface-overlay/40 text-gray-300 hover:bg-white/5"
                    }`}
                  >
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] ${
                        picked
                          ? "border-habeet-400 text-habeet-200"
                          : "border-white/20"
                      }`}
                    >
                      {picked ? (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      ) : (
                        String.fromCharCode(65 + i)
                      )}
                    </span>
                    {opt}
                  </button>
                );
              })}
            </div>
            {/* §P5: traceability — show what the question was drawn from. */}
            {q.source && (
              <p className="mt-2 text-[10px] italic text-gray-500">
                based on: {q.source}
              </p>
            )}
            <p className="mt-3 text-[11px] text-gray-500">
              One quick question — your answer feeds your skill profile.
            </p>
          </>
        )}

        <div className="mt-5 flex items-center justify-end gap-2 border-t border-white/10 pt-4">
          <button
            onClick={onCancel}
            className="rounded-lg px-3 py-2 text-sm text-gray-400 transition hover:text-gray-200"
          >
            Not now
          </button>
          {/* WORKFLOW §5: the question is MANDATORY — this control only
              dismisses the modal without completing the step. The step stays
              in STEP_QUESTION_PENDING and can be re-asked any time; it is
              never silently marked done (no `passed = true`). */}
          {!loading && (
            <button
              onClick={onCancel}
              data-testid="checkin-skip"
              className="rounded-lg bg-surface-overlay px-4 py-2 text-sm text-gray-200 ring-1 ring-white/10 transition hover:bg-white/5"
            >
              Answer later
            </button>
          )}
          {!loading && q && (
            <button
              onClick={submit}
              disabled={selected === null || busy}
              data-testid="checkin-submit"
              className="rounded-lg bg-habeet-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-habeet-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Confirming…" : "Mark done"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
