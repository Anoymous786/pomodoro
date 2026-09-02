"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpenCheck,
  CheckCircle2,
  ClipboardCheck,
  Expand,
  GraduationCap,
  Loader2,
  Lock,
  RotateCcw,
  Trophy,
  XCircle,
} from "lucide-react";
import type {
  AssessmentAttempt,
  PracticeTask,
  RoadmapExamQuestion,
} from "@/lib/types";
import React from "react";

/** Server-authoritative day-unlock derivation (mirrors hooks/usePomodoro).
 *  Day N is current while days 1..N-1 are both step-complete AND assessed. */
function isDayComplete(
  steps: { dayNumber?: number; isDone?: boolean }[],
  day: number,
): boolean {
  const daySteps = steps.filter((s) => (s.dayNumber ?? 1) === day);
  if (daySteps.length === 0) return false;
  return daySteps.every((s) => !!s.isDone);
}
function deriveUnlock(task: PracticeTask | null | undefined) {
  const steps = task?.roadmap ?? [];
  const duration = Math.max(1, task?.durationDays ?? 1);
  const assessment = task?.assessment;
  const assessed = new Set(assessment?.completedDays ?? []);
  const completedDays: number[] = [];
  for (let d = 1; d <= duration; d++) {
    if (isDayComplete(steps, d) && assessed.has(d)) completedDays.push(d);
    else break;
  }
  return {
    completedDays,
    currentDay: completedDays.length + 1,
    finalDay: duration,
    allDaysDone: completedDays.length >= duration,
  };
}

