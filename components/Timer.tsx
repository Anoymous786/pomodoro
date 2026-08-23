"use client";

import { Pause, Play, RotateCcw } from "lucide-react";
import { MODE_LABELS, TimerMode } from "@/lib/types";

interface TimerProps {
  mode: TimerMode;
  isRunning: boolean;
  displayTime: string;
  remainingMs: number;
  durationMs: number;
  activeTaskName?: string | null;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
}

/**
 * Circular tomato graphic with a digital countdown in the center.
 * The ring progress is derived from remainingMs / durationMs.
 * While in work mode, the active task's name is shown above the
 * timer so it's clear which task is being timed.
 */
export default function Timer({
  mode,
  isRunning,
  displayTime,
  remainingMs,
  durationMs,
  activeTaskName,
  onStart,
  onPause,
  onReset,
}: TimerProps) {
  const progress = durationMs > 0 ? remainingMs / durationMs : 0;
  const circumference = 2 * Math.PI * 90; // r = 90
  const dashOffset = circumference * (1 - progress);

  const modeColor: Record<TimerMode, string> = {
    work: "text-tomato-600",
    shortBreak: "text-emerald-600",
    longBreak: "text-sky-600",
  };

  const ringColor: Record<TimerMode, string> = {
    work: "stroke-tomato-500",
    shortBreak: "stroke-emerald-500",
    longBreak: "stroke-sky-500",
  };

  const modeBadge: Record<TimerMode, string> = {
    work: "bg-tomato-100 text-tomato-700",
    shortBreak: "bg-emerald-100 text-emerald-700",
    longBreak: "bg-sky-100 text-sky-700",
  };

  const showTaskName =
    mode === "work" && activeTaskName && activeTaskName.trim().length > 0;

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-5">
      {/* Active task name banner */}
      <div className="min-h-[2.5rem] w-full">
        {showTaskName ? (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-tomato-200 bg-tomato-50 px-4 py-2 dark:border-tomato-800 dark:bg-tomato-900/30">
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-tomato-500" />
            <span className="truncate text-sm font-semibold text-tomato-800 dark:text-tomato-200">
              {activeTaskName}
            </span>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-gray-400 dark:text-gray-500">
            {mode === "work"
              ? "No task selected — generic work session"
              : MODE_LABELS[mode]}
          </div>
        )}
      </div>

      {/* Circular tomato graphic */}
      <div className="relative h-56 w-56 sm:h-64 sm:w-64">
        <svg viewBox="0 0 200 200" className="h-full w-full -rotate-90">
          {/* Track */}
          <circle
            cx="100"
            cy="100"
            r="90"
            fill="none"
            strokeWidth="10"
            className="stroke-gray-200 dark:stroke-gray-700"
          />
          {/* Progress ring */}
          <circle
            cx="100"
            cy="100"
            r="90"
            fill="none"
            strokeWidth="10"
            strokeLinecap="round"
            className={`${ringColor[mode]} transition-all duration-500`}
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
          />
        </svg>
        {/* Tomato leaf accent */}
        <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2">
          <svg viewBox="0 0 40 24" className="h-6 w-10 fill-emerald-500">
            <path d="M20 24 C 8 20, 2 12, 4 4 C 12 6, 18 10, 20 14 C 22 10, 28 6, 36 4 C 38 12, 32 20, 20 24 Z" />
          </svg>
        </div>
        {/* Center content */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className={`text-5xl font-bold tabular-nums sm:text-6xl ${modeColor[mode]}`}
          >
            {displayTime}
          </span>
          <span
            className={`mt-2 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${modeBadge[mode]}`}
          >
            {MODE_LABELS[mode]}
          </span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3">
        <button
          onClick={isRunning ? onPause : onStart}
          className="flex items-center gap-2 rounded-full bg-tomato-600 px-6 py-3 font-semibold text-white shadow-lg shadow-tomato-600/30 transition hover:bg-tomato-700 active:scale-95"
        >
          {isRunning ? (
            <>
              <Pause className="h-5 w-5" />
              Pause
            </>
          ) : (
            <>
              <Play className="h-5 w-5" />
              Start
            </>
          )}
        </button>
        <button
          onClick={onReset}
          aria-label="Reset timer"
          className="flex items-center gap-2 rounded-full border border-gray-300 bg-white px-5 py-3 font-semibold text-gray-700 transition hover:bg-gray-50 active:scale-95 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          <RotateCcw className="h-5 w-5" />
          Reset
        </button>
      </div>
    </div>
  );
}