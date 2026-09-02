"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, CalendarDays, Search, X } from "lucide-react";
import {
  CompletedItem,
  DayStats,
  EstimationRecord,
  PracticeTask,
  Roadmap,
} from "@/lib/types";
import { practiceWindow } from "@/lib/practice";
import { sortHistoryByDate } from "@/lib/storage";
import { formatFocusMinutes, topicSummaries } from "@/lib/topic-history";
import InsightsPanel from "@/components/InsightsPanel";

interface HistoryModalProps {
  /** v5 Â§11 â€” practice goal outcomes are preserved here forever. */
  practiceTasks?: PracticeTask[];
  open: boolean;
  history: Record<string, DayStats>;
  roadmaps: Roadmap[];
  /** Logged focus samples â€” feeds real per-topic focus totals. */
  estimationLog: EstimationRecord[];
  /** Â§5 Clicking a logged task jumps back into its roadmap day. */
  onJumpTask: (item: CompletedItem) => void;
  onClose: () => void;
}

export default function HistoryModal({
  open,
  history,
  roadmaps,
  practiceTasks = [],
  estimationLog,
  onJumpTask,
  onClose,
}: HistoryModalProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");

  // Close on Escape key.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const entries = sortHistoryByDate(history);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="History"
    >
      <div
        className="animate-pop-in flex max-h-[80vh] w-full max-w-xl flex-col rounded-2xl bg-surface-raised shadow-2xl ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-habeet-600" />
            <h2 className="text-lg font-bold text-gray-100">
              History
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close history"
            className="rounded-lg p-1.5 text-gray-500 transition hover:bg-white/5 hover:text-gray-200"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto px-5 py-4">
          {/* Saved tasks â€” ChatGPT-style searchable saved conversations.
              Clicking an existing task re-opens ITS dedicated workspace with
              its own roadmap, progress and timer (never a duplicate). */}
          {(practiceTasks?.length ?? 0) > 0 && (
            <section aria-label="Saved tasks" className="mb-5">
              <h3 className="mb-2 text-sm font-bold text-gray-100">
                Saved tasks
              </h3>
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
                <input
                  data-testid="history-search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search your saved tasksâ€¦"
                  className="w-full rounded-xl border border-white/10 bg-surface px-9 py-2 text-sm text-gray-100 outline-none transition placeholder:text-gray-500 focus:border-habeet-500/50 focus:ring-2 focus:ring-habeet-500/20"
                />
              </div>
              {(() => {
                const q = query.trim().toLowerCase();
                const filtered = (practiceTasks ?? []).filter((t) =>
                  q
                    ? t.name.toLowerCase().includes(q) ||
                      (t.description ?? "").toLowerCase().includes(q)
                    : true
                );
                if (filtered.length === 0) {
                  return (
                    <p className="py-3 text-center text-sm text-gray-500">
                      No tasks match â€œ{query.trim()}â€.
                    </p>
                  );
                }
                return (
                  <ul className="space-y-1.5">
                    {filtered.map((t) => {
                      const w = practiceWindow(t);
                      return (
                        <li key={t.id} data-testid={`hgoal-${t.id}`}>
                          <button
                            onClick={() => {
                              onClose();
                              router.push(`/task/${t.id}`);
                            }}
                            className="group flex w-full items-center gap-3 rounded-xl bg-surface p-3 text-left ring-1 ring-white/5 outline-none transition hover:bg-surface-overlay hover:ring-habeet-500/30 focus-visible:ring-2 focus-visible:ring-habeet-400"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-gray-100 group-hover:text-habeet-200">
                                {t.name}
                              </span>
                              <span className="block text-[11px] tabular-nums text-gray-500">
                                {w.rangeLabel} Â· {w.completedDays}/{t.durationDays} days Â· {w.status}
                              </span>
                            </span>
                            <ArrowUpRight className="h-4 w-4 shrink-0 text-habeet-400 opacity-0 transition group-hover:opacity-100" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                );
              })()}
            </section>
          )}

          {/* Phase 5: personal insights (pure client-side aggregation). */}
          <InsightsPanel history={history} roadmaps={roadmaps} />

          {/* Â§5 Per-topic progress summaries. */}
          {roadmaps.length > 0 && (
            <section aria-label="Progress by topic" className="mb-5">
              <h3 className="mb-2 text-sm font-bold text-gray-100">
                Progress by topic
              </h3>
              <ul className="space-y-2">
                {topicSummaries(roadmaps, estimationLog).map((t) => (
                  <li
                    key={t.id}
                    className="rounded-xl bg-surface p-3 ring-1 ring-white/5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-semibold text-gray-100">
                        <span className="mr-1">{t.icon}</span>
                        {t.topic}
                      </span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                          t.status === "completed"
                            ? "bg-habeet-500/10 text-habeet-200 ring-1 ring-habeet-500/30 hover:bg-habeet-500/20"
                            : "bg-habeet-500/15 text-habeet-200"
                        }`}
                      >
                        {t.status === "completed" ? "Done" : `${t.pct}%`}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[11px] text-gray-400">
                      <span>
                        Day {t.doneDays} of {t.totalDays}
                      </span>
                      <span>{formatFocusMinutes(t.focusMinutes)} focus</span>
                    </div>
                    <div
                      className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-overlay"
                      role="progressbar"
                      aria-valuenow={t.pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`${t.topic} progress`}
                    >
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-habeet-500 to-habeet-600 transition-all duration-500"
                        style={{ width: `${Math.min(100, t.pct)}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {entries.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">
              No history yet. Complete a session or add tasks to see your
              stats here!
            </p>
          ) : (
            <ul className="space-y-3">
              {entries.map((entry) => (
                <li
                  key={entry.date}
                  className="rounded-xl bg-surface p-4 ring-1 ring-white/5"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-semibold text-gray-100">
                      {entry.date}
                    </span>
                    <span className="rounded-full bg-habeet-100 px-2.5 py-0.5 text-xs font-bold text-habeet-700 dark:bg-habeet-900/40 dark:text-habeet-300">
                      {entry.productivity}%
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <p className="text-lg font-bold text-gray-100">
                        {entry.sessions_count}
                      </p>
                      <p className="text-[11px] text-gray-400">
                        Sessions
                      </p>
                    </div>
                    <div>
                      <p className="text-lg font-bold text-gray-100">
                        {entry.focus_minutes}
                      </p>
                      <p className="text-[11px] text-gray-400">
                        Focus min
                      </p>
                    </div>
                    <div>
                      <p className="text-lg font-bold text-gray-100">
                        {entry.tasks_completed}/{entry.total_tasks}
                      </p>
                      <p className="text-[11px] text-gray-400">
                        Tasks
                      </p>
                    </div>
                  </div>

                  {/* Â§5 Clickable log of exactly which tasks were done. */}
                  {(entry.completed_items?.length ?? 0) > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {entry.completed_items!.map((item, i) => {
                        const jumpable = !!item.roadmapId && !!item.dayNumber;
                        return (
                          <li key={`${item.name}-${i}`}>
                            <button
                              onClick={() =>
                                jumpable ? onJumpTask(item) : undefined
                              }
                              disabled={!jumpable}
                              title={
                                jumpable
                                  ? "Jump back into this task"
                                  : "Standalone task (no roadmap day)"
                              }
                              className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition outline-none focus-visible:ring-2 focus-visible:ring-habeet-500/60 ${
                                jumpable
                                  ? "bg-habeet-500/10 text-habeet-200 ring-1 ring-habeet-500/30 hover:bg-habeet-500/20"
                                  : "cursor-default bg-white/5 text-gray-500"
                              }`}
                            >
                              {item.name}
                              {jumpable && (
                                <ArrowUpRight className="h-3 w-3 opacity-70" />
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