export interface TaskAssessmentSectionProps {
  task: PracticeTask | null;
  dayAssessmentPending: { taskId: string; dayNumber: number } | null;
  activeExam: {
    taskId: string;
    taskName: string;
    kind: "day" | "final";
    dayNumber?: number;
    questions: RoadmapExamQuestion[];
    draftAnswers?: Record<string, string>;
    draftCurrent?: number;
  } | null;
  onStartDay: (taskId: string, dayNumber: number) => void | Promise<void>;
  onStartFinal: (taskId: string) => void | Promise<void>;
  onSubmitDay: (
    taskId: string,
    dayNumber: number,
    questions: RoadmapExamQuestion[],
    answers: Record<string, string>,
  ) => void;
  onSubmitFinal: (
    taskId: string,
    questions: RoadmapExamQuestion[],
    answers: Record<string, string>,
  ) => void;
  onSaveDraft: (
    taskId: string,
    examId: string,
    questions: RoadmapExamQuestion[],
    answers: Record<string, string>,
    currentQuestion: number,
  ) => void;
  onReportViolation: (taskId: string, type: "fullscreen" | "visibility") => void;
  onInterrupt: (taskId: string, reason: string) => void;
  onDismiss: () => void;
  onResumeDraft: (
    draft: NonNullable<
      NonNullable<PracticeTask["assessment"]>["examDraft"]
    >,
  ) => void;
}
export default function TaskAssessmentSection({
  task,
  dayAssessmentPending,
  activeExam,
  onStartDay,
  onStartFinal,
  onSubmitDay,
  onSubmitFinal,
  onSaveDraft,
  onReportViolation,
  onInterrupt,
  onDismiss,
  onResumeDraft,
}: TaskAssessmentSectionProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState(0);
  const [examPhase, setExamPhase] = useState<"instructions" | "answering">(
    "instructions",
  );
  const [explanationOpen, setExplanationOpen] = useState(false);
  const [reviewAttempt, setReviewAttempt] = useState<AssessmentAttempt | null>(null);
  const examRef = useRef<HTMLDivElement>(null);
  const fullscreenRef = useRef(false);

  // When a NEW exam (fresh or resumed) becomes active, reset local state.
  // A fresh exam shows the instructions screen first (Req 7); a resumed exam
  // (persisted draft present) jumps straight to answering.
  useEffect(() => {
    setAnswers(activeExam?.draftAnswers ?? {});
    setCurrent(activeExam?.draftCurrent ?? 0);
    setExplanationOpen(false);
    setReviewAttempt(null);
    setExamPhase(activeExam && activeExam.draftAnswers ? "answering" : "instructions");
  }, [activeExam]);

  const hasFinal = !!(task && task.assessment?.exam != null);
  const assessedDays = useMemo(
    () => task?.assessment?.completedDays ?? [],
    [task?.assessment?.completedDays],
  );
  const interruptMarker = task?.assessment?.interruptedAttempt ?? null;

  const unlockDayRows = useMemo(() => {
    const rows: {
      day: number;
      status: "locked" | "in_progress" | "ready" | "completed";
      reason: string;
    }[] = [];
    if (!task) return rows;
    const steps = task.roadmap ?? [];
    const duration = Math.max(1, task.durationDays);
    for (let d = 1; d <= duration; d++) {
      const daySteps = steps.filter((s) => (s.dayNumber ?? 1) === d);
      const assessed = assessedDays.includes(d);
      if (daySteps.length === 0) {
        rows.push({
          day: d,
          status: assessed ? "completed" : "locked",
          reason: "No steps scheduled for this day.",
        });
        continue;
      }
      const allDone = daySteps.every((s) => s.isDone);
      if (assessed && allDone) rows.push({ day: d, status: "completed", reason: "" });
      else if (allDone) {
        rows.push({
          day: d,
          status: "ready",
          reason: "All steps complete — ready to assess.",
        });
      } else {
        const priorReady = d === 1 ? true : rows[d - 2]?.status === "completed";
        const pending = daySteps.find((s) => !s.isDone);
        rows.push({
          day: d,
          status: priorReady ? "in_progress" : "locked",
          reason: priorReady
            ? pending
              ? `Finish the remaining step(s) in Day ${d}, including the verification question.`
              : "Complete every step and its verification question."
            : `Complete and assess Day ${d - 1} first.`,
        });
      }
    }
    return rows;
  }, [task, assessedDays]);

  // Req 4: the Final Exam unlocks ONLY when every day is assessed (persisted
  // results), never from step percentage alone.
  const finalExamAvailable =
    unlockDayRows.length > 0 && unlockDayRows.every((r) => r.status === "completed");
  const finalMissing = hasFinal
    ? []
    : unlockDayRows.filter((r) => r.status !== "completed").map((r) => r.day);
// Req 8: fullscreen + tab-visibility monitoring for the ACTIVE exam.
  // Once the learner begins a monitored attempt, exiting Fullscreen or losing
  // tab focus TERMINATES the attempt (per product policy), persisting an
  // interrupted attempt — the exam requirement NEVER disappears (Req 9).
  useEffect(() => {
    if (!activeExam || activeExam.taskId !== task?.id) return;
    if (examPhase !== "answering") return;
    const taskId = activeExam.taskId;

    let terminatedRef = false;
    const terminate = (reason: string) => {
      if (terminatedRef) return;
      terminatedRef = true;
      onInterrupt(taskId, reason);
    };

    const onFullscreenChange = () => {
      const fs = !!(
        document.fullscreenElement ||
        (document as unknown as { webkitFullscreenElement?: Element })
          .webkitFullscreenElement
      );
      fullscreenRef.current = fs;
      if (!fs) {
        onReportViolation(taskId, "fullscreen");
        terminate("You exited Full Screen during the exam.");
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        onReportViolation(taskId, "visibility");
        terminate("You switched tabs or minimized the browser during the exam.");
      }
    };
    const onBlur = () => {
      if (document.visibilityState === "visible") {
        onReportViolation(taskId, "visibility");
        terminate("You focused on another window during the exam.");
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeExam, examPhase, task?.id]);

  // Req 8: request Fullscreen when the learner presses Start / Resume.
  const enterFullscreen = useCallback(async () => {
    const root = examRef.current ?? document.documentElement;
    try {
      if (!fullscreenRef.current) {
        if (root.requestFullscreen) await root.requestFullscreen();
        else if (
          (root as unknown as { webkitRequestFullscreen?: () => void })
            .webkitRequestFullscreen
        ) {
          (root as unknown as { webkitRequestFullscreen: () => void })
            .webkitRequestFullscreen();
        }
      }
      fullscreenRef.current = !!document.fullscreenElement;
    } catch {
      fullscreenRef.current = false;
    }
  }, []);

  const startExam = useCallback(() => {
    void enterFullscreen();
    if (activeExam) {
      onSaveDraft(
        activeExam.taskId,
        `${activeExam.kind === "final" ? "final" : "day"}-${activeExam.dayNumber ?? "x"}-${task?.id}`,
        activeExam.questions,
        answers,
        current,
      );
    }
    setExamPhase("answering");
  }, [activeExam, task?.id, answers, current, enterFullscreen, onSaveDraft]);

  if (!task) return null;

  // The exam view (opaque, dedicated) is rendered by ExamInterface.
  if (activeExam && activeExam.taskId === task.id) {
    return (
      <ExamInterface
        task={task}
        activeExam={activeExam}
        answers={answers}
        current={current}
        busy={busy}
        examPhase={examPhase}
        explanationOpen={explanationOpen}
        examRef={examRef}
        setCurrent={setCurrent}
        setAnswers={setAnswers}
        setExplanationOpen={setExplanationOpen}
        setExamPhase={setExamPhase}
        startExam={startExam}
        onSaveDraft={onSaveDraft}
        onSubmitDay={onSubmitDay}
        onSubmitFinal={onSubmitFinal}
        onDismiss={onDismiss}
      />
    );
  }
// --- Assessment Hub overview ---------------------------------------------
  const allAttempts = task.assessment?.attempts ?? [];

  return (
    <section data-testid="task-assessment-section" className="mt-6">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-habeet-300">
          <GraduationCap className="h-4 w-4" />
          Assessment Hub
        </h3>
        <span className="text-[11px] text-gray-500">
          {assessedDays.length}/{Math.max(1, task.durationDays)} days assessed
        </span>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        Day Assessments unlock one at a time — start only after each day&apos;s steps
        are complete and verified. The Final Exam unlocks once every day is assessed.
      </p>

      {/* Persistent Day Assessment rows (Req 5: status + why) */}
      <div className="mt-4 space-y-2" data-testid="day-assessment-rows">
        {unlockDayRows.map((row) => (
          <div
            key={row.day}
            data-testid={`day-assessment-row-${row.day}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-white/10 bg-[#18152a] px-3 py-2.5"
          >
            <span className="text-sm font-semibold text-gray-100">Day {row.day}</span>
            {row.status === "completed" ? (
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-200" data-testid={`day-status-${row.day}`}>
                <CheckCircle2 className="mr-0.5 inline h-3 w-3" />
                Completed{dayScoreText(task, row.day)}
              </span>
            ) : row.status === "ready" ? (
              <span className="rounded-full bg-habeet-500/15 px-2 py-0.5 text-[10px] font-semibold text-habeet-200" data-testid={`day-status-${row.day}`}>
                Ready
              </span>
            ) : row.status === "in_progress" ? (
              <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-semibold text-gray-400" data-testid={`day-status-${row.day}`}>
                In progress
              </span>
            ) : (
              <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-semibold text-gray-500" data-testid={`day-status-${row.day}`}>
                <Lock className="mr-0.5 inline h-3 w-3" />
                Locked
              </span>
            )}
            {row.status === "ready" && (
              <button
                onClick={() => void onStartDay(task.id, row.day)}
                disabled={busy}
                data-testid={`start-day-assessment-${row.day}`}
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-habeet-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-habeet-700"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ClipboardCheck className="h-3.5 w-3.5" />}
                Start Assessment
              </button>
            )}
            {row.status !== "completed" && (
              <span className="w-full text-[11px] text-gray-500">{row.reason}</span>
            )}
          </div>
        ))}
      </div>

      {/* Interrupted attempt banner (Req 9: exam still required) */}
      {interruptMarker && (
        <div className="mt-4 rounded-xl border border-amberAccent-500/30 bg-amberAccent-500/10 px-4 py-3" data-testid="interrupted-attempt-banner">
          <p className="flex items-center gap-2 text-sm font-semibold text-amberAccent-200">
            <XCircle className="h-4 w-4" />
            {interruptMarker.kind === "exam"
              ? "Final Exam"
              : `Day ${interruptMarker.day} Assessment`} — Attempt Interrupted
          </p>
          <p className="mt-1 text-[12px] text-gray-300">
            {interruptMarker.reason} ({interruptMarker.answeredCount} answered ·{" "}
            {new Date(interruptMarker.interruptedAt).toLocaleTimeString()}). This
            required assessment is still pending — retry to continue.
          </p>
        </div>
      )}

      {/* Final Exam hub row (Req 4/5: locked until every day assessed) */}
      <div className="mt-6 rounded-xl border border-white/10 bg-[#18152a] p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-2 text-sm font-semibold text-gray-100">
            <Trophy className="h-4 w-4 text-amberAccent-300" />
            Final Assessment
          </span>
          {task.assessment?.exam ? (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-200" data-testid="final-status">
              <CheckCircle2 className="mr-0.5 inline h-3 w-3" />
              Completed · {task.assessment.exam.pct}%
            </span>
          ) : finalExamAvailable ? (
            <span className="rounded-full bg-habeet-500/15 px-2 py-0.5 text-[10px] font-semibold text-habeet-200" data-testid="final-status">
              Ready
            </span>
          ) : interruptMarker?.kind === "exam" ? (
            <span className="rounded-full bg-amberAccent-500/15 px-2 py-0.5 text-[10px] font-semibold text-amberAccent-200" data-testid="final-status">
              Attempt Interrupted
            </span>
          ) : (
            <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-semibold text-gray-500" data-testid="final-status">
              <Lock className="mr-0.5 inline h-3 w-3" />
              Locked
            </span>
          )}
          {finalExamAvailable && !task.assessment?.exam && (
            <button
              onClick={() => void onStartFinal(task.id)}
              disabled={busy}
              data-testid="start-final-exam"
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-habeet-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-habeet-700"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ClipboardCheck className="h-3.5 w-3.5" />}
              Start Final Exam
            </button>
          )}
        </div>
                        {!finalExamAvailable && (
          <p className="mt-2 text-[11px] text-gray-500">
            Complete every Day Assessment first{finalMissing.length ? ` (remaining: Day ${finalMissing.join(", ")})` : ""}.
          </p>
        )}
      </div>



      {/* Attempt history (Req 13: task-specific, reviewable) */}
      {allAttempts.length > 0 && (
        <div className="mt-6">
          <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
            <BookOpenCheck className="h-3.5 w-3.5" />
            Attempt History
          </h4>
          <div className="mt-3 space-y-2" data-testid="attempt-history">
            {allAttempts.map((a, i) => (
              <button
                key={`${a.kind}-${a.attempt}-${i}`}
                onClick={() => setReviewAttempt(a)}
                data-testid={`attempt-${a.kind}-${a.attempt}`}
                className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-[#18152a] px-3 py-2.5 text-left transition hover:border-habeet-400/40"
              >
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${a.attemptState === "interrupted" ? "bg-amberAccent-500/15 text-amberAccent-200" : a.passed ? "bg-emerald-500/15 text-emerald-200" : "bg-rose-500/15 text-rose-200"}`}>
                  {a.attemptState === "interrupted" ? "Interrupted" : a.passed ? "Passed" : "Failed"}
                </span>
                <span className="text-sm font-medium text-gray-100">
                  {a.kind === "exam" ? "Final Exam" : `Day ${a.day} Assessment`}
                </span>
                <span className="ml-auto text-xs text-gray-400">
                  {a.pct}% · {a.score}/{a.total}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Review modal (Req 12: question-by-question review) */}
      {reviewAttempt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" data-testid="review-modal">
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-white/10 bg-surface-raised p-6 shadow-card">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-gray-100">
                Review — {reviewAttempt.kind === "exam" ? "Final Exam" : `Day ${reviewAttempt.day} Assessment`}
              </h3>
              <button onClick={() => setReviewAttempt(null)} className="text-gray-400 hover:text-gray-200" aria-label="Close review">
                <XCircle className="h-5 w-5" />
              </button>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              {reviewAttempt.pct}% · {reviewAttempt.score}/{reviewAttempt.total} · {new Date(reviewAttempt.submittedAt).toLocaleString()}
            </p>
            <div className="mt-4 space-y-3">
              {(reviewAttempt.questionReview ?? []).map((q, idx) => (
                <div key={q.id} className="rounded-xl border border-white/10 bg-[#18152a] p-3">
                  <p className="text-sm font-medium text-gray-100">
                    <span className="text-gray-500">Q{idx + 1}.</span> {q.prompt}
                  </p>
                  <p className={`mt-1 text-xs ${q.correct ? "text-emerald-300" : "text-rose-300"}`}>
                    Your answer: {q.selectedAnswer} {q.correct ? "✓" : `✗ (correct: ${q.correctAnswer})`}
                  </p>
                  {q.explanation && (
                    <p className="mt-1 text-xs text-gray-400">{q.explanation}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
/* ------------------------------------------------------------------ */
/* ExamInterface — opaque, dedicated exam surface (Req 6/7/8/10/11)    */
/* ------------------------------------------------------------------ */

interface ExamInterfaceProps {
  task: PracticeTask;
  activeExam: NonNullable<TaskAssessmentSectionProps["activeExam"]>;
  answers: Record<string, string>;
  current: number;
  busy: boolean;
  examPhase: "instructions" | "answering";
  explanationOpen: boolean;
  examRef: React.RefObject<HTMLDivElement>;
  setCurrent: (n: number) => void;
  setAnswers: (a: Record<string, string>) => void;
      setExplanationOpen: (o: boolean) => void;
  setExamPhase: (p: "instructions" | "answering") => void;
  startExam: () => void;
  onSaveDraft: TaskAssessmentSectionProps["onSaveDraft"];
  onSubmitDay: TaskAssessmentSectionProps["onSubmitDay"];
  onSubmitFinal: TaskAssessmentSectionProps["onSubmitFinal"];
  onDismiss: () => void;
}

function ExamInterface({
  task,
  activeExam,
  answers,
  current,
  busy,
  examPhase,
  explanationOpen,
  examRef,
  setCurrent,
  setAnswers,
  setExplanationOpen,
  setExamPhase,
  startExam,
  onSaveDraft,
  onSubmitDay,
  onSubmitFinal,
  onDismiss,
}: ExamInterfaceProps) {
  const questions = activeExam.questions;
  const total = questions.length;
  const q = questions[current];
  const selected = q ? answers[q.id] : undefined;
  const answeredCount = Object.keys(answers).length;

  // Req 10: explanation is inaccessible until an answer is selected.
  const canShowExplanation = !!q && selected != null;

      const choose = (opt: string) => {
    if (!q) return;
    const next = { ...answers, [q.id]: opt };
    setAnswers(next);
    setExplanationOpen(false);
    // Persist draft on every answer so refresh restores position.
    onSaveDraft(
      activeExam.taskId,
      `${activeExam.kind === "final" ? "final" : "day"}-${activeExam.dayNumber ?? "x"}-${task.id}`,
      questions,
      next,
      current,
    );
  };

  const submit = () => {
    if (activeExam.kind === "final") {
      onSubmitFinal(activeExam.taskId, questions, answers);
    } else if (activeExam.dayNumber != null) {
      onSubmitDay(activeExam.taskId, activeExam.dayNumber, questions, answers);
    }
  };

  // Req 7: instruction screen BEFORE the exam begins.
  if (examPhase === "instructions") {
    return (
      <div ref={examRef} className="fixed inset-0 z-50 flex items-center justify-center bg-surface p-6" data-testid="exam-instructions">
        <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-surface-raised p-8 shadow-card">
          <h2 className="text-xl font-bold text-gray-50">
            {activeExam.kind === "final" ? "Final Exam" : `Day ${activeExam.dayNumber} Assessment`}
          </h2>
          <p className="mt-1 text-sm text-gray-400">{activeExam.taskName}</p>

          <ul className="mt-6 space-y-2 text-sm text-gray-300">
            <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-habeet-300" /> {total} questions — take your time.</li>
            <li className="flex gap-2"><Expand className="mt-0.5 h-4 w-4 shrink-0 text-habeet-300" /> Once you begin, the assessment runs in Full Screen.</li>
            <li className="flex gap-2"><Lock className="mt-0.5 h-4 w-4 shrink-0 text-habeet-300" /> Leaving Full Screen or switching tabs will terminate this attempt.</li>
            <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-habeet-300" /> Your answers and progress are saved as you go.</li>
            <li className="flex gap-2"><BookOpenCheck className="mt-0.5 h-4 w-4 shrink-0 text-habeet-300" /> After submission you can review every question with explanations.</li>
          </ul>

          <div className="mt-8 flex items-center justify-between gap-3">
            <button onClick={onDismiss} className="rounded-lg border border-white/10 px-4 py-2 text-sm text-gray-300 hover:bg-white/5">
              Back to Hub
            </button>
            <button
              onClick={startExam}
              className="inline-flex items-center gap-2 rounded-lg bg-habeet-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-habeet-700"
            >
              <ClipboardCheck className="h-4 w-4" />
              Start Exam
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Req 6/8: opaque answering surface — underlying roadmap NOT visible.
  return (
    <div ref={examRef} className="fixed inset-0 z-50 flex flex-col bg-surface" data-testid="exam-surface">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-white/10 px-6 py-3">
        <div>
          <p className="text-sm font-semibold text-gray-50">
            {activeExam.kind === "final" ? "Final Exam" : `Day ${activeExam.dayNumber} Assessment`}
          </p>
          <p className="text-xs text-gray-400">{activeExam.taskName}</p>
        </div>
        <div className="flex items-center gap-4 text-xs text-gray-400">
          <span>Question {current + 1} / {total}</span>
          <span>{answeredCount} answered</span>
        </div>
      </div>

      {/* Question body */}
      <div className="flex-1 overflow-y-auto px-6 py-8">
        <div className="mx-auto max-w-2xl">
          <p className="text-lg font-medium text-gray-50">{q?.prompt}</p>

          <div className="mt-6 space-y-3">
            {q?.options.map((opt) => {
              const isSel = selected === opt;
              return (
                <button
                  key={opt}
                  onClick={() => choose(opt)}
                  className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm transition ${isSel ? "border-habeet-400 bg-habeet-500/15 text-gray-50" : "border-white/10 bg-surface-raised text-gray-200 hover:border-habeet-400/40"}`}
                >
                  <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] ${isSel ? "border-habeet-300 bg-habeet-500 text-white" : "border-white/20 text-gray-400"}`}>
                    {isSel ? "●" : ""}
                  </span>
                  {opt}
                </button>
              );
            })}
          </div>

          {/* Req 10/11: explanation gated until an answer is selected */}
          <div className="mt-6">
            <button
              onClick={() => setExplanationOpen(!explanationOpen)}
              disabled={!canShowExplanation}
              data-testid="show-explanation"
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium ${canShowExplanation ? "bg-habeet-600 text-white hover:bg-habeet-700" : "cursor-not-allowed bg-white/5 text-gray-600"}`}
            >
              <BookOpenCheck className="h-4 w-4" />
              {explanationOpen ? "Hide" : "Show"} Explanation
            </button>
            {explanationOpen && canShowExplanation && q && (
              <div className="mt-3 rounded-xl border border-white/10 bg-[#18152a] p-4 text-sm text-gray-300" data-testid="explanation-text">
                {selected === q.referenceAnswer ? (
                  <>Correct — {q.explanation || "This is the right answer."}</>
                ) : (
                  <>Not quite. The correct answer is <span className="font-semibold text-gray-100">{q.referenceAnswer}</span>. {q.explanation || ""}</>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom nav */}
      <div className="flex items-center justify-between border-t border-white/10 px-6 py-3">
        <button
          onClick={() => setCurrent(Math.max(0, current - 1))}
          disabled={current === 0}
          className="rounded-lg border border-white/10 px-4 py-2 text-sm text-gray-300 hover:bg-white/5 disabled:opacity-40"
        >
          Previous
        </button>
        {current < total - 1 ? (
          <button
            onClick={() => setCurrent(current + 1)}
            className="rounded-lg bg-habeet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-habeet-700"
          >
            Next
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={busy}
            data-testid="submit-exam"
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Submit Exam
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Req 5: compact " — 82%" suffix for a completed day in the hub. */
function dayScoreText(task: PracticeTask, day: number): string {
  const s = task.assessment?.dayScores?.[String(day)];
  return s ? ` — ${s.pct}%` : "";
}
