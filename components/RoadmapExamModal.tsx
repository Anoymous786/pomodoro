"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, GraduationCap, Loader2, Trophy, X } from "lucide-react";
import { apiPost } from "@/lib/api";
import type { RoadmapExamQuestion, RoadmapExamResult } from "@/lib/types";

/** §12 full-roadmap mock exam length (matches the generate route). */
const ROADMAP_EXAM_COUNT = 20;

export interface PendingRoadmapExamData {
  taskId: string;
  taskName: string;
  stepIdsDone: string[];
}

export interface DayTopicRef {
  day: number;
  title: string;
}

interface RoadmapExamModalProps {
  pending: PendingRoadmapExamData;
  topicLabel: string;
  dayTopics: DayTopicRef[];
  onClose: () => void;
  onComplete: (result: RoadmapExamResult) => void;
}

type Phase = "generating" | "answering" | "result";

const RETAKE_TEXT =
  "This mock exam measures how much of the roadmap stuck. ~20 questions, one per subtopic, graded by topic.";

/**
 * §12 FULL-ROADMAP mock exam (~20 MCQ). Runs when every day/steps of a roadmap
 * are genuinely complete, grades the attempt, shows score/20 + percentage + a
 * per-topic breakdown, and hands the graded result to completeRoadmapExam()
 * which recomputes the persistent skill profile.
 */
