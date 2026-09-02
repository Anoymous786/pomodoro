"use client";

import Link from "next/link";
import { ArrowUpRight, Clock, Map as MapIcon } from "lucide-react";
import type { PracticeTask } from "@/lib/types";
import { practiceWindow } from "@/lib/practice";
import {
  totalEstimatedMinutes,
  totalSimSeconds,
  formatDuration,
} from "@/lib/task-roadmap";

interface Props {
  tasks: PracticeTask[];
  /** Empty-state prompt shown when there are no saved tasks. */
  emptyHint?: string;
}

const STATUS_STYLE: Record<string, string> = {
  "In Progress": "bg-habeet-500/15 text-habeet-200 ring-habeet-400/40",
  Completed: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30",
  Overdue: "bg-amber-500/10 text-amber-300 ring-amber-400/30",
  "Not Started": "bg-white/5 text-gray-400 ring-white/10",
};

/**
 * Compact dashboard list of saved workspaces (NOT full cards, NOT full
 * roadmaps). Each row answers "what task, what state, what progress" and
 * opens /task/:id. Full roadmap, timer and check-ins live in the workspace,
 * not here.
 */
export default function WorkspaceList({
  tasks,
  emptyHint = "No tasks yet — hit New Task to start one today.",
}: Props) {
  if (tasks.length === 0) {
    return (
      <div
        data-testid="ws-empty"
        className="py-8 text-center text-sm text-gray-500"
      >
        <MapIcon className="mx-auto mb-2 h-6 w-6 text-gray-600" />
        {emptyHint}
      </div>
    );
  }

  const rows = tasks.map((t) => {
    const w = practiceWindow(t);
    const steps = t.roadmap ?? [];
    const practiced = totalSimSeconds(steps);
    const estMin = totalEstimatedMinutes(steps);
    const stepsDone = steps.filter((s) => s.isDone).length;
    // Blended progress: width of the bar.
    let pct = w.progressPct;
    if (steps.length > 0) {
      const doneOnly = Math.round((stepsDone / steps.length) * 100);
      pct = Math.max(doneOnly, w.progressPct);
    }
    return { t, w, stepsDone, stepsTotal: steps.length, practiced, estMin, pct };
  });

  return (
    <ul className="divide-y divide-white/5">
      {rows.map(({ t, w, stepsDone, stepsTotal, practiced, estMin, pct }) => (
        <li
          key={t.id}
          data-testid={`ptask-${t.id}`}
          className="group flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Link
                href={`/task/${t.id}`}
                data-testid={`ws-link-${t.id}`}
                className="min-w-0 truncate text-[15px] font-semibold text-gray-50 outline-none transition hover:text-habeet-200 focus-visible:ring-2 focus-visible:ring-habeet-400"
              >
                {t.name}
              </Link>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${
                  STATUS_STYLE[w.status] ?? STATUS_STYLE["Not Started"]
                }`}
              >
                {w.status}
              </span>
            </div>
            {t.description && (
              <p className="mt-0.5 truncate text-xs text-gray-500">
                {t.description}
              </p>
            )}
            {/* Progress bar */}
            <div className="mt-2 flex items-center gap-2">
              <div
                className="h-1.5 w-full max-w-[260px] overflow-hidden rounded-full bg-surface-overlay"
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="h-full rounded-full bg-gradient-to-r from-habeet-500 to-habeet-400 transition-all duration-500"
                  style={{ width: `${Math.min(100, pct)}%` }}
                />
              </div>
              <span
                data-testid={`pprog-${t.id}`}
                className="shrink-0 text-[11px] font-semibold tabular-nums text-gray-400"
              >
                {pct}%
                {stepsTotal > 0 && ` · ${stepsDone}/${stepsTotal}`}
              </span>
            </div>
          </div>

          {/* Right meta: roadmaps deadend / practice time / open */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 text-[11px] tabular-nums text-gray-400 sm:flex-col sm:items-end sm:gap-1">
            {stepsTotal > 0 ? (
              <span className="inline-flex items-center gap-1">
                <MapIcon className="h-3 w-3 text-habeet-400" />
                {stepsTotal} step{stepsTotal === 1 ? "" : "s"}
              </span>
            ) : (
              <span data-testid={`prange-${t.id}`} className="text-gray-500">
                {w.durationLabel} · {w.rangeLabel}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatDuration(practiced)}
            </span>
            <Link
              href={`/task/${t.id}`}
              data-testid={`ws-open-${t.id}`}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-habeet-300 outline-none transition hover:bg-habeet-500/10 focus-visible:ring-2 focus-visible:ring-habeet-400"
            >
              Open <ArrowUpRight className="h-3 w-3" />
            </Link>
          </div>
        </li>
      ))}
    </ul>
  );
}