"use client";

import { Flame, Pause, Play, RotateCcw } from "lucide-react";
import { MODE_LABELS, TimerMode } from "@/lib/types";
import ProgressRing from "@/components/habeet/ProgressRing";

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
  /** Quiet stat tiles inside the same card (§1 left column). */
  currentStreak: number;
  todayPct: number;
}

/**
 * Habeet timer card: large purple progress ring (200px desktop / 150px
 * mobile, same proportional stroke), time centered inside, mode label
 * beneath, Start/Reset controls, then a 2-col row of quiet stat tiles
 * (current streak · today's completion %).
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
  currentStreak,
  todayPct,
}: TimerProps) {
  const progress = durationMs > 0 ? remainingMs / durationMs : 0;

  const showTaskName =
    mode === "work" && activeTaskName && activeTaskName.trim().length > 0;

    return (
    <div
      data-testid="timer-card"
      className={`card-elevated flex h-full w-full flex-col items-center gap-5 p-5 ${
        isRunning ? "shadow-glow" : ""
      }`}
    >
      {/* Active task banner */}
      <div className="min-h-[2.25rem] w-full">
        {showTaskName ? (
          <div className="flex items-center justify-center gap-2 rounded-xl bg-habeet-500/10 px-4 py-2 ring-1 ring-habeet-500/30">
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-habeet-400" />
            <span className="truncate text-sm font-semibold text-habeet-200">
              {activeTaskName}
            </span>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-center text-xs text-gray-500">
            {mode === "work"
              ? "No task selected — generic work session"
              : MODE_LABELS[mode]}
          </div>
        )}
      </div>

      {/* Circular progress ring — 150px mobile → 200px desktop */}
      <div className="relative h-[150px] w-[150px] lg:h-[200px] lg:w-[200px]">
        <ProgressRing
          progress={progress}
          size={200}
          strokeWidth={12}
          className="!h-full !w-full"
          title={`${MODE_LABELS[mode]} — ${Math.round(progress * 100)}% remaining`}
          active={isRunning}
        />
        {/* Center content */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span
            className={`text-4xl font-bold tabular-nums lg:text-5xl ${
              isRunning ? "text-gray-50" : "text-gray-300"
            }`}
            style={{ textShadow: "0 2px 16px rgba(139,92,246,0.35)" }}
          >
            {displayTime}
          </span>
          {isRunning && (
            <span className="mt-1 text-[10px] font-medium uppercase tracking-widest text-habeet-300">
              focusing
            </span>
          )}
        </div>
      </div>

      {/* Mode label beneath the ring */}
      <p className="-mt-3 text-xs font-medium uppercase tracking-widest text-gray-400">
        {isRunning ? MODE_LABELS[mode] : `${MODE_LABELS[mode]} ready`}
      </p>

      {/* Controls — side-by-side full-width on mobile */}
            <div className="grid w-full grid-cols-2 gap-3 lg:flex lg:justify-center">
        <button
          onClick={isRunning ? onPause : onStart}
          aria-label={isRunning ? "Pause timer" : "Start timer"}
          data-testid="timer-start-pause-btn"
          className="btn-primary w-full px-6 py-3 text-sm lg:w-auto"
        >
          {isRunning ? (
            <>
              <Pause className="h-4 w-4" />
              Pause
            </>
          ) : (
            <>
              <Play className="h-4 w-4" />
              Start
            </>
          )}
        </button>
                <button
          onClick={onReset}
          aria-label="Reset timer"
          data-testid="timer-reset-btn"
          className="btn-secondary w-full px-5 py-3 text-sm lg:w-auto"
        >
          <RotateCcw className="h-4 w-4" />
          Reset
        </button>
      </div>

      {/* Quiet stat tiles — exactly 2 per row */}
            <div className="mt-auto grid w-full grid-cols-2 gap-3 border-t border-white/5 pt-4">
        <div data-testid="stat-current-streak" className="flex items-center gap-2.5 rounded-xl bg-surface-raised p-3 transition hover:bg-surface-overlay">
          <span
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
              currentStreak > 0
                ? "bg-habeet-500/20 text-habeet-300"
                : "bg-white/5 text-gray-500"
            }`}
          >
            <Flame className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-base font-semibold leading-none tabular-nums text-gray-100">
              {currentStreak}
              <span className="ml-1 text-[11px] font-normal text-gray-400">
                day{currentStreak === 1 ? "" : "s"}
              </span>
            </p>
            <p className="mt-1 truncate text-[11px] text-gray-500">Streak</p>
          </div>
        </div>
                <div data-testid="stat-today-pct" className="flex items-center gap-2.5 rounded-xl bg-surface-raised p-3 transition hover:bg-surface-overlay">
          <ProgressRing
            progress={todayPct / 100}
            size={34}
            strokeWidth={4}
            title="Today's completion"
          />
          <div className="min-w-0">
            <p className="text-base font-semibold leading-none tabular-nums text-gray-100">
              {todayPct}%
            </p>
            <p className="mt-1 truncate text-[11px] text-gray-500">Today</p>
          </div>
        </div>
      </div>
    </div>
  );
}