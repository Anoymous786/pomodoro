"use client";

import { useState } from "react";
import {
  Check,
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
}

const PRIORITY_OPTIONS: { value: Priority; label: string; dot: string }[] = [
  { value: "high", label: "High", dot: "bg-red-500" },
  { value: "medium", label: "Medium", dot: "bg-yellow-500" },
  { value: "low", label: "Low", dot: "bg-green-500" },
];

const PRIORITY_DOT: Record<Priority, string> = {
  high: "bg-red-500",
  medium: "bg-yellow-500",
  low: "bg-green-500",
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
      // Clear only after the add succeeded so a failure never loses input.
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

  const cancelEdit = () => {
    setEditingId(null);
  };

  const startMinutesEdit = (task: Task) => {
    setMinutesEditId(task.id);
    setMinutesEditValue(String(effectiveMinutes(task.estimated_minutes, task.manual_minutes)));
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
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">
          {"Today's Tasks"}
        </h2>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-tomato-100 px-3 py-1 text-xs font-semibold text-tomato-700 dark:bg-tomato-900/40 dark:text-tomato-300">
            Tasks Completed: {tasksCompleted}/{totalTasks}
          </span>
          <span className="hidden items-center gap-1 rounded-full bg-sky-100 px-3 py-1 text-xs font-semibold text-sky-700 sm:flex dark:bg-sky-900/40 dark:text-sky-300">
            <Clock className="h-3.5 w-3.5" />
            {totalEffective} min total
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
          className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-tomato-500 focus:ring-2 focus:ring-tomato-500/30 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        />
        <div className="flex flex-wrap gap-2">
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority)}
            aria-label="Task priority"
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-tomato-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          >
            {PRIORITY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100">
            <input
              type="number"
              min={1}
              value={estimatedMinutes}
              onChange={(e) => setEstimatedMinutes(e.target.value)}
              aria-label="Estimated minutes"
              className="w-12 bg-transparent text-center outline-none"
            />
            <span className="text-xs text-gray-500">min</span>
          </div>
          <button
            onClick={handleAdd}
            className="flex items-center gap-1 rounded-lg bg-tomato-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-tomato-700 active:scale-95"
          >
            <Plus className="h-4 w-4" />
            Add
          </button>
        </div>
      </div>

      {addError && (
        <p
          role="alert"
          className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/30 dark:text-red-300"
        >
          {addError}
        </p>
      )}

      {/* Task list */}
      {tasks.length === 0 ? (
        <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
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
                className={`group flex items-center gap-3 rounded-lg border px-3 py-2.5 transition ${
                  isActiveTask
                    ? "border-tomato-300 bg-tomato-50 dark:border-tomato-700 dark:bg-tomato-900/20"
                    : "border-gray-100 bg-gray-50 hover:border-gray-200 dark:border-gray-700 dark:bg-gray-900"
                }`}
              >
                {/* Priority dot */}
                <span
                  className={`h-2.5 w-2.5 shrink-0 rounded-full ${PRIORITY_DOT[task.priority]}`}
                  aria-label={`${task.priority} priority`}
                />

                {/* Checkbox */}
                <button
                  onClick={() => onToggle(task.id)}
                  aria-label={task.is_completed ? "Mark incomplete" : "Mark complete"}
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition ${
                    task.is_completed
                      ? "border-tomato-600 bg-tomato-600 text-white"
                      : "border-gray-300 bg-white hover:border-tomato-500 dark:border-gray-600 dark:bg-gray-800"
                  }`}
                >
                  {task.is_completed && <Check className="h-3.5 w-3.5" />}
                </button>

                {/* Task name + minutes */}
                {isEditing ? (
                  <div className="flex flex-1 items-center gap-2">
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && saveEdit()}
                      autoFocus
                      className="flex-1 rounded border border-tomato-500 bg-white px-2 py-1 text-sm text-gray-900 outline-none dark:bg-gray-800 dark:text-gray-100"
                    />
                    <select
                      value={editPriority}
                      onChange={(e) =>
                        setEditPriority(e.target.value as Priority)
                      }
                      aria-label="Edit priority"
                      className="rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
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
                      className="rounded p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
                    >
                      <Check className="h-4 w-4" />
                    </button>
                    <button
                      onClick={cancelEdit}
                      aria-label="Cancel edit"
                      className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <span
                    className={`flex-1 text-sm ${
                      task.is_completed
                        ? "text-gray-400 line-through dark:text-gray-500"
                        : "text-gray-800 dark:text-gray-100"
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
                        title={`Exam: ${task.examResult.score}% — ${
                          task.examResult.passed ? "passed" : "needs review"
                        }`}
                        className={`flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold transition ${
                          task.examResult.passed
                            ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300"
                            : "bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-300"
                        }`}
                      >
                        <GraduationCap className="h-3.5 w-3.5" />
                        {task.examResult.score}%
                      </button>
                    )}
                    {isEditingMinutes ? (
                      <div className="flex items-center gap-1 rounded-lg border border-tomato-500 bg-white px-1.5 py-0.5 dark:bg-gray-800">
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
                          aria-label="Edit minutes"
                          className="w-12 bg-transparent text-center text-sm text-gray-900 outline-none dark:text-gray-100"
                        />
                        <span className="text-xs text-gray-500">min</span>
                        <button
                          onClick={() => saveMinutesEdit(task)}
                          aria-label="Save minutes"
                          className="rounded p-0.5 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => startMinutesEdit(task)}
                        title="Edit estimated time"
                        aria-label={`Edit estimated time for ${task.name}`}
                        className={`flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition ${
                          task.manual_minutes != null
                            ? "bg-sky-100 text-sky-700 hover:bg-sky-200 dark:bg-sky-900/40 dark:text-sky-300"
                            : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
                        }`}
                      >
                        <Clock className="h-3.5 w-3.5" />
                        {effective} min
                        <Pencil className="h-3 w-3 opacity-60" />
                      </button>
                    )}
                  </div>
                )}

                {/* Actions */}
                {!isEditing && !isEditingMinutes && (
                  <div className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100">
                    {!task.is_completed && (
                      <button
                        onClick={() => onStartTask(task.id)}
                        aria-label={`Start timer for ${task.name}`}
                        title="Start this task's timer"
                        className="rounded p-1.5 text-tomato-600 hover:bg-tomato-50 dark:hover:bg-tomato-900/30"
                      >
                        <Play className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      onClick={() => startEdit(task)}
                      aria-label="Edit task"
                      className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-tomato-600 dark:hover:bg-gray-700"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => onDelete(task.id)}
                      aria-label="Delete task"
                      className="rounded p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}