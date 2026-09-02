"use client";

import Link from "next/link";
import { Check, Map as MapIcon } from "lucide-react";
import type { PracticeTask } from "@/lib/types";
import { practiceWindow } from "@/lib/practice";

interface Props {
  task: PracticeTask;
  /** Toggles a day's check-in (1-based day number). */
  onToggle: (day: number) => void;
}

const STATUS_STYLE: Record<string, { badge: string; ring: string }> = {
  "In Progress": {
    badge: "bg-habeet-500/15 text-habeet-200 ring-habeet-400/40",
    ring: "ring-white/5",
  },
  Completed: {
    badge: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30",
    ring: "ring-emerald-500/20",
  },
  Overdue: {
    badge: "bg-amber-500/10 text-amber-300 ring-amber-400/30",
    ring: "ring-amber-500/25",
  },
  "Not Started": {
    badge: "bg-white/5 text-gray-400 ring-white/10",
    ring: "ring-white/5",
  },
};

/**
 * v5 §8 — individual task dashboard: duration chip, live date range,
 * progress bar, per-day check-in grid (no exam), status & overdue state.
 */
export default function PracticeTaskCard({ task, onToggle }: Props) {
  const w = practiceWindow(task);
  const style = STATUS_STYLE[w.status] ?? STATUS_STYLE["Not Started"];
  const locked = w.status === "Overdue" || w.status === "Completed";

  return (
    <article
      data-testid={`ptask-${task.id}`}
      className={`flex flex-col rounded-2xl bg-surface-raised p-4 ring-1 ${style.ring}`}
    >
      {/* Title + status — title opens the task's dedicated workspace */}
      <div className="mb-2 flex items-start justify-between gap-2">
        <Link
          href={`/task/${task.id}`}
          data-testid={`ws-link-${task.id}`}
          className="min-w-0 truncate text-[15px] font-semibold text-gray-50 outline-none transition hover:text-habeet-200 hover:underline focus-visible:ring-2 focus-visible:ring-habeet-400"
        >
          {task.name}
        </Link>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${style.badge}`}
        >
          {w.status}
        </span>
      </div>
      {task.description && (
        <p className="mb-2 line-clamp-2 text-xs leading-snug text-gray-400">
          {task.description}
        </p>
      )}

      {/* Duration + range */}
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] tabular-nums">
        <span className="rounded-md bg-habeet-500/15 px-2 py-0.5 font-semibold text-habeet-200">
          {w.durationLabel}
        </span>
        <span data-testid={`prange-${task.id}`} className="text-gray-400">
          {w.rangeLabel}
        </span>
      </div>

      {/* Progress */}
      <div className="mb-1 flex items-center justify-between text-[11px] font-medium tabular-nums">
        <span data-testid={`pprog-${task.id}`} className="text-gray-300">
          Progress {w.progressPct}%
        </span>
        <span className="text-gray-500">
          {w.completedDays}/{task.durationDays} days
        </span>
      </div>
      <div
        className="mb-3 h-2 w-full overflow-hidden rounded-full bg-surface-overlay"
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

      {/* Day grid */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {Array.from({ length: task.durationDays }, (_, i) => i + 1).map(
          (day) => {
            const checked = task.checkIns.includes(day);
            const isToday = day === w.currentDay;
            const isPast = day < w.currentDay;
            const disabled = locked || (!checked && day > w.currentDay);
            return (
              <button
                key={day}
                onClick={() => !disabled && onToggle(day)}
                disabled={disabled}
                title={
                  disabled
                    ? checked
                      ? `Day ${day}`
                      : day > w.currentDay
                      ? "Not yet — future day"
                      : `Day ${day}`
                    : `Check in Day ${day}`
                }
                aria-label={`Day ${day}${checked ? ", checked in" : ""}`}
                aria-pressed={checked}
                data-testid={`ptick-${task.id}-${day}`}
                className={`flex h-7 w-7 items-center justify-center rounded-lg border text-[11px] font-semibold tabular-nums outline-none transition focus-visible:ring-2 focus-visible:ring-habeet-400 ${
                  checked
                    ? "border-habeet-500 bg-habeet-600 text-white hover:bg-habeet-500"
                    : isPast && w.status !== "Overdue"
                    ? "border-amber-400/40 bg-transparent text-amber-300/80 hover:bg-amber-500/10"
                    : isToday
                    ? "border-habeet-400/60 bg-habeet-500/10 text-habeet-200 hover:bg-habeet-500/20"
                    : "border-white/10 text-gray-500 hover:border-white/20"
                } ${disabled ? "cursor-not-allowed opacity-45" : ""}`}
              >
                {checked ? <Check className="h-3.5 w-3.5" /> : day}
              </button>
            );
          }
        )}
      </div>

      {/* Footer */}
      <div className="mt-auto flex items-center justify-between gap-2">
        <p className="text-[11px] tabular-nums text-gray-500">
          {w.status === "Completed"
            ? "All days checked in 🎉"
            : w.status === "Overdue"
            ? "Deadline passed — preserved in History"
            : `${w.daysRemaining} day${w.daysRemaining === 1 ? "" : "s"} remaining`}
        </p>
        <Link
          href={`/task/${task.id}`}
          className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-habeet-300 outline-none transition hover:bg-habeet-500/10 focus-visible:ring-2 focus-visible:ring-habeet-400"
        >
          <MapIcon className="h-3 w-3" />
          Workspace
        </Link>
      </div>
    </article>
  );
}
