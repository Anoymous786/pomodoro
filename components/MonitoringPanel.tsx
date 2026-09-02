"use client";

import { useState } from "react";
import {
  BarChart3,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Eye,
  GraduationCap,
  Trophy,
  XCircle,
} from "lucide-react";
import {
  formatMonitoringDuration,
  getTaskPerformance,
  type TaskMonitoring,
} from "@/lib/monitoring";
import type { AssessmentAttempt, PracticeTask } from "@/lib/types";

/**
 * Task-local monitoring panel (Phase 2, Reqs 2–6/12/13).
 * Reads PERSISTED real data for exactly ONE task (never merged with other
 * tasks). Active time never includes breaks/pauses (uses practicedSeconds).
 */
export default function MonitoringPanel({ task }: { task: PracticeTask }) {
  const perf: TaskMonitoring = getTaskPerformance(task);
  const [review, setReview] = useState<AssessmentAttempt | null>(null);
  const dayDelta = perf.earlyLateSeconds;

  return (
    <section data-testid={`monitoring-${task.id}`} className="rounded-2xl border border-white/10 bg-surface-raised p-5 shadow-card">
      <header className="flex items-center gap-2">
        <BarChart3 className="h-4 w-4 text-habeet-300" />
        <h3 className="text-sm font-semibold text-gray-50">Monitoring — {task.name}</h3>
      </header>

      {/* OVERVIEW */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Roadmap" value={`${perf.completedDays}/${perf.totalDays} days`} />
        <Stat label="Steps" value={`${perf.completedSteps}/${perf.totalSteps}`} />
        <Stat label="Estimated" value={perf.estimatedLabel} />
        <Stat label="Actual Practice" value={perf.practicedLabel} accent="text-habeet-200" />
      </div>

      {/* Knowledge + completion */}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-400">
        <span data-testid="monitoring-completion" className="rounded-full bg-white/5 px-2 py-0.5">
          {perf.completionPct}% complete
        </span>
        {perf.knowledgePct != null ? (
          <span data-testid="monitoring-knowledge" className="rounded-full bg-habeet-500/15 px-2 py-0.5 text-habeet-200">
            Knowledge: {perf.knowledgePct}% (from assessments)
          </span>
        ) : (
          <span data-testid="monitoring-knowledge-none" className="rounded-full bg-white/5 px-2 py-0.5">
            Not enough assessment data yet
          </span>
        )}
        <span className="rounded-full bg-white/5 px-2 py-0.5">
          Status: {perf.status.replace(/_/g, " ")}
        </span>
      </div>

      {/* Time delta (Req 3) */}
      <div className="mt-3 flex items-center gap-2 text-sm">
        <Clock className="h-4 w-4 text-gray-500" />
        <span className="text-gray-400">Estimated vs actual:</span>
        <span
          data-testid="monitoring-time-delta"
          className={`font-medium ${dayDelta <= 0 ? "text-emerald-300" : "text-amberAccent-300"}`}
        >
          {dayDelta < 0 ? "" : dayDelta > 0 ? "+" : ""}
          {formatMonitoringDuration(Math.abs(dayDelta))}
          {dayDelta < 0 ? " ahead" : dayDelta > 0 ? " over" : ""}
        </span>
      </div>

      {/* ASSESSMENTS (Req 6) */}
      <div className="mt-5">
        <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          <ClipboardCheck className="h-3.5 w-3.5" /> Assessments
        </h4>
        <ul className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="monitoring-assessments">
          {perf.days.filter((d) => d.assessment).map((d) => (
            <li key={d.day} className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-2">
              <CheckCircle2 className={`h-4 w-4 ${d.assessment!.passed ? "text-emerald-300" : "text-amberAccent-300"}`} />
              <span className="text-xs text-gray-400">Day {d.day}</span>
              <span className="ml-auto text-sm font-semibold text-gray-100">{d.assessment!.pct}%</span>
            </li>
          ))}
          {perf.assessment.finalExam ? (
            <li className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-2">
              <Trophy className={`h-4 w-4 ${perf.assessment.finalExam.passed ? "text-emerald-300" : "text-amberAccent-300"}`} />
              <span className="text-xs text-gray-400">Final</span>
              <span className="ml-auto text-sm font-semibold text-gray-100">{perf.assessment.finalExam.pct}%</span>
            </li>
          ) : (
            <li className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-2">
              <Trophy className="h-4 w-4 text-gray-600" />
              <span className="text-xs text-gray-500">Final</span>
              <span className="ml-auto text-xs text-gray-500">n/a</span>
            </li>
          )}
        </ul>
      </div>
{/* TIME ANALYTICS (Req 4) */}
      <div className="mt-5">
        <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          <Clock className="h-3.5 w-3.5" /> Time Analytics (active time only)
        </h4>
        <ul className="mt-2 space-y-1.5" data-testid="monitoring-time-analytics">
          {perf.days.map((d) => {
            const actual = formatMonitoringDuration(d.practicedSeconds);
            const estimated = formatMonitoringDuration(d.estimatedMinutes * 60);
            const diff = d.practicedSeconds - d.estimatedMinutes * 60;
            return (
              <li key={d.day} className="flex items-center justify-between rounded-lg bg-black/20 px-3 py-2 text-xs">
                <span className="font-medium text-gray-200">Day {d.day}</span>
                <span className="text-gray-400">Est {estimated} · Actual {actual}</span>
                <span className={diff <= 0 ? "text-emerald-300" : "text-amberAccent-300"}>
                  {diff < 0 ? "" : diff > 0 ? "+" : ""}
                  {formatMonitoringDuration(Math.abs(diff))}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      {/* ATTEMPT HISTORY + REVIEW (Req 6/12) */}
      <div className="mt-5">
        <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          <GraduationCap className="h-3.5 w-3.5" /> Attempt History ({perf.attempts.length})
        </h4>
        <ul className="mt-2 space-y-1.5" data-testid="monitoring-attempts">
          {perf.attempts.map((att) => (
            <li key={`${att.examId}-${att.attempt}`} className="flex items-center gap-3 rounded-lg bg-black/20 px-3 py-2 text-xs">
              {att.attemptState === "interrupted" ? (
                <XCircle className="h-4 w-4 text-amberAccent-300" />
              ) : (
                <CheckCircle2 className={`h-4 w-4 ${att.passed ? "text-emerald-300" : "text-amberAccent-300"}`} />
              )}
              <span className="text-gray-300">
                {att.kind === "exam" ? "Final" : `Day ${att.day}`} · attempt {att.attempt}
              </span>
              {att.attemptState === "interrupted" ? (
                <span className="text-gray-500">Interrupted</span>
              ) : (
                <span className={`font-semibold ${att.passed ? "text-emerald-300" : "text-amberAccent-300"}`}>{att.pct}%</span>
              )}
              {att.attemptState === "completed" && att.questionReview && att.questionReview.length > 0 && (
                <button
                  onClick={() => setReview(att)}
                  data-testid={`monitoring-review-${att.kind}-${att.attempt}`}
                  className="ml-auto inline-flex items-center gap-1 rounded-md bg-white/5 px-2 py-1 text-gray-300 hover:bg-white/10"
                >
                  <Eye className="h-3.5 w-3.5" /> Review
                </button>
              )}
            </li>
          ))}
          {perf.attempts.length === 0 && (
            <li className="text-xs text-gray-500">No attempts yet.</li>
          )}
        </ul>
      </div>

      {review && <ReviewModal attempt={review} onClose={() => setReview(null)} />}
    </section>
  );
}

function Stat({ label, value, accent = "text-gray-100" }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-lg bg-black/20 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`mt-0.5 text-sm font-semibold tabular-nums ${accent}`}>{value}</p>
    </div>
  );
}
function ReviewModal({ attempt, onClose }: { attempt: AssessmentAttempt; onClose: () => void }) {
  const qr = attempt.questionReview ?? [];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" data-testid="monitoring-review-modal">
      <div className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-white/10 bg-surface-raised p-6 shadow-card">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-gray-50">
            {attempt.kind === "exam" ? "Final Exam" : `Day ${attempt.day}`} — attempt {attempt.attempt}
          </h4>
          <button onClick={onClose} className="rounded-lg bg-white/5 px-3 py-1.5 text-sm text-gray-300 hover:bg-white/10">
            Close
          </button>
        </div>
        <p className="mt-1 text-xs text-gray-400">
          Score {attempt.pct}% · {attempt.score}/{attempt.total} · {attempt.passed ? "Passed" : "Not passed"}
          {typeof attempt.durationSeconds === "number" ? ` · ${formatMonitoringDuration(attempt.durationSeconds)}` : ""}
        </p>
        <ul className="mt-4 space-y-3">
          {qr.map((q, i) => (
            <li key={q.id} className={`rounded-lg border px-3 py-2 text-sm ${q.correct ? "border-emerald-500/30 bg-emerald-500/5" : "border-amberAccent-500/30 bg-amberAccent-500/5"}`}>
              <p className="font-medium text-gray-100">{i + 1}. {q.prompt}</p>
              <p className="mt-1 text-xs text-gray-300">Your answer: {q.selectedAnswer}</p>
              {!q.correct && (
                <p className="text-xs text-emerald-300">Correct: {q.correctAnswer}</p>
              )}
              {q.explanation && <p className="mt-1 text-xs text-gray-400">{q.explanation}</p>}
            </li>
          ))}
          {qr.length === 0 && <li className="text-xs text-gray-500">No question review available for this attempt.</li>}
        </ul>
      </div>
    </div>
  );
}