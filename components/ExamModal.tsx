"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpenCheck,
  CheckCircle2,
  GraduationCap,
  Loader2,
  Send,
  TriangleAlert,
  X,
} from "lucide-react";
import { ExamQuestion, Task, TaskExamResult } from "@/lib/types";

interface ExamModalProps {
  task: Task;
  /** Extra roadmap context (topic/day) so questions target this task. */
  context?: string;
  onClose: () => void;
  /** Persists generated questions onto the task in localStorage. */
  onAttachQuestions: (taskId: string, questions: ExamQuestion[]) => void;
  /** Grades answers via the API and stores the result. */
  onSubmitAnswers: (
    taskId: string,
    questions: ExamQuestion[],
    answers: Record<string, string>
  ) => Promise<TaskExamResult>;
}

type Phase = "generating" | "answering" | "grading" | "result";

/**
 * Per-task exam modal.
 *
 * Opens automatically when a task is marked complete. Shows a short
 * LLM-generated quiz (3-5 questions about THIS task only - not the whole
 * day), scores it, stores pass/needs-review alongside the task in
 * localStorage, and gently suggests a review when the score is low
 * (progress is never hard-blocked).
 */
export default function ExamModal({
  task,
  context,
  onClose,
  onAttachQuestions,
  onSubmitAnswers,
}: ExamModalProps) {
  const [phase, setPhase] = useState<Phase>(
    task.exam && task.exam.questions.length >= 3 ? "answering" : "generating"
  );
  const [questions, setQuestions] = useState<ExamQuestion[]>(
    task.exam?.questions ?? []
  );
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<TaskExamResult | null>(
    task.examResult ?? null
  );
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  // Generate questions once when the task has no stored exam yet.
  useEffect(() => {
    if (startedRef.current) return;
    if (task.exam && task.exam.questions.length >= 3) return;
    startedRef.current = true;
    (async () => {
      setError(null);
      try {
        const res = await fetch("/api/generate-exam", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskName: task.name, context }),
        });
        const data = (await res.json()) as {
          questions?: ExamQuestion[];
          error?: string;
        };
        if (!res.ok || !data.questions || data.questions.length === 0) {
          throw new Error(data.error ?? "Could not generate the exam.");
        }
        setQuestions(data.questions);
        onAttachQuestions(task.id, data.questions);
        setPhase("answering");
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to generate the exam."
        );
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allAnswered =
    questions.length > 0 &&
    questions.every((q) => (answers[q.id] ?? "").trim().length > 0);

  const handleSubmit = useCallback(async () => {
    if (!allAnswered || phase !== "answering") return;
    setPhase("grading");
    setError(null);
    try {
      const r = await onSubmitAnswers(task.id, questions, answers);
      setResult(r);
      setPhase("result");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to grade the exam.");
      setPhase("answering");
    }
  }, [allAnswered, answers, onSubmitAnswers, phase, questions, task.id]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Exam for ${task.name}`}
    >
      <div
        className="animate-pop-in flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl dark:bg-gray-800"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <GraduationCap className="h-5 w-5 shrink-0 text-tomato-600" />
            <div>
              <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">
                {phase === "result" ? "Your results" : "Quick knowledge check"}
              </h2>
              <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                Just for this task: {task.name}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close exam"
            className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto px-5 py-4">
          {error && (
            <p
              role="alert"
              className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/30 dark:text-red-300"
            >
              {error}
            </p>
          )}

          {phase === "generating" && (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <Loader2 className="h-8 w-8 animate-spin text-tomato-500" />
              <p className="text-sm font-medium text-gray-600 dark:text-gray-300">
                Cooking up a few questions about this task…
              </p>
            </div>
          )}

          {phase === "answering" && (
            <div className="space-y-5">
              {questions.map((q, idx) => (
                <div
                  key={q.id}
                  className="rounded-xl border border-gray-100 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900"
                >
                  <p className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {idx + 1}. {q.prompt}
                    <span className="ml-2 rounded-full bg-gray-200 px-2 py-0.5 align-middle text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                      {q.type === "multiple_choice" ? "Choose one" : "Short answer"}
                    </span>
                  </p>
                  {q.type === "multiple_choice" ? (
                    <div className="space-y-1.5">
                      {(q.options ?? []).map((opt) => {
                        const selected = answers[q.id] === opt;
                        return (
                          <label
                            key={opt}
                            className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                              selected
                                ? "border-tomato-400 bg-tomato-50 text-tomato-800 dark:border-tomato-600 dark:bg-tomato-900/30 dark:text-tomato-200"
                                : "border-gray-200 bg-white hover:border-tomato-300 dark:border-gray-600 dark:bg-gray-800"
                            }`}
                          >
                            <input
                              type="radio"
                              name={`q-${q.id}`}
                              checked={selected}
                              onChange={() =>
                                setAnswers((prev) => ({ ...prev, [q.id]: opt }))
                              }
                              className="accent-tomato-600"
                            />
                            <span className="text-gray-800 dark:text-gray-100">{opt}</span>
                          </label>
                        );
                      })}
                    </div>
                  ) : (
                    <textarea
                      value={answers[q.id] ?? ""}
                      onChange={(e) =>
                        setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                      }
                      rows={3}
                      placeholder="Answer in a sentence or two…"
                      className="w-full resize-y rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-tomato-500 focus:ring-2 focus:ring-tomato-500/30 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {phase === "grading" && (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <Loader2 className="h-8 w-8 animate-spin text-tomato-500" />
              <p className="text-sm font-medium text-gray-600 dark:text-gray-300">
                Checking your answers…
              </p>
            </div>
          )}

          {phase === "result" && result && (
            <div className="flex flex-col items-center gap-4 py-4 text-center">
              <div
                className={`flex h-24 w-24 flex-col items-center justify-center rounded-full border-8 ${
                  result.passed
                    ? "border-emerald-400 text-emerald-600 dark:text-emerald-400"
                    : "border-amber-400 text-amber-600 dark:text-amber-400"
                }`}
              >
                <span className="text-2xl font-extrabold">{result.score}%</span>
                <span className="text-[10px] font-semibold uppercase tracking-wide">
                  score
                </span>
              </div>
              <span
                className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${
                  result.passed
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                    : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                }`}
              >
                {result.passed ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5" /> Passed
                  </>
                ) : (
                  <>
                    <TriangleAlert className="h-3.5 w-3.5" /> Needs review
                  </>
                )}
              </span>

              {/* Gentle AI feedback — never hard-blocks progress */}
              <p className="max-w-md text-sm text-gray-700 dark:text-gray-200">
                {result.message}
              </p>
              {!result.passed && (
                <div className="flex max-w-md items-start gap-2 rounded-xl bg-sky-50 px-4 py-3 text-left text-sm text-sky-800 dark:bg-sky-900/30 dark:text-sky-200">
                  <BookOpenCheck className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    No rush — consider a quick review of{" "}
                    <span className="font-semibold">{task.name}</span> before
                    diving into the next task.
                  </span>
                </div>
              )}
            </div>
          )}


        </div>
        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-4 dark:border-gray-700">
          {phase === "answering" && (
            <button
              onClick={handleSubmit}
              disabled={!allAnswered}
              className="flex items-center gap-2 rounded-lg bg-tomato-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-tomato-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
              Submit answers
            </button>
          )}
          {phase === "result" && (
            <button
              onClick={onClose}
              className="rounded-lg bg-tomato-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-tomato-700 active:scale-95"
            >
              Done
            </button>
          )}
        </div>

      </div>
    </div>
  );
}
