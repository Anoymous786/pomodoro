"use client";

import { Fragment, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Clock,
  ExternalLink,
  ListChecks,
  Loader2,
  Lock,
  HelpCircle,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  SearchX,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { usePomodoro } from "@/hooks/usePomodoro";
import { practiceWindow } from "@/lib/practice";
import {
  formatClock,
  formatDuration,
  formatEstimated,
  parseDurationInput,
  roadmapTimeProgress,
  stepsFromGeneratedDays,
  stepSimSeconds,
  totalEstimatedMinutes,
  totalSimSeconds,
} from "@/lib/task-roadmap";
import { apiPost, generateRoadmapRemote, isRemoteApi } from "@/lib/api";
import { showToast } from "@/lib/toast";
import { labelIST, labelLongIST } from "@/lib/date-ist";
import type { IntakeContext, RoadmapStep } from "@/lib/types";
import CircleCheckbox from "@/components/habeet/CircleCheckbox";
import CheckInModal, { type CheckInAnswer } from "@/components/CheckInModal";
import TaskAssessmentSection from "@/components/TaskAssessmentSection";
import MonitoringPanel from "@/components/MonitoringPanel";
import AssistantChat, { type ChatGrounding } from "@/components/AssistantChat";
import IntakeFlow from "@/components/IntakeFlow";
import {
  syncCompletedDays,
  isStepStartable,
  stepLockReason,
  dayStatus,
  taskStatus,
} from "@/lib/task-roadmap";

/** Status chip styles shared with the dashboard cards. */
const STATUS_STYLE: Record<string, string> = {
  "In Progress": "bg-habeet-500/15 text-habeet-200 ring-habeet-400/40",
  Completed: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30",
  Overdue: "bg-amber-500/10 text-amber-300 ring-amber-400/30",
  "Not Started": "bg-white/5 text-gray-400 ring-white/10",
};

/**
 * /task/[id] — a task's dedicated workspace.
 *
 * Everything here belongs to EXACTLY ONE task: its IST date window
 * (Day 1 = creation day), daily check-ins and its own independent roadmap.
 * Steps can be added, edited, deleted and reordered, or generated with the
 * existing AI roadmap feature (attached to this task only).
 */
export default function TaskWorkspacePage() {
  const params = useParams<{ id: string }>();
  const taskId = params?.id ?? "";
  const router = useRouter();

  const {
    practiceTasks,
    hydrated,
    now,
    setTaskRoadmap,
    addTaskRoadmapStep,
    updateTaskRoadmapStep,
    deleteTaskRoadmapStep,
    toggleTaskRoadmapStep,
    moveTaskRoadmapStep,
    setStepEstimatedMinutes,
    startStepTimer,
    pauseStepTimer,
    resumeStepTimer,
    finishStepTimer,
    reopenStepTimer,
    requestStepQuestion,
    // §11/§12/§13 + PART 2: check-in gate, Day Assessments, Final Exam, skill profile
    pendingCheckIn,
    dismissCheckIn,
    completeStep,
    dayAssessmentPending,
    activeExam,
    startDayAssessment,
    submitDayAssessment,
    startFinalExam,
    submitFinalExam,
    saveExamDraft,
    reportExamViolation,
    interruptActiveExam,
    dismissActiveExam,
    resumeExamDraft,
    skillProfiles,
    roadmapExamResults,
  } = usePomodoro();

  // ---- Local UI state (never persisted) ----
  const [newTitle, setNewTitle] = useState("");
  /** §P3: mid-roadmap edit — the user's natural-language request. */
  const [editRequest, setEditRequest] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const [editResult, setEditResult] = useState<string | null>(null);
  /** id of the step currently being edited inline (null = none). */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editNote, setEditNote] = useState("");
  /** Duration being edited; plain string so "2h 30m" types freely. */
  const [editDuration, setEditDuration] = useState("");
  /** AI generation button lifecycle. */
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  /**
   * §7: "Generate with AI" ALWAYS routes through the conversational intake
   * first (AI decides the question count; total days + minutes/day are
   * mandatory before any roadmap is generated). The task's own durationDays
   * pre-answers the days question; only time-per-day must still be asked.
   */
  const [intakeOpen, setIntakeOpen] = useState(false);

  const task = useMemo(
    () => practiceTasks.find((t) => t.id === taskId) ?? null,
    [practiceTasks, taskId],
  );

  // ---- Derived data (only meaningful once hydrated) ----
  const w = task ? practiceWindow(task) : null;
  const steps = useMemo(() => task?.roadmap ?? [], [task?.roadmap]);
  // WORKFLOW §1: sequential step-lock input — the day-assessment state.
  const assessmentLock = useMemo(
    () => ({ completedDays: task?.assessment?.completedDays ?? [] }),
    [task?.assessment?.completedDays],
  );
  // Live-aware time summary: counts move in real time while a step runs.
  const estTotalMin = totalEstimatedMinutes(steps);
  const estTotalSec = estTotalMin * 60;
  const practicedTotal = totalSimSeconds(steps, now);
  const remainingTotal = Math.max(0, estTotalSec - practicedTotal);
  const tprog = roadmapTimeProgress(steps, now);
  // WORKFLOW §14: the task's own status — step completion alone NEVER marks a
  // learning task complete; it must pass the Day Assessments + Final Exam.
  const ts = task
    ? taskStatus(task)
    : { status: "active" as const, daysDone: 0, daysTotal: 0 };

  // §12 DAY-GROUPED UI: derive one group per plan day present in the roadmap,
  // in ascending order, with per-day progress/lock state. Days beyond the
  // last unlocked one stay locked until every prior day is complete.
  const dayGroups = useMemo(() => {
    const map = new Map<number, {
      day: number;
      title: string;
      steps: RoadmapStep[];
      done: number;
      estMinutes: number;
      practicedSeconds: number;
    }>();
    for (const s of steps) {
      const d = s.dayNumber ?? 1;
      let g = map.get(d);
      if (!g) {
        g = { day: d, title: s.dayTitle ?? `Day ${d}`, steps: [], done: 0, estMinutes: 0, practicedSeconds: 0 };
        map.set(d, g);
      }
      if (!g.title.startsWith("Day ") && s.dayTitle && g.title.startsWith("Day ")) {
        g.title = s.dayTitle;
      }
      g.steps.push(s);
      if (s.isDone) g.done += 1;
      g.estMinutes += s.estimated_minutes ?? 0;
      g.practicedSeconds += stepSimSeconds(s, now);
    }
    return Array.from(map.values()).sort((a, b) => a.day - b.day);
  }, [steps, now]);

  // WORKFLOW §6: per-day status — a day is NEVER "completed" from step counts
  // alone. Once its steps are done it becomes "assessment_ready" and only the
  // submitted Day Assessment (persisted assessment.completedDays) completes it.
  const dayStatuses = useMemo(() => {
    const assessedDays = task?.assessment?.completedDays ?? [];
    const out: Record<number, ReturnType<typeof dayStatus>> = {};
    for (const g of dayGroups) {
      out[g.day] = dayStatus(steps, g.day, assessedDays);
    }
    return out;
  }, [dayGroups, steps, task?.assessment?.completedDays]);

  // §6: grounding for the assistant — the user's REAL tracked data only.
  const chatGrounding = useMemo<ChatGrounding>(
    () => ({
      skillProfiles,
      roadmapExamResults,
      practiceTasks: practiceTasks.map((t) => ({
        id: t.id,
        name: t.name,
        durationDays: t.durationDays,
        is_completed: t.is_completed,
        roadmap: t.roadmap,
        assessment: t.assessment,
      })),
    }),
    [skillProfiles, roadmapExamResults, practiceTasks],
  );

  /** Appends a step from the add form. */
  const handleAddStep = () => {
    if (!task || !newTitle.trim()) return;
    addTaskRoadmapStep(task.id, newTitle);
    setNewTitle("");
  };

  /** §P3: mid-roadmap edit — send request + current steps to the LLM, then
   *  apply the single targeted insert (preserving all existing progress). */
  const handleRoadmapEdit = async () => {
    if (!task || !editRequest.trim() || steps.length === 0) return;
    setEditLoading(true);
    setEditResult(null);
    try {
      const res = await apiPost("/api/roadmap-edit", {
        topic: task.name,
        request: editRequest.trim(),
        steps: steps.map((s) => ({
          day: s.dayNumber ?? 1,
          title: s.title,
        })),
      });
      const data = (await res.json()) as {
        summary?: string;
        insertBefore?: string;
        newTaskName?: string;
        reason?: string;
        error?: string;
      };
      if (!res.ok || !data.summary || !data.newTaskName) {
        throw new Error(data.error ?? "Couldn't plan the edit.");
      }
      // Apply the insertion — after the referenced step (or at the end).
      if (data.insertBefore) {
        const beforeIndex = steps.findIndex(
          (s) => s.title === data.insertBefore,
        );
        const target = beforeIndex >= 0 ? beforeIndex : steps.length - 1;
        // insert AFTER the target (keep existing progress untouched).
        const insertAt = target + 1;
        const newStep = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          title: data.newTaskName,
          note: data.reason,
          dayNumber: steps[Math.min(insertAt - 1, steps.length - 1)]?.dayNumber ?? 1,
          isDone: false,
          practicedSeconds: 0,
          elapsedSeconds: 0,
          timerStatus: "idle" as const,
        };
        const next = [...steps];
        next.splice(insertAt, 0, newStep);
        setTaskRoadmap(task.id, next);
      } else {
        addTaskRoadmapStep(task.id, data.newTaskName, data.reason);
      }
      setEditResult(data.summary);
      setEditRequest("");
      showToast("Roadmap updated — new prerequisite added 🧠", "success");
    } catch (e) {
      setEditResult(
        e instanceof Error ? e.message : "Failed to plan the edit.",
      );
    } finally {
      setEditLoading(false);
    }
  };

  const startEdit = (step: {
    id: string;
    title: string;
    note?: string;
    estimated_minutes?: number;
  }) => {
    setEditingId(step.id);
    setEditTitle(step.title);
    setEditNote(step.note ?? "");
    setEditDuration(
      step.estimated_minutes ? formatEstimated(step.estimated_minutes) : "",
    );
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditTitle("");
    setEditNote("");
    setEditDuration("");
  };

  const saveEdit = (stepId: string) => {
    if (!task) return;
    if (!editTitle.trim()) {
      showToast("Step title can't be empty.", "error");
      return;
    }
    updateTaskRoadmapStep(task.id, stepId, {
      title: editTitle,
      note: editNote.trim() ? editNote : null,
    });
    // Persist the estimated duration (accept "2h", "45m", "1h 30m", "90").
    const parsed = editDuration.trim()
      ? parseDurationInput(editDuration)
      : null;
    if (parsed != null) {
      setStepEstimatedMinutes(task.id, stepId, parsed);
    } else if (editDuration.trim()) {
      showToast('Use a format like "2h", "45m" or "1h 30m".', "error");
    } else {
      setStepEstimatedMinutes(task.id, stepId, null);
    }
    cancelEdit();
    showToast("Step updated.", "success");
  };

  const removeStep = (stepId: string, title: string) => {
    if (!task) return;
    deleteTaskRoadmapStep(task.id, stepId);
    if (editingId === stepId) cancelEdit();
    showToast(`Removed "${title}".`, "info");
  };

  // Wrappers so the roadmap UI stays declarative and test-ids are stable.
  const onStart = (stepId: string) => startStepTimer(task!.id, stepId);
  const onPause = (stepId: string) => pauseStepTimer(task!.id, stepId);
  const onResume = (stepId: string) => resumeStepTimer(task!.id, stepId);
  const onFinish = (stepId: string) => {
    finishStepTimer(task!.id, stepId);
    showToast("Step finished 🎉 Time logged.", "success");
  };
  const onReopen = (stepId: string) => reopenStepTimer(task!.id, stepId);

  /**
   * Runs when the intake flow has enough context (or the user hits its
   * always-visible "Generate with AI — quick" skip button). The flow calls
   * onComplete(topic, context); the workspace generates for the TASK's name,
   * so the intake topic is ignored here (they are the same string).
   */
  const handleIntakeComplete = async (
    _topic: string,
    context: IntakeContext,
  ) => {
    if (!task || aiLoading) return;
    setAiError(null);
    setAiLoading(true);
    try {
      let days: unknown;
      if (isRemoteApi()) {
        // Deployed async path — same flow the TopicBoard uses.
        const rm = await generateRoadmapRemote(task.name, context);
        days = rm.days;
      } else {
        // Local dev path — synchronous Next.js route handler.
        const res = await apiPost("/api/generate-roadmap", {
          topic: task.name,
          context,
        });
        const data = (await res.json()) as {
          roadmap?: { days?: unknown };
          error?: string;
        };
        if (!res.ok || !data.roadmap?.days) {
          throw new Error(data.error ?? "Failed to generate roadmap.");
        }
        days = data.roadmap.days;
      }

      const generated = stepsFromGeneratedDays(
        days as Parameters<typeof stepsFromGeneratedDays>[0],
      );
      if (!generated.length) {
        throw new Error("The generated roadmap was empty. Try again.");
      }
      const existing = task.roadmap ?? [];
      if (
        existing.length > 0 &&
        !window.confirm(
          `Replace the existing ${existing.length} step(s) of this task with the AI roadmap?`,
        )
      ) {
        return;
      }
      setTaskRoadmap(task.id, generated);
      setIntakeOpen(false);
      showToast(`Attached ${generated.length}-step roadmap 🗺️`, "success");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to generate roadmap.";
      setAiError(message);
      // Keep the intake open so the user can retry from where they were.
      setIntakeOpen(true);
    } finally {
      setAiLoading(false);
    }
  };

  // ---- Guard states ----
  if (!hydrated) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading workspace…
        </p>
      </main>
    );
  }

  if (!task || !w) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
        <SearchX className="h-8 w-8 text-gray-600" />
        <div>
          <h1 className="text-lg font-bold text-gray-100">Task not found</h1>
          <p className="mt-1 text-sm text-gray-500">
            This workspace doesn&apos;t exist or the task was deleted.
          </p>
        </div>
        <Link href="/" className="btn-secondary px-4 py-2 text-sm">
          <ArrowLeft className="h-4 w-4" />
          Back to Dashboard
        </Link>
      </main>
    );
  }

  const statusStyle = STATUS_STYLE[w.status] ?? STATUS_STYLE["Not Started"];

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-24 pt-6 sm:px-6">
      {/* Top bar */}
      <div className="mb-5 flex items-center justify-between gap-3">
        <Link
          href="/"
          data-testid="back-home"
          className="flex items-center gap-2 rounded-full border border-white/10 bg-surface-raised px-4 py-2 text-sm font-semibold text-gray-300 outline-none transition hover:bg-surface-overlay hover:text-gray-100 active:scale-95"
        >
          <ArrowLeft className="h-4 w-4" />
          Dashboard
        </Link>
        <span
          data-testid="ws-status"
          className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${statusStyle}`}
        >
          {w.status}
        </span>
      </div>

      {/* Task header */}
      <header className="animate-fade-in mb-5">
        <h1
          data-testid="ws-title"
          className="text-2xl font-bold tracking-tight text-gray-50"
        >
          {task.name}
        </h1>
        {task.description && (
          <p className="mt-1.5 max-w-xl text-sm leading-snug text-gray-400">
            {task.description}
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] tabular-nums">
          <span
            data-testid="ws-day-chip"
            className="rounded-lg bg-habeet-500/15 px-2.5 py-1 font-semibold text-habeet-200 ring-1 ring-habeet-400/30"
          >
            Day {w.currentDay} of {task.durationDays}
          </span>
          <span data-testid="ws-range" className="text-gray-400">
            {w.rangeLabel}
          </span>
          <span className="text-gray-600">·</span>
          <span data-testid="ws-deadline" className="text-gray-400">
            Deadline {labelLongIST(w.deadlineKey)}
          </span>
          <span className="rounded-md bg-surface-raised px-2 py-0.5 font-medium text-gray-400 ring-1 ring-white/10">
            {labelIST(task.startDate)} start · IST
          </span>
        </div>
      </header>

      {/* Time + progress summary (task-level, focused only on THIS task) */}
      <section
        aria-label="Task time summary"
        data-testid="ws-summary"
        className="mb-5 rounded-2xl bg-surface p-5 ring-1 ring-white/5"
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <span
            data-testid="ws-progress"
            className="text-sm font-semibold tabular-nums text-habeet-200"
          >
            Progress: {tprog.pct}%
          </span>
          {/* WORKFLOW §14: task status chip (assessment/exam aware). */}
          <span
            data-testid="ws-task-status"
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
              ts.status === "completed"
                ? "bg-emerald-500/15 text-emerald-200"
                : ts.status === "final_exam_required"
                  ? "bg-habeet-500/15 text-habeet-200"
                  : ts.status === "day_assessment_required"
                    ? "bg-amberAccent-500/15 text-amberAccent-200"
                    : "bg-surface-overlay text-gray-300"
            }`}
          >
            {ts.status === "completed"
              ? "Completed"
              : ts.status === "final_exam_required"
                ? "Final exam required"
                : ts.status === "day_assessment_required"
                  ? "Day assessment required"
                  : "Active"}
          </span>
          <span
            data-testid="ws-progress-ratio"
            className="text-[11px] tabular-nums text-gray-500"
          >
            {tprog.done}/{tprog.total} steps done ·{" "}
            {estTotalMin > 0
              ? `${formatDuration(practicedTotal)} practiced`
              : "no estimates yet"}
          </span>
        </div>
        <div
          className="mb-4 h-2 w-full overflow-hidden rounded-full bg-surface-overlay"
          role="progressbar"
          aria-valuenow={tprog.pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Task progress"
        >
          <div
            className="h-full rounded-full bg-gradient-to-r from-habeet-500 to-habeet-400 transition-all duration-500"
            style={{ width: `${Math.min(100, tprog.pct)}%` }}
          />
        </div>

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl bg-surface-raised px-3 py-2.5 ring-1 ring-white/5">
            <dt className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
              Deadline
            </dt>
            <dd
              data-testid="sum-deadline"
              className="mt-0.5 truncate text-sm font-semibold tabular-nums text-gray-100"
            >
              {labelIST(w.deadlineKey)}
            </dd>
          </div>
          <div className="rounded-xl bg-surface-raised px-3 py-2.5 ring-1 ring-white/5">
            <dt className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
              Estimated
            </dt>
            <dd
              data-testid="sum-estimated"
              className="mt-0.5 truncate text-sm font-semibold tabular-nums text-gray-100"
            >
              {estTotalMin > 0 ? formatDuration(estTotalSec) : "—"}
            </dd>
          </div>
          <div className="rounded-xl bg-surface-raised px-3 py-2.5 ring-1 ring-white/5">
            <dt className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
              Practiced
            </dt>
            <dd
              data-testid="sum-practiced"
              className="mt-0.5 truncate text-sm font-semibold tabular-nums text-habeet-200"
            >
              {formatDuration(practicedTotal)}
            </dd>
          </div>
          <div className="rounded-xl bg-surface-raised px-3 py-2.5 ring-1 ring-white/5">
            <dt className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
              Remaining
            </dt>
            <dd
              data-testid="sum-remaining"
              className="mt-0.5 truncate text-sm font-semibold tabular-nums text-emerald-300"
            >
              {estTotalMin > 0 ? formatDuration(remainingTotal) : "—"}
            </dd>
          </div>
        </dl>
{/* Phase 2: task-local monitoring (reads persisted real data only) */}
      <MonitoringPanel task={task} />
      </section>

      {/* Daily check-in window */}
      <section
        aria-label="Day progress"
        className="mb-5 rounded-2xl bg-surface p-5 ring-1 ring-white/5"
      >
        <div className="mb-3 flex items-center justify-between text-[13px] font-medium tabular-nums">
          <h2 className="font-semibold text-gray-100">Plan</h2>
          <span data-testid={`pprog-${task.id}`} className="text-gray-300">
            Day {w.currentDay} of {task.durationDays} · {w.daysRemaining}d left
          </span>
        </div>
        <div
          className="mb-4 h-2 w-full overflow-hidden rounded-full bg-surface-overlay"
          role="progressbar"
          aria-valuenow={w.progressPct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-gradient-to-r from-habeet-500 to-habeet-400 transition-all duration-500"
            style={{ width: `${Math.min(100, w.progressPct)}%` }}
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: task.durationDays }, (_, i) => i + 1).map(
            (day) => {
              const daySteps = (task.roadmap ?? []).filter(
                (s) => (s.dayNumber ?? 1) === day,
              );
              const dayDone = w.completedDays >= day;
              // §9 sequential day-locking: Day 1 is always unlocked; each
              // later day unlocks only once every prior day is complete.
              const isDayUnlocked = day === 1 || w.completedDays >= day - 1;
              const canStart = !dayDone && isDayUnlocked;
              const isCurrentDay = day === w.currentDay;
              return (
                <button
                  key={day}
                  type="button"
                  disabled={!canStart || daySteps.length === 0}
                  aria-label={`Day ${day}`}
                  data-testid={`ptick-${task.id}-${day}`}
                  title={
                    dayDone
                      ? `Day ${day} — completed`
                      : isDayUnlocked
                        ? `Day ${day} — ${isCurrentDay ? "in progress" : "ready"}`
                        : `Complete Day ${day - 1} first`
                  }
                  className={`flex h-8 w-8 items-center justify-center rounded-lg border text-[11px] font-semibold tabular-nums outline-none transition focus-visible:ring-2 focus-visible:ring-habeet-400 ${dayDone
                      ? "border-habeet-500 bg-habeet-600 text-white"
                      : isDayUnlocked
                        ? "border-white/10 text-gray-300"
                        : "border-white/10 bg-surface-overlay/40 text-gray-500 grayscale"
                    }`}
                >
                  {dayDone || isDayUnlocked ? (
                    <span>{day}</span>
                  ) : (
                    <Lock className="h-3.5 w-3.5" />
                  )}
                </button>
              );
            },
          )}
        </div>
        {w.status === "Overdue" && (
          <p className="mt-2 text-[11px] text-amber-300/80">
            Past the deadline ({labelIST(w.deadlineKey)}) — finish remaining
            steps to mark this task complete.
          </p>
        )}
        {w.status === "Completed" && (
          <p className="mt-2 text-[11px] text-emerald-300/80">
            All steps complete — task marked Completed.
          </p>
        )}
      </section>

      {/* Task-owned roadmap */}
      <section
        aria-label="Task roadmap"
        data-testid="ws-roadmap"
        className="rounded-2xl bg-surface p-5 ring-1 ring-white/5"
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-gray-100">
              <ListChecks className="h-4 w-4 text-habeet-300" />
              Roadmap
            </h2>
            <p className="mt-0.5 text-[11px] text-gray-500">
              Only this task&apos;s steps live here.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {steps.length > 0 && (
              <span
                data-testid="rm-progress"
                className="rounded-full bg-surface-raised px-2.5 py-1 text-[11px] font-semibold tabular-nums text-gray-300 ring-1 ring-white/10"
              >
                {tprog.done}/{tprog.total} · {tprog.pct}% ·{" "}
                {estTotalMin > 0
                  ? `total ${formatDuration(estTotalSec)}`
                  : "no time set"}
              </span>
            )}
            <button
              onClick={() => {
                setAiError(null);
                setIntakeOpen((o) => !o);
              }}
              disabled={aiLoading}
              data-testid="rm-ai-btn"
              className="btn-secondary px-3 py-1.5 text-xs"
            >
              {aiLoading ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Planning…
                </>
              ) : intakeOpen ? (
                <>
                  <X className="h-3.5 w-3.5" />
                  Close planner
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  Generate with AI
                </>
              )}
            </button>
            {/* §P3: mid-roadmap edit — ask the LLM to insert/update tasks. */}
            {steps.length > 0 && (
              <button
                onClick={() => setEditOpen((o) => !o)}
                disabled={editLoading}
                data-testid="rm-edit-btn"
                className="btn-secondary px-3 py-1.5 text-xs"
                title="Type a request like 'add testing' at any point"
              >
                {editLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Pencil className="h-3.5 w-3.5" />
                )}
                Edit with AI
              </button>
            )}
          </div>
        </div>

        {/* Roadmap progress bar */}
        {steps.length > 0 && (
          <div
            className="mb-4 h-2 w-full overflow-hidden rounded-full bg-surface-overlay"
            role="progressbar"
            aria-valuenow={tprog.pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Roadmap progress"
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-habeet-500 to-habeet-400 transition-all duration-500"
              style={{ width: `${Math.min(100, tprog.pct)}%` }}
            />
          </div>
        )}

        {/* §7: conversational intake — ALWAYS runs before AI generation.
            The task's fixed day window pre-answers the days question. */}
        {intakeOpen && task && (
          <div className="mb-4">
            <IntakeFlow
              topic={task.name}
              generating={aiLoading}
              initialDays={task.durationDays}
              onCancel={() => setIntakeOpen(false)}
              onComplete={handleIntakeComplete}
            />
          </div>
        )}

        {aiError && (
          <p
            role="alert"
            data-testid="rm-error"
            className="mb-3 rounded-xl bg-red-500/10 px-3.5 py-2.5 text-xs font-medium text-red-300 ring-1 ring-red-500/25"
          >
            {aiError}
          </p>
        )}

        {/* §P3: Mid-roadmap edit — a small inline form for natural-language
            edits ("add testing", "include more on hooks"). The LLM returns
            a single targeted insert; progress on existing steps is preserved. */}
        {editOpen && steps.length > 0 && (
          <div className="mb-4 rounded-xl bg-surface-raised p-3.5 ring-1 ring-white/5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-gray-200">
                Ask the AI to update this roadmap
              </p>
              <button
                onClick={() => setEditOpen(false)}
                aria-label="Close edit planner"
                className="rounded p-1 text-gray-400 hover:text-gray-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <input
                value={editRequest}
                onChange={(e) => setEditRequest(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !editLoading) handleRoadmapEdit();
                }}
                placeholder="e.g. add testing, include more practice on hooks…"
                aria-label="Roadmap edit request"
                data-testid="rm-edit-input"
                className="min-w-0 flex-1 rounded-xl border border-white/10 bg-surface px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none transition focus:border-habeet-500 focus:ring-2 focus:ring-habeet-500/30"
              />
              <button
                onClick={handleRoadmapEdit}
                disabled={!editRequest.trim() || editLoading}
                data-testid="rm-edit-apply"
                className="btn-primary shrink-0 px-3 py-2 text-xs"
              >
                {editLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  "Apply"
                )}
              </button>
            </div>
            {editResult && (
              <p className="mt-2 text-xs leading-snug text-gray-400">
                {editResult}
              </p>
            )}
          </div>
        )}

        {/* Steps */}
        {steps.length === 0 ? (
          <p
            data-testid="rm-empty"
            className="py-6 text-center text-sm text-gray-500"
          >
            No roadmap yet — add your first step below or let AI plan it.
          </p>
        ) : (
          <ol className="mb-4 space-y-2">
            {steps.map((step, index) => {
              const editing = editingId === step.id;
              const stepDay = step.dayNumber ?? 1;
              // WORKFLOW §1: strict SEQUENTIAL step locking — a step may only
              // start once every earlier step of its day is done AND every
              // prior day is done + assessed. Replaces the day-only lock.
              const stepLocked = !isStepStartable(steps, index, assessmentLock);
              const lockMessage = stepLocked
                ? stepLockReason(steps, index, assessmentLock) || "Locked"
                : "";
              // DAY GROUPING (day-grouped roadmap): the first step of each
              // day renders that day's header (number, title, progress,
              // estimates, practiced time, lock state) above its steps.
              const isFirstOfDay =
                index === 0 ||
                (steps[index - 1]?.dayNumber ?? 1) !== stepDay;
              const group = dayGroups.find((g) => g.day === stepDay);
              // WORKFLOW §6: this day's authoritative status (assessment-aware).
              const ds = dayStatuses[stepDay] ?? {
                status: "locked" as const,
                done: 0,
                total: 0,
                assessed: false,
              };
              return (
                <Fragment key={step.id}>
                  {isFirstOfDay && group && (
                    <li
                      data-testid={`day-header-${stepDay}`}
                      aria-label={`Day ${stepDay} header`}
                      className="mt-3 first:mt-0 rounded-xl bg-surface-overlay/50 px-3 py-2 ring-1 ring-white/5"
                    >
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                        <span
                          className={`flex h-6 min-w-6 items-center justify-center rounded-lg px-1.5 text-[11px] font-bold tabular-nums ${
                            ds.assessed
                              ? "bg-habeet-600 text-white"
                              : stepLocked
                                ? "bg-surface text-gray-500"
                                : "bg-habeet-500/20 text-habeet-200"
                          }`}
                        >
                          {stepDay}
                        </span>
                        <h3 className="text-[13px] font-semibold text-gray-100">
                          Day {stepDay}
                        </h3>
                        {stepLocked && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[10px] font-semibold text-gray-400 ring-1 ring-white/10">
                            <Lock className="h-3 w-3" /> locked
                          </span>
                        )}
                        {/* WORKFLOW §6: a day is only "completed" AFTER its Day
                            Assessment is submitted. Step-complete-but-unassessed
                            days show "Assessment Required" instead. */}
                        {ds.status === "assessment_ready" && (
                          <span
                            data-testid={`day-status-${stepDay}`}
                            className="rounded-full bg-amberAccent-500/15 px-2 py-0.5 text-[10px] font-semibold text-amberAccent-200"
                          >
                            Assessment required
                          </span>
                        )}
                        {ds.assessed && ds.status !== "assessment_ready" && (
                          <span
                            data-testid={`day-status-${stepDay}`}
                            className="rounded-full bg-habeet-500/15 px-2 py-0.5 text-[10px] font-semibold text-habeet-200"
                          >
                            completed
                          </span>
                        )}
                        {ds.status === "in_progress" && (
                          <span
                            data-testid={`day-status-${stepDay}`}
                            className="rounded-full bg-habeet-500/15 px-2 py-0.5 text-[10px] font-semibold text-habeet-200"
                          >
                            in progress
                          </span>
                        )}
                        <span className="ml-auto text-[11px] tabular-nums text-gray-400">
                          {group.done}/{group.steps.length} steps
                          {group.estMinutes > 0
                            ? ` · ~${formatEstimated(group.estMinutes)}`
                            : ""}
                          {group.practicedSeconds > 0
                            ? ` · ${formatDuration(group.practicedSeconds)} practiced`
                            : ""}
                        </span>
                      </div>
                    </li>
                  )}
                <li
                  key={step.id}
                  data-testid="step-row"
                  data-step-title={step.title}
                  className={`group rounded-xl bg-surface-raised px-3.5 py-3 ring-1 transition ${step.isDone ? "ring-habeet-500/20" : "ring-white/5"
                    }`}
                >
                  {editing ? (
                    /* ---- Inline edit mode ---- */
                    <div className="min-w-0 space-y-2">
                      <input
                        autoFocus
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit(step.id);
                          if (e.key === "Escape") cancelEdit();
                        }}
                        aria-label="Step title"
                        data-testid="step-edit-title"
                        className="w-full rounded-lg border border-white/10 bg-surface px-2.5 py-1.5 text-sm text-gray-100 outline-none focus:border-habeet-500"
                      />
                      <input
                        value={editNote}
                        onChange={(e) => setEditNote(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit(step.id);
                          if (e.key === "Escape") cancelEdit();
                        }}
                        placeholder="Note (optional)"
                        aria-label="Step note"
                        data-testid="step-edit-note"
                        className="w-full rounded-lg border border-white/10 bg-surface px-2.5 py-1.5 text-xs text-gray-300 outline-none focus:border-habeet-500"
                      />
                      <input
                        value={editDuration}
                        onChange={(e) => setEditDuration(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit(step.id);
                          if (e.key === "Escape") cancelEdit();
                        }}
                        placeholder="Estimated time (e.g. 2h, 45m, 1h 30m, 90)"
                        aria-label="Estimated time"
                        data-testid="step-edit-duration"
                        className="w-full rounded-lg border border-white/10 bg-surface px-2.5 py-1.5 text-xs tabular-nums text-gray-100 placeholder-gray-500 outline-none focus:border-habeet-500"
                      />
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => saveEdit(step.id)}
                          data-testid="step-save"
                          className="btn-primary px-3 py-1 text-xs"
                        >
                          Save
                        </button>
                        <button
                          onClick={cancelEdit}
                          data-testid="step-cancel"
                          className="btn-secondary px-3 py-1 text-xs"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* ---- Display mode ---- */
                    <>
                      {/* Header: step number, title, note, per-step time */}
                      <div className="flex items-start gap-3">
                        <span
                          data-testid="step-num"
                          className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold tabular-nums ${step.isDone
                              ? "bg-habeet-600 text-white"
                              : "bg-surface-overlay text-habeet-200"
                            }`}
                        >
                          {index + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p
                            className={`text-sm font-medium leading-snug ${step.isDone
                                ? "text-gray-500 line-through decoration-habeet-500/60"
                                : "text-gray-100"
                              }`}
                          >
                            {step.title}
                          </p>
                          {step.note && (
                            <p className="mt-0.5 text-[11px] leading-snug text-gray-500">
                              {step.note}
                            </p>
                          )}
                          {/* Per-step time badges */}
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] tabular-nums">
                            <span
                              data-testid={`step-est-${step.id}`}
                              title="Estimated"
                              className="font-semibold text-gray-300"
                            >
                              {step.estimated_minutes
                                ? `≈ ${formatEstimated(step.estimated_minutes)}`
                                : "no estimate"}
                            </span>
                            <span className="text-gray-500" title="Practiced">
                              <Clock className="mr-0.5 inline h-3 w-3 text-habeet-300" />
                              {formatDuration(stepSimSeconds(step, now))}{" "}
                              practiced
                            </span>
                            {/* §4 REAL-TIME: actual vs estimate with overtime. */}
                            {typeof step.estimated_minutes === "number" &&
                             step.estimated_minutes > 0 && (
                              <span
                                data-testid={`step-overtime-${step.id}`}
                                className={
                                  stepSimSeconds(step, now) >
                                  step.estimated_minutes * 60
                                    ? "font-semibold text-amber-300"
                                    : "text-emerald-300/80"
                                }
                                title={
                                  stepSimSeconds(step, now) >
                                  step.estimated_minutes * 60
                                    ? "Overtime — the timer never stops you"
                                    : "Remaining"
                                }
                              >
                                {stepSimSeconds(step, now) >
                                step.estimated_minutes * 60
                                  ? `+${formatDuration(
                                      stepSimSeconds(step, now) -
                                        step.estimated_minutes * 60,
                                    )} overtime`
                                  : `${formatDuration(
                                      Math.max(
                                        0,
                                        step.estimated_minutes * 60 -
                                          stepSimSeconds(step, now),
                                      ),
                                    )} left`}
                              </span>
                            )}
                          </div>
                          {/* §1: study sources for THIS exact step/topic */}
                          {step.sources && step.sources.length > 0 && (
                            <div
                              data-testid={`step-sources-${step.id}`}
                              className="mt-2 flex flex-wrap items-center gap-1"
                            >
                              <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                                Study sources
                              </span>
                              {step.sources.map((src, i) => (
                                <a
                                  key={i}
                                  href={src.url}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                  className="inline-flex items-center gap-1 rounded-md bg-habeet-500/10 px-2 py-0.5 text-[11px] font-medium text-habeet-300 ring-1 ring-habeet-500/20 outline-none transition hover:bg-habeet-500/20 hover:text-habeet-200 focus-visible:ring-2 focus-visible:ring-habeet-400"
                                >
                                  <ExternalLink className="h-3 w-3" />
                                  <span className="max-w-[220px] truncate">
                                    {src.title}
                                  </span>
                                </a>
                              ))}
                            </div>
                          )}
                          {/* Phase E: one-tap YouTube search for this step's topic */}
                          {step.search && (
                            <a
                              href={`https://www.youtube.com/results?search_query=${encodeURIComponent(
                                step.search,
                              )}`}
                              target="_blank"
                              rel="noreferrer noopener"
                              data-testid={`step-search-${step.id}`}
                              className="mt-2 inline-flex items-center gap-1 rounded-md bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-300 ring-1 ring-red-500/20 outline-none transition hover:bg-red-500/20 hover:text-red-200 focus-visible:ring-2 focus-visible:ring-habeet-400"
                            >
                              <Play className="h-3 w-3" />
                              <span className="max-w-[240px] truncate">
                                Watch: {step.search}
                              </span>
                            </a>
                          )}
                          {step.search && <br />}
                        </div>
                        <CircleCheckbox
                          checked={step.isDone}
                          onChange={() =>
                            toggleTaskRoadmapStep(task.id, step.id)
                          }
                          label={`Mark "${step.title}" ${step.isDone ? "not done" : "done"}`}
                          size={20}
                          data-testid="step-check"
                        />
                      </div>
                      {/* Step timer bar */}
                      <div
                        data-testid={`step-timer-${step.id}`}
                        className={`mt-2 flex items-center gap-2 rounded-xl px-3 py-2 ring-1 ${step.timerStatus === "running"
                            ? "bg-habeet-500/10 ring-habeet-500/30"
                            : step.timerStatus === "paused"
                              ? "bg-amber-500/10 ring-amber-500/25"
                              : step.timerStatus === "finished"
                                ? "bg-emerald-500/10 ring-emerald-500/20"
                                : "bg-surface-overlay/40 ring-white/5"
                          }`}
                      >
                        <span
                          data-testid="step-clock"
                          className="min-w-[64px] rounded-lg bg-black/30 px-2 py-1 text-center text-xs font-semibold tabular-nums text-gray-100"
                        >
                          {formatClock(stepSimSeconds(step, now))}
                        </span>
                        <span className="hidden text-[10px] uppercase tracking-wide text-gray-500 sm:inline">
                          {step.timerStatus === "running"
                            ? "Running"
                            : step.timerStatus === "paused"
                              ? "Paused"
                              : step.timerStatus === "finished"
                                ? step.questionPending && !step.isDone
                                  ? "Question pending"
                                  : "Finished"
                                : "Ready"}
                        </span>
                        <span className="flex-1" />
                        {step.timerStatus === "running" ? (
                          <button
                            onClick={() => onPause(step.id)}
                            data-testid="timer-pause"
                            aria-label={`Pause "${step.title}" timer`}
                            className="btn-secondary px-2.5 py-1 text-[11px]"
                          >
                            <Pause className="h-3 w-3" />
                            Pause
                          </button>
                        ) : step.timerStatus === "paused" ? (
                          <button
                            onClick={() => onResume(step.id)}
                            data-testid="timer-resume"
                            aria-label={`Resume "${step.title}" timer`}
                            className="btn-primary px-2.5 py-1 text-[11px]"
                          >
                            <Play className="h-3 w-3" />
                            Resume
                          </button>
                        ) : (
                          <button
                            onClick={() => onStart(step.id)}
                            data-testid="timer-start"
                            disabled={stepLocked}
                            title={
                              stepLocked
                                ? lockMessage
                                : `Start ${step.title} timer`
                            }
                            aria-label={`Start "${step.title}" timer`}
                            className="btn-secondary px-2.5 py-1 text-[11px]"
                          >
                            <Play className="h-3 w-3" />
                            Start
                          </button>
                        )}
                        {(step.timerStatus === "running" ||
                          step.timerStatus === "paused") && (
                            <button
                              onClick={() => onFinish(step.id)}
                              data-testid="timer-finish"
                              aria-label={`Finish "${step.title}" timer`}
                              className="btn-secondary px-2.5 py-1 text-[11px] !text-emerald-300"
                            >
                              <Square className="h-3 w-3" />
                              Finish
                            </button>
                          )}
                        {step.timerStatus === "finished" && !step.questionPending && (
                          <button
                            onClick={() => onReopen(step.id)}
                            data-testid="timer-reopen"
                            aria-label={`Reopen "${step.title}" timer`}
                            className="btn-secondary px-2.5 py-1 text-[11px]"
                          >
                            <RotateCcw className="h-3 w-3" />
                            Reopen
                          </button>
                        )}
                        {/* WORKFLOW §5: the mandatory per-step question is
                            outstanding — it MUST be answered before the step
                            can complete. Never silently skippable. */}
                        {step.questionPending && !step.isDone && (
                          <button
                            onClick={() => requestStepQuestion(task.id, step.id)}
                            data-testid="step-question-pending"
                            aria-label={`Answer the required question for "${step.title}"`}
                            className="btn-primary px-2.5 py-1 text-[11px] !bg-amberAccent-600 hover:!bg-amberAccent-700"
                          >
                            <HelpCircle className="h-3 w-3" />
                            Answer Question
                          </button>
                        )}
                      </div>

                      {/* Reorder / edit / delete controls */}
                      <div className="mt-1 flex shrink-0 justify-end gap-0.5 sm:items-center">
                        <button
                          onClick={() =>
                            moveTaskRoadmapStep(task.id, step.id, -1)
                          }
                          disabled={index === 0}
                          aria-label={`Move "${step.title}" up`}
                          title="Move up"
                          data-testid="step-up"
                          className="rounded-md p-1 text-gray-500 outline-none transition hover:bg-white/5 hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-habeet-400"
                        >
                          <ChevronUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() =>
                            moveTaskRoadmapStep(task.id, step.id, 1)
                          }
                          disabled={index === steps.length - 1}
                          aria-label={`Move "${step.title}" down`}
                          title="Move down"
                          data-testid="step-down"
                          className="rounded-md p-1 text-gray-500 outline-none transition hover:bg-white/5 hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-habeet-400"
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                        </button>
                        <span className="mx-0.5 hidden h-4 w-px bg-white/10 sm:block" />
                        <button
                          onClick={() => startEdit(step)}
                          aria-label={`Edit "${step.title}"`}
                          title="Edit step"
                          data-testid="step-edit"
                          className="rounded-md p-1 text-gray-500 outline-none transition hover:bg-white/5 hover:text-habeet-300 focus-visible:ring-2 focus-visible:ring-habeet-400"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => removeStep(step.id, step.title)}
                          aria-label={`Delete "${step.title}"`}
                          title="Delete step"
                          data-testid="step-delete"
                          className="rounded-md p-1 text-gray-500 outline-none transition hover:bg-red-500/10 hover:text-red-300 focus-visible:ring-2 focus-visible:ring-red-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </>
                  )}
                </li>
                </Fragment>
              );
            })}
          </ol>
        )}

        {/* Add step form */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleAddStep();
          }}
          className="flex items-center gap-2 border-t border-white/5 pt-4"
        >
          <Plus className="h-4 w-4 shrink-0 text-gray-600" />
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Add a step… e.g. URLs & Views"
            aria-label="New step title"
            data-testid="step-add-input"
            className="min-w-0 flex-1 rounded-xl border border-white/10 bg-surface-raised px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none transition focus:border-habeet-500 focus:ring-2 focus:ring-habeet-500/30"
          />
          <button
            type="submit"
            disabled={!newTitle.trim()}
            data-testid="step-add"
            className="btn-primary shrink-0 px-3.5 py-2 text-xs"
          >
            Add Step
          </button>
          <button
            type="button"
            onClick={() => setNewTitle("")}
            aria-label="Clear new step input"
            className={`shrink-0 rounded-lg p-1.5 text-gray-600 outline-none transition hover:bg-white/5 hover:text-gray-300 ${newTitle ? "" : "invisible"
              }`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </form>
      </section>

      {/* §11 per-step check-in gate — the ONLY path that flips isDone. */}
      {pendingCheckIn && (
        <CheckInModal
          pending={pendingCheckIn}
          onCancel={dismissCheckIn}
          onAnswer={(answer: CheckInAnswer) =>
            completeStep(
              pendingCheckIn.taskId,
              pendingCheckIn.stepId,
              answer,
              pendingCheckIn.completedBy,
            )
          }
        />
      )}

      {/* PART 2: Day Assessment + Final Exam section (replaces the old §12
          auto-open modal). Availability is derived from the task's persisted
          assessment state so the server progress route remains authoritative. */}
      <TaskAssessmentSection
        task={task}
        dayAssessmentPending={dayAssessmentPending}
        activeExam={activeExam}
        onStartDay={startDayAssessment}
        onStartFinal={startFinalExam}
        onSubmitDay={submitDayAssessment}
        onSubmitFinal={submitFinalExam}
        onSaveDraft={saveExamDraft}
        onReportViolation={(_, type) => reportExamViolation(taskId, type)}
        onInterrupt={(reason) => interruptActiveExam(taskId, reason)}
        onDismiss={dismissActiveExam}
        onResumeDraft={(draft) => resumeExamDraft(task?.id ?? "", draft)}
      />

      {/* §6 grounded study assistant (floating widget). */}
      <AssistantChat grounding={chatGrounding} />
    </main>
  );
}
