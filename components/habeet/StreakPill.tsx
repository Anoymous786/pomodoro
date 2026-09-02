"use client";

import { Flame } from "lucide-react";

/**
 * StreakPill — rounded pill in the header's top-right (§0):
 * purple-tinted background, flame icon + "N days".
 */
export default function StreakPill({ days }: { days: number }) {
  const active = days > 0;
  return (
    <div
      title={
        active
          ? `${days} consecutive day${days === 1 ? "" : "s"} of focused work`
          : "Complete a session or task to start a streak"
      }
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 transition ${
        active
          ? "border-habeet-500/40 bg-habeet-500/15 hover:bg-habeet-500/25"
          : "border-white/10 bg-surface-raised hover:bg-surface-overlay"
      }`}
    >
      <Flame
        className={`h-4 w-4 ${active ? "text-habeet-400" : "text-gray-500"}`}
      />
      <span
        className={`text-sm font-semibold tabular-nums ${
          active ? "text-habeet-200" : "text-gray-400"
        }`}
      >
        {days} {active ? `day${days === 1 ? "" : "s"}` : "days"}
      </span>
    </div>
  );
}
