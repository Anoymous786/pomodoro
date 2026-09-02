"use client";

import { useState } from "react";
import {
  Check,
  ChevronDown,
  Clock,
  GraduationCap,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { effectiveMinutes, Priority, Task } from "@/lib/types";
import { showToast } from "@/lib/toast";
import CircleCheckbox from "@/components/habeet/CircleCheckbox";

interface TaskManagerProps {
  tasks: Task[];
  tasksCompleted: number;
  totalTasks: number;
  activeTaskId: string | null;
  onAdd: (name: string, priority: Priority, estimatedMinutes?: number) => void;
  onToggle: (id: string) => void;
  onEdit: (id: string, name: string, priority: Priority) => void;
  onDelete: (id: string) => void;
  onEditMinutes: (id: string, minutes: number | null) => void;
  onStartTask: (id: string) => void;
  /** Re-opens a completed task's exam for review. */
  onReviewExam?: (id: string) => void;
  /** Â§5 Resume-flow: when set, this task's row pulses + scrolls into view. */
  highlightName?: string | null;
}

const PRIORITY_OPTIONS: { value: Priority; label: string }[] = [
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

/* Semantic priority hues â€” deliberately NOT the accent color and NOT red. */
const PRIORITY_DOT: Record<Priority, string> = {
  high: "bg-orange-400 ring-1 ring-orange-300/40",
  medium: "bg-sky-400 ring-1 ring-sky-300/40",
  low: "bg-emerald-400 ring-1 ring-emerald-300/40",
};

export default function TaskManager({
  tasks,
  tasksCompleted,
  totalTasks,
  activeTaskId,
  onAdd,
  onToggle,
  onEdit,
  onDelete,
  onEditMinutes,
  onStartTask,
  onReviewExam,
  highlightName,
}: TaskManagerProps) {
  const [name, setName] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [estimatedMinutes, setEstimatedMinutes] = useState("25");
  const [addError, setAddError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPriority, setEditPriority] = useState<Priority>("medium");
  const [minutesEditId, setMinutesEditId] = useState<string | null>(null);
  const [minutesEditValue, setMinutesEditValue] = useState("");
  /** Phase D: id of the task whose per-task mini-dashboard is expanded. */
  const [detailOpenId, setDetailOpenId] = useState<string | null>(null);

  const handleAdd = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setAddError("Type a task name first.");
      showToast("Type a task name first.", "error");
      return;
    }
    setAddError(null);
    try {
      const mins = parseInt(estimatedMinutes, 10);
      onAdd(trimmed, priority, Number.isFinite(mins) && mins > 0 ? mins : 25);
      setName("");
      setPriority("medium");
      setEstimatedMinutes("25");
      showToast("Task added.", "success");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Couldn't add the task.";
      setAddError(message);
      showToast(`Couldn't add task: ${message}`, "error");
    }
  };

  const startEdit = (task: Task) => {
    setEditingId(task.id);
    setEditName(task.name);
    setEditPriority(task.priority);
    setMinutesEditId(null);
  };

  const saveEdit = () => {
    if (editingId && editName.trim()) {
      onEdit(editingId, editName, editPriority);
    }
    setEditingId(null);
  };

  const cancelEdit = () => setEditingId(null);

  const startMinutesEdit = (task: Task) => {
    setMinutesEditId(task.id);
    setMinutesEditValue(
      String(effectiveMinutes(task.estimated_minutes, task.manual_minutes))
    );
    setEditingId(null);
  };

  const saveMinutesEdit = (task: Task) => {
    const parsed = parseInt(minutesEditValue, 10);
    onEditMinutes(
      task.id,
      Number.isFinite(parsed) && parsed > 0 ? parsed : null
    );
    setMinutesEditId(null);
  };


  const totalEffective = tasks.reduce(
    (sum, t) => sum + effectiveMinutes(t.estimated_minutes, t.manual_minutes),
    0
  );

  return (
        <section data-testid="today-card" className="rounded-2xl bg-surface p-5 ring-1 ring-white/5">
      {/* Card header â€” title + quiet metadata */}
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-gray-100">Today</h2>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-habeet-500/15 px-3 py-1 text-[11px] font-semibold text-habeet-200 tabular-nums">
            {tasksCompleted}/{totalTasks} done
          </span>
          <span className="hidden items-center gap-1 text-[11px] font-medium text-gray-500 sm:flex">
            <Clock className="h-3 w-3" />~{totalEffective} min
          </span>
        </div>
      </div>

      {/* Add task form */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          placeholder="Add a new task..."
          data-testid="task-input"
          className="flex-1 rounded-xl border border-white/10 bg-surface-raised px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none transition focus:border-habeet-500 focus:ring-2 focus:ring-habeet-500/30"
        />
        <div className="flex flex-wrap gap-2">
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority)}
            aria-label="Task priority"
            className="rounded-xl border border-white/10 bg-surface-raised px-3 py-2 text-sm text-gray-200 outline-none transition focus:border-habeet-500"
          >
            {PRIORITY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-surface-raised px-2 py-1 text-sm text-gray-200">
            <input
              type="number"
              min={1}
              value={estimatedMinutes}
              onChange={(e) => setEstimatedMinutes(e.target.value)}
              aria-label="Estimated minutes"
              className="w-12 bg-transparent text-center outline-none"
            />
            <span className="text-[11px] text-gray-500">min</span>
          </div>
          <button
            onClick={handleAdd}
            className="btn-primary px-4 py-2 text-sm"
            data-testid="task-add-btn"
          >
            <Plus className="h-4 w-4" />
            Add
          </button>
        </div>
      </div>

      {addError && (
        <p
          role="alert"
          className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300 ring-1 ring-red-500/30"
        >
          {addError}
        </p>
      )}

      {/* Task list */}
      {tasks.length === 0 ? (
        <p className="py-6 text-center text-sm text-gray-500">
          No tasks yet. Add one above to get started!
        </p>
      ) : (
        <ul className="space-y-2">
          {tasks.map((task) => {
            const effective = effectiveMinutes(
              task.estimated_minutes,
              task.manual_minutes
            );
            const isActiveTask = task.id === activeTaskId;
            const isEditing = editingId === task.id;
            const isEditingMinutes = minutesEditId === task.id;
            return (
              <li
                key={task.id}
                                data-task-name={task.name}
                data-testid={`task-row-${task.name.replace(/\s+/g, "_")}`}
                className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 ring-1 transition ${
                  isActiveTask
                    ? "bg-habeet-500/10 ring-habeet-500/40"
                    : "bg-surface-raised ring-white/5 hover:bg-surface-overlay"
                } ${
                  highlightName && task.name === highlightName
                    ? "!ring-2 !ring-habeet-400 animate-pulse"
                    : ""
                }`}
              >
                                {/* Circular checkbox (§0 + §6) â€” marks task done */}
                <CircleCheckbox
                  checked={task.is_completed}
                  onChange={() => onToggle(task.id)}
                  label={task.name}
                  data-testid={`task-checkbox-${task.name.replace(/\s+/g, "_")}`}
                />

                {/* Task name + minutes */}
                {isEditing ? (
                  <div className="flex flex-1 items-center gap-2">
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && saveEdit()}
                      autoFocus
                      className="flex-1 rounded-lg border border-habeet-500 bg-surface-overlay px-2 py-1 text-sm text-gray-100 outline-none focus:ring-2 focus:ring-habeet-500/40"
                    />
                    <select
                      value={editPriority}
                      onChange={(e) =>
                        setEditPriority(e.target.value as Priority)
                      }
                      aria-label="Edit priority"
                      className="rounded-lg border border-white/10 bg-surface-raised px-2 py-1 text-xs text-gray-200 outline-none"
                    >
                      {PRIORITY_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={saveEdit}
                      aria-label="Save edit"
                      className="rounded p-1 text-gray-400 transition hover:bg-white/5 hover:text-gray-100"
                    >
                      <Check className="h-4 w-4" />
                    </button>
                    <button
                      onClick={cancelEdit}
                      aria-label="Cancel edit"
                      className="rounded p-1 text-gray-500 transition hover:bg-white/5 hover:text-gray-300"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <span
                    className={`flex-1 text-sm ${
                      task.is_completed
                        ? "text-gray-500 line-through"
                        : "text-gray-100"
                    }`}
                  >
                    {task.name}
                  </span>
                )}

                {/* Minutes display / edit */}
                {!isEditing && (
                  <div className="flex shrink-0 items-center gap-1">
                    {/* Exam result chip (click to review) */}
                    {task.examResult && onReviewExam && (
                      <button
                        onClick={() => onReviewExam(task.id)}
                        title={`Exam: ${task.examResult.score}% â€” ${
                          task.examResult.passed ? "passed" : "needs review"
                        }`}
                        className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold tabular-nums transition ${
                          task.examResult.passed
                            ? "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                            : "bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
                        }`}
                      >
                        <GraduationCap className="h-3.5 w-3.5" />
                        {task.examResult.score}%
                      </button>
                    )}
                    {isEditingMinutes ? (
                      <div className="flex items-center gap-1 rounded-lg border border-habeet-500 bg-surface-overlay px-1.5 py-0.5">
                        <input
                          type="number"
                          min={1}
                          value={minutesEditValue}
                          onChange={(e) => setMinutesEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveMinutesEdit(task);
                            if (e.key === "Escape") setMinutesEditId(null);
                          }}
                          autoFocus
                          className="w-12 bg-transparent text-center text-xs text-gray-100 outline-none"
                        />
                        <span className="text-[11px] text-gray-500">min</span>
                        <button
                          onClick={() => saveMinutesEdit(task)}
                          aria-label="Save minutes"
                          className="rounded p-0.5 text-gray-400 transition hover:bg-white/5 hover:text-gray-100"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => startMinutesEdit(task)}
                        title="Edit estimated time"
                        aria-label={`Edit estimated time for ${task.name}`}
                        className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium tabular-nums outline-none transition focus-visible:ring-2 focus-visible:ring-habeet-400/60 ${
                          task.manual_minutes != null
                            ? "bg-habeet-500/20 text-habeet-200 hover:bg-habeet-500/30"
                            : "text-gray-400 hover:bg-white/5 hover:text-gray-200"
                        }`}
                      >
                        <Clock className="h-3.5 w-3.5" />~{effective} min
                        <Pencil className="h-3 w-3 opacity-60" />
                      </button>
                    )}
                  </div>
                )}

                {/* Actions â€” visible on hover/focus, always on touch */}
                {!isEditing && !isEditingMinutes && (
                  <div className="flex shrink-0 items-center gap-1 transition focus-within:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                    {!task.is_completed && (
                      <button
                        onClick={() => onStartTask(task.id)}
                        aria-label={`Start timer for ${task.name}`}
                        title="Start this task's timer"
                        className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-habeet-300 outline-none transition hover:bg-habeet-500/15 focus-visible:ring-2 focus-visible:ring-habeet-400/60"
                      >
                        <Play className="h-3.5 w-3.5" />
                        Start
                      </button>
                    )}
                    <button
                      onClick={() => startEdit(task)}
                      aria-label="Edit task"
                      className="rounded p-1.5 text-gray-500 outline-none transition hover:bg-white/5 hover:text-gray-200 focus-visible:ring-2 focus-visible:ring-habeet-400/60"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => onDelete(task.id)}
                      aria-label="Delete task"
                      className="rounded p-1.5 text-gray-500 outline-none transition hover:bg-red-500/10 hover:text-red-300 focus-visible:ring-2 focus-visible:ring-red-400/50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
{/* Phase D: per-task mini dashboard — time accuracy + exam
                      accuracy, scoped to THIS task (never merged into the
                      global Sessions / Focus Time / Tasks summary). */}
                  {(task.is_completed ||
                    task.examResult ||
                    task.timingRecord) && (
                    <div className="mt-2 flex w-full items-center justify-between border-t border-white/5 pt-2">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
                        Details
                      </span>
                      <button
                        onClick={() =>
                          setDetailOpenId((cur) =>
                            cur === task.id ? null : task.id
                          )
                        }
                        aria-expanded={detailOpenId === task.id}
                        aria-label={`Toggle details for ${task.name}`}
                        className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-habeet-300 outline-none transition hover:bg-habeet-500/15 focus-visible:ring-2 focus-visible:ring-habeet-400/60"
                      >
                        <span>{detailOpenId === task.id ? "Hide" : "Show"}</span>
                        <ChevronDown
                          className={`h-3.5 w-3.5 transition-transform ${
                            detailOpenId === task.id ? "rotate-180" : ""
                          }`}
                        />
                      </button>
                    </div>
                  )}
                  {detailOpenId === task.id && <PerTaskDetail task={task} />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Phase D: expandable per-task mini-dashboard. Shows time accuracy (estimate
 * vs actual + timing outcome) and exam accuracy for a single task. This lives
 * ON the task — it is deliberately separate from the global Sessions / Focus
 * Time / Tasks Completed summary.
 */
function PerTaskDetail({ task }: { task: Task }) {
  const effective = effectiveMinutes(
    task.estimated_minutes,
    task.manual_minutes
  );

  const timing = task.timingRecord;
  const outcomeLabel = (o: Task["timing_outcome"]) =>
    o === "early"
      ? "Early"
      : o === "late"
      ? "Late"
      : o === "on-time"
      ? "On time"
      : "Unknown";

  const outcomeClass =
    task.timing_outcome === "on-time"
      ? "text-emerald-400"
      : task.timing_outcome === "early"
      ? "text-sky-400"
      : task.timing_outcome === "late"
      ? "text-amber-400"
      : "text-gray-400";

  return (
    <div
      className="mt-2 grid w-full grid-cols-2 gap-3 rounded-xl bg-surface-overlay p-3 ring-1 ring-white/5"
      data-testid={`task-detail-${task.name.replace(/\s+/g, "_")}`}
    >
      {/* Time accuracy */}
      <div className="rounded-lg bg-surface-raised p-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
          Time accuracy
        </p>
        <p className={`mt-1 text-xs font-bold capitalize ${outcomeClass}`}>
          {outcomeLabel(task.timing_outcome)}
        </p>
        <p className="mt-1 text-[11px] tabular-nums text-gray-400">
          est. {effective}m
          <span className="mx-1 text-gray-600">·</span>
          actual {timing?.actual_minutes ?? task.actual_minutes ?? "—"}m
        </p>
      </div>

      {/* Exam accuracy */}
      <div className="rounded-lg bg-surface-raised p-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
          Exam accuracy
        </p>
        {task.examResult ? (
          <>
            <p
              className={`mt-1 text-xs font-bold ${
                task.examResult.passed
                  ? "text-emerald-400"
                  : "text-amber-400"
              }`}
            >
              {task.examResult.score}%
            </p>
            <p className="mt-1 text-[11px] tabular-nums text-gray-400">
              {task.examResult.correct}/{task.examResult.total} correct
            </p>
          </>
        ) : (
          <p className="mt-1 text-[11px] text-gray-500">Not taken yet</p>
        )}
      </div>
    </div>
  );
}

