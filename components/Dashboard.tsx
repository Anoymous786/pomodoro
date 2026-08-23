"use client";

import { CheckCircle2, Clock, Target, Timer } from "lucide-react";
import { DayStats } from "@/lib/types";

interface DashboardProps {
  todayStats: DayStats;
  tasksCompleted: number;
  totalTasks: number;
  liveProductivity: number;
}

/**
 * Live productivity dashboard.
 *
 * "Today's Progress" uses the same weighted formula as the history
 * modal (see computeProductivity in lib/storage.ts):
 *   productivity = 0.5 * (tasks_completed / total_tasks) * 100
 *                + 0.5 * (sessions_count / dailySessionGoal) * 100
 * Each term is clamped to 100%.
 */
export default function Dashboard({
  todayStats,
  tasksCompleted,
  totalTasks,
  liveProductivity,
}: DashboardProps) {
  const counters = [
    {
      label: "Sessions Completed",
      value: todayStats.sessions_count,
      icon: Timer,
      color: "text-tomato-600 bg-tomato-100 dark:bg-tomato-900/40 dark:text-tomato-300",
    },
    {
      label: "Focus Time (min)",
      value: todayStats.focus_minutes,
      icon: Clock,
      color: "text-sky-600 bg-sky-100 dark:bg-sky-900/40 dark:text-sky-300",
    },
    {
      label: "Tasks Completed",
      value: `${tasksCompleted}/${totalTasks}`,
      icon: CheckCircle2,
      color: "text-emerald-600 bg-emerald-100 dark:bg-emerald-900/40 dark:text-emerald-300",
    },
  ];

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div className="mb-4 flex items-center gap-2">
        <Target className="h-5 w-5 text-tomato-600" />
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">
          {"Today's Progress"}
        </h2>
      </div>

      {/* Counters */}
      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {counters.map((c) => (
          <div
            key={c.label}
            className="flex items-center gap-3 rounded-xl border border-gray-100 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900"
          >
            <div className={`rounded-lg p-2 ${c.color}`}>
              <c.icon className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xl font-bold text-gray-900 dark:text-gray-100">
                {c.value}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {c.label}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Progress bar */}
      <div>
        <div className="mb-1.5 flex items-center justify-between text-sm">
          <span className="font-medium text-gray-700 dark:text-gray-300">
            {"Today's Progress"}
          </span>
          <span className="font-bold text-tomato-600">{liveProductivity}%</span>
        </div>
        <div className="h-3 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
          <div
            className="h-full rounded-full bg-gradient-to-r from-tomato-500 to-tomato-600 transition-all duration-500"
            style={{ width: `${Math.min(100, liveProductivity)}%` }}
          />
        </div>
        <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
          Weighted: 50% tasks completed + 50% sessions vs. daily goal
        </p>
      </div>
    </section>
  );
}