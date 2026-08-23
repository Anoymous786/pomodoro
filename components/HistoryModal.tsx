"use client";

import { useEffect } from "react";
import { CalendarDays, X } from "lucide-react";
import { DayStats } from "@/lib/types";
import { sortHistoryByDate } from "@/lib/storage";

interface HistoryModalProps {
  open: boolean;
  history: Record<string, DayStats>;
  onClose: () => void;
}

export default function HistoryModal({
  open,
  history,
  onClose,
}: HistoryModalProps) {
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
        className="animate-pop-in flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-2xl dark:bg-gray-800"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-tomato-600" />
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">
              History
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close history"
            className="rounded-lg p-1.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto px-5 py-4">
          {entries.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
              No history yet. Complete a session or add tasks to see your
              stats here!
            </p>
          ) : (
            <ul className="space-y-3">
              {entries.map((entry) => (
                <li
                  key={entry.date}
                  className="rounded-xl border border-gray-100 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-semibold text-gray-900 dark:text-gray-100">
                      {entry.date}
                    </span>
                    <span className="rounded-full bg-tomato-100 px-2.5 py-0.5 text-xs font-bold text-tomato-700 dark:bg-tomato-900/40 dark:text-tomato-300">
                      {entry.productivity}%
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <p className="text-lg font-bold text-gray-900 dark:text-gray-100">
                        {entry.sessions_count}
                      </p>
                      <p className="text-[11px] text-gray-500 dark:text-gray-400">
                        Sessions
                      </p>
                    </div>
                    <div>
                      <p className="text-lg font-bold text-gray-900 dark:text-gray-100">
                        {entry.focus_minutes}
                      </p>
                      <p className="text-[11px] text-gray-500 dark:text-gray-400">
                        Focus min
                      </p>
                    </div>
                    <div>
                      <p className="text-lg font-bold text-gray-900 dark:text-gray-100">
                        {entry.tasks_completed}/{entry.total_tasks}
                      </p>
                      <p className="text-[11px] text-gray-500 dark:text-gray-400">
                        Tasks
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}