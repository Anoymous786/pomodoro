"use client";

import { useMemo } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import type { DayStats } from "@/lib/types";

/**
 * WeeklyChart — mobile-friendly replacement for the 12-week heatmap (§2 #3).
 * A simple Mon–Sun bar chart of focus minutes for the current week plus a
 * "+N%" change badge comparing against the same span of the previous week.
 * Bars always render (zero days get a visible floor stub), never blank.
 */

const DAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];

/** Returns the "YYYY-MM-DD" Monday key of the week containing `dateKey`. */
function mondayOf(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00`);
  const dow = (d.getDay() + 6) % 7; // Mon=0 .. Sun=6
  d.setDate(d.getDate() - dow);
  return keyOf(d);
}

function keyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export interface WeekDatum {
  date: string;
  minutes: number;
  isToday: boolean;
  isFuture: boolean;
}

export function buildCurrentWeek(
  history: Record<string, DayStats>,
  todayKey: string,
  todayMinutes?: number
): WeekDatum[] {
  const start = new Date(`${mondayOf(todayKey)}T00:00:00`);
  const out: WeekDatum[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const key = keyOf(d);
    const live =
      key === todayKey && typeof todayMinutes === "number"
        ? { focus_minutes: todayMinutes }
        : null;
    const stats = live ?? history[key];
    const minutes = Math.max(0, Math.round(stats?.focus_minutes ?? 0));
    out.push({
      date: key,
      minutes,
      isToday: key === todayKey,
      isFuture: key > todayKey,
    });
  }
  return out;
}

/** % change of this week's Mon→today focus vs the same span last week. */
export function weeklyChangePct(
  history: Record<string, DayStats>,
  todayKey: string
): number | null {
  const thisMonday = new Date(`${mondayOf(todayKey)}T00:00:00`);
  let thisTotal = 0;
  let lastTotal = 0;
  for (let i = 0; i < 7; i++) {
    const cur = new Date(thisMonday);
    cur.setDate(cur.getDate() + i);
    const prev = new Date(thisMonday);
    prev.setDate(prev.getDate() - 7 + i);
    if (keyOf(cur) <= todayKey) {
      thisTotal += Math.max(0, history[keyOf(cur)]?.focus_minutes ?? 0);
      // Only count last week up to the equivalent weekday.
      lastTotal += Math.max(0, history[keyOf(prev)]?.focus_minutes ?? 0);
    }
  }
  if (thisTotal === 0 && lastTotal === 0) return null;
  if (lastTotal === 0) return 100;
  return Math.round(((thisTotal - lastTotal) / lastTotal) * 100);
}

export default function WeeklyChart({
  history,
  todayKey,
  todayMinutes,
}: {
  history: Record<string, DayStats>;
  todayKey: string;
  todayMinutes?: number;
}) {
  return (
    <>
      <WeekDeltaBadge history={history} todayKey={todayKey} />
      <WeeklyBars
        history={history}
        todayKey={todayKey}
        todayMinutes={todayMinutes}
      />
    </>
  );
}

/** The "+N%" change badge shown in the card header. */
export function WeekDeltaBadge({
  history,
  todayKey,
}: {
  history: Record<string, DayStats>;
  todayKey: string;
}) {
  const delta = useMemo(() => weeklyChangePct(history, todayKey), [history, todayKey]);
  if (delta === null) return null;
  return (
    <span
      className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold tabular-nums ${
        delta >= 0
          ? "bg-emerald-500/15 text-emerald-300"
          : "bg-orange-500/15 text-orange-300"
      }`}
      title="Focus minutes this week vs the same span last week"
    >
      {delta >= 0 ? (
        <TrendingUp className="h-3 w-3" />
      ) : (
        <TrendingDown className="h-3 w-3" />
      )}
      {delta >= 0 ? "+" : ""}
      {delta}%
    </span>
  );
}

/** The Mon–Sun bar chart itself (always renders — zero days get a stub). */
export function WeeklyBars({
  history,
  todayKey,
  todayMinutes,
}: {
  history: Record<string, DayStats>;
  todayKey: string;
  todayMinutes?: number;
}) {
  const week = useMemo(
    () => buildCurrentWeek(history, todayKey, todayMinutes),
    [history, todayKey, todayMinutes]
  );

  const max = Math.max(30, ...week.map((d) => d.minutes));

  return (
    <>
      {/* 7-bar chart */}
      <div className="flex h-28 items-end justify-between gap-2" role="img"
        aria-label={`Focus minutes per day this week: ${week.map((d) => d.minutes).join(", ")}`}>
        {week.map((d, i) => {
          // v2 Fix 2: EVERY day renders a bar. Zero minutes get a clearly
          // visible neutral stub (≥6px) — never omitted, never near-invisible.
          const hPct = d.minutes > 0 ? Math.max(8, (d.minutes / max) * 100) : 0;
          return (
            <div key={d.date} className="group flex h-full flex-1 flex-col items-center justify-end gap-1.5">
              {/* Minutes on hover/tap target */}
              <span className="pointer-events-none text-[9px] font-medium text-gray-400 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
                {d.minutes > 0 ? `${d.minutes}m` : "0m"}
              </span>
              <div
                tabIndex={0}
                data-weekly-bar={d.date}
                title={`${DAY_LABELS[i]} · ${d.minutes} min focused`}
                style={{ height: d.minutes > 0 ? `${hPct}%` : undefined }}
                className={`w-full max-w-[26px] rounded-t-md transition-all duration-300 outline-none focus-visible:ring-2 focus-visible:ring-habeet-400/60 ${
                  d.minutes === 0 ? "min-h-[6px]" : ""
                } ${
                  d.isFuture
                    ? "bg-white/[0.06]"
                    : d.isToday
                    ? "bg-gradient-to-t from-habeet-700 to-habeet-400 ring-1 ring-habeet-300/60"
                    : d.minutes > 0
                    ? "bg-habeet-600/90 hover:bg-habeet-500"
                    : "bg-white/[0.16] hover:bg-white/25"
                }`}
              />
              <span
                className={`text-[10px] ${
                  d.isToday ? "font-bold text-habeet-300" : "text-gray-500"
                }`}
              >
                {DAY_LABELS[i]}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}