export default function RoadmapExamModal({
  pending,
  topicLabel,
  dayTopics,
  onClose,
  onComplete,
}: RoadmapExamModalProps) {
  const [phase, setPhase] = useState<Phase>("generating");
  const [questions, setQuestions] = useState<RoadmapExamQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<RoadmapExamResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (started) return;
    if (phase !== "generating") return;
    setStarted(true);
    const load = async () => {
      try {
        const res = await apiPost("/api/generate-roadmap-exam", {
          topicLabel,
          dayTopics,
          questionCount: ROADMAP_EXAM_COUNT,
        });
        const data = (await res.json()) as {
          questions?: RoadmapExamQuestion[];
          error?: string;
        };
        if (!res.ok || !data.questions || data.questions.length === 0) {
          throw new Error(data.error ?? "Couldn't prepare the mock exam.");
        }
        setQuestions(data.questions);
        setPhase("answering");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Mock exam unavailable.");
        // Fall back to a result-only view with zeroed score so we never block.
        setPhase("result");
        setResult({
          score: 0,
          pct: 0,
          total: ROADMAP_EXAM_COUNT,
          passed: false,
          breakdown: {},
          answers: {},
          gradedAt: Date.now(),
        });
      }
    };
    load();
  }, [phase, started, topicLabel, dayTopics]);
  const answeredCount = useMemo(() => Object.keys(answers).length, [answers]);

  const submit = () => {
    if (questions.length === 0) return;
    // Grade purely from the questions' referenceAnswer (no second LLM call).
    const breakdown: Record<string, { correct: number; total: number }> = {};
    const gradedAnswers: Record<string, string> = {};
    // §P2: capture each question's explanation (shown on wrong answer).
    const gradedFeedback: Record<string, string> = {};
    let correct = 0;
    for (const q of questions) {
      const chosen = answers[q.id] ?? "";
      gradedAnswers[q.id] = chosen;
      const isCorrect = chosen === q.referenceAnswer;
      // Wrong answer -> show the generated explanation immediately.
      if (!isCorrect && q.explanation) {
        gradedFeedback[q.id] = q.explanation;
      }
      if (isCorrect) correct += 1;
      const b = breakdown[q.topic] ?? { correct: 0, total: 0 };
      b.total += 1;
      if (isCorrect) b.correct += 1;
      breakdown[q.topic] = b;
    }
    const total = questions.length;
    const score = correct;
    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
    // §P2: feed explanation into the result so the result screen can show it.
    setResult({
      score,
      pct,
      total,
      passed: pct >= 60,
      breakdown,
      answers: gradedAnswers,
      feedback: gradedFeedback,
      gradedAt: Date.now(),
    });
    setPhase("result");
  };

  const finish = () => {
    if (result) onComplete(result);
    else onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div
        data-testid="roadmap-exam-modal"
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-surface shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-2 border-b border-white/10 px-5 py-4">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg bg-habeet-500/15 text-habeet-300 ring-1 ring-habeet-400/30">
              {phase === "result" ? (
                <Trophy className="h-5 w-5" />
              ) : (
                <GraduationCap className="h-5 w-5" />
              )}
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-50">
                {phase === "result" ? "Mock exam result" : "Roadmap mock exam"}
              </h2>
              <p className="text-xs text-gray-400">
                {topicLabel} · {questions.length || ROADMAP_EXAM_COUNT}{" "}
                questions
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close mock exam"
            className="rounded-md p-1 text-gray-400 outline-none transition hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-habeet-400"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {phase === "generating" && !error && (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <Loader2 className="h-8 w-8 animate-spin text-habeet-500" />
              <p className="text-sm text-gray-400">
                Building a {ROADMAP_EXAM_COUNT}-question mock exam…{" "}
                {RETAKE_TEXT}
              </p>
            </div>
          )}

          {phase === "answering" && !error && (
            <div className="space-y-5">
              <p className="text-xs text-gray-400">{RETAKE_TEXT}</p>
              {questions.map((q, qi) => (
                <fieldset
                  key={q.id}
                  className="rounded-xl bg-surface-raised p-4 ring-1 ring-white/5"
                >
                  <legend className="mb-1 flex w-full items-center gap-2 text-xs font-medium uppercase tracking-wide text-habeet-300">
                    {qi + 1}. {q.topic}
                    {q.difficulty && (
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
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
                  </legend>
                  <p className="mb-2 text-sm font-medium leading-snug text-gray-100">
                    {q.prompt}
                  </p>
                  {/* §P5: traceability — "based on: <day/task>" caption */}
                  {q.source && (
                    <p className="mb-2 text-[10px] italic text-gray-500">
                      based on: {q.source}
                    </p>
                  )}
                  <div className="space-y-1.5">
                    {q.options.map((opt, oi) => {
                      const chosen = answers[q.id] === opt;
                      return (
                        <button
                          key={oi}
                          type="button"
                          onClick={() =>
                            setAnswers((prev) => ({ ...prev, [q.id]: opt }))
                          }
                          data-testid={`rq-${q.id}-o${oi}`}
                          className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition ${
                            chosen
                              ? "border-habeet-500 bg-habeet-500/10 text-gray-50"
                              : "border-white/10 bg-surface-overlay/40 text-gray-300 hover:bg-white/5"
                          }`}
                        >
                          <span
                            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] ${
                              chosen
                                ? "border-habeet-400 text-habeet-200"
                                : "border-white/20"
                            }`}
                          >
                            {chosen ? (
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            ) : (
                              String.fromCharCode(65 + oi)
                            )}
                          </span>
                          {opt}
                        </button>
                      );
                    })}
                  </div>
                  {/* §P2: once the user has chosen, show the inline explanation
                      (the LLM returns it alongside each question — no extra call). */}
                  {answers[q.id] && (
                    <div className="mt-2 rounded-lg bg-habeet-500/5 px-3 py-2 text-xs leading-snug text-gray-300 ring-1 ring-habeet-500/10">
                      <span className="font-semibold text-habeet-200">
                        {answers[q.id] === q.referenceAnswer
                          ? "✓ Correct"
                          : "✗ "}
                      </span>{" "}
                      {q.explanation ?? ""}
                    </div>
                  )}
                </fieldset>
              ))}
            </div>
          )}
          {phase === "result" && result && (
            <div className="text-center">
              <div
                className={`mx-auto flex h-28 w-28 flex-col items-center justify-center rounded-full border-8 ${
                  result.passed
                    ? "border-emerald-400 text-emerald-500"
                    : "border-amber-400 text-amber-500"
                }`}
              >
                <span className="text-3xl font-extrabold">
                  {result.score}/{result.total}
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-wide">
                  {result.pct}%
                </span>
              </div>
              <p
                className={`mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${
                  result.passed
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                    : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                }`}
              >
                {result.passed ? "Passed" : "Needs review"} — {result.pct}%
              </p>
              <div className="mt-5 space-y-1.5 text-left">
                {Object.entries(result.breakdown).map(([topic, b]) => (
                  <div
                    key={topic}
                    className="flex items-center justify-between rounded-lg bg-surface-raised px-3 py-2 text-sm ring-1 ring-white/5"
                  >
                    <span className="capitalize text-gray-300">{topic}</span>
                    <span className="font-semibold tabular-nums text-gray-100">
                      {b.correct}/{b.total}
                    </span>
                  </div>
                ))}
                {Object.keys(result.breakdown).length === 0 && (
                  <p className="text-center text-sm text-gray-500">
                    No topic breakdown available.
                  </p>
                )}
                {/* §P2: inline explanation for each wrong answer, directly
                    from the LLM — no second round-trip. */}
                {result.feedback && Object.keys(result.feedback).length > 0 && (
                  <div className="mt-4 space-y-2 border-t border-white/10 pt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-amberAccent-300">
                      Where to improve
                    </p>
                    {questions
                      .filter((q) => result.feedback?.[q.id])
                      .map((q) => (
                        <div
                          key={q.id}
                          className="rounded-lg bg-surface-overlay/60 px-3 py-2 text-xs leading-snug ring-1 ring-white/5"
                        >
                          <p className="font-medium text-gray-200">{q.prompt}</p>
                          <p className="mt-1 text-gray-400">
                            {result.feedback![q.id]}
                          </p>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-white/10 px-5 py-4">
          {phase === "answering" && (
            <button
              onClick={submit}
              disabled={answeredCount < questions.length}
              data-testid="roadmap-exam-submit"
              className="rounded-lg bg-habeet-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-habeet-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Submit ({answeredCount}/{questions.length})
            </button>
          )}
          {phase === "result" && (
            <button
              onClick={finish}
              data-testid="roadmap-exam-done"
              className="rounded-lg bg-habeet-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-habeet-700 active:scale-95"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
