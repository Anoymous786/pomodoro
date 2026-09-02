"use client";

import { useMemo, useRef, useState } from "react";
import {
  HeatmapDay,
  buildActivityHeatmap,
  focusIntensity,
} from "@/lib/activity";
import type { DayStats } from "@/lib/types";
import { HeatmapSkeleton } from "@/components/Skeleton";

interface ActivityHeatmapProps {
  history: Record<string, DayStats>;
  todayStats?: DayStats;
  /** True while persisted state is still hydrating (shows a skeleton). */
  loading?: boolean;
}

const WEEKDAY_LABELS = ["Sun", "", "Tue", "", "Thu", "", "Sat"];
const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** §4.1/v2 Fix 3 — five VISIBLY distinct shades (tailwind `heat` tokens).
 *  Level 0 is neutral gray; 1-4 step clearly through purple. The legend uses
 *  this exact map so grid and legend can never diverge. */
const LEVEL_BG: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: "bg-heat-0",
  1: "bg-heat-1",
  2: "bg-heat-2",
  3: "bg-heat-3",
  4: "bg-heat-4",
};

/** Formats "2026-08-26" as a friendly weekday label for tooltips. */
function friendlyDate(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateKey;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * GitHub-style contribution heatmap of the last ~12 weeks of Pomodoro
 * activity, in the Habeet purple scale (§4.1):
 *  - every cell ALWAYS renders a color (zero → level-0 shade);
 *  - hover/tap shows a real tooltip: date · minutes focused · sessions;
 *  - data comes from the same persisted `history` DayStats map that powers
 *    Study history and the day-completion rings.
 */
export default function ActivityHeatmap({
  history,
  todayStats,
  loading = false,
}: ActivityHeatmapProps) {
  const { columns, today } = useMemo(
    () => buildActivityHeatmap(history, undefined, 12, todayStats),
    [history, todayStats]
  );
  // Hover/tap tooltip state: which cell + its pixel offset inside this card.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{
    x: number;
    y: number;
    day: HeatmapDay;
  } | null>(null);

  const maxMinutes = useMemo(() => {
    let max = 0;
    for (const col of columns)
      for (const d of col) if (d.focusMinutes > max) max = d.focusMinutes;
    return max;
  }, [columns]);

  // Month labels: place at the first column whose days cross into a new month.
  const monthMarkerForCol = (col: HeatmapDay[]): string | null => {
    const m = parseInt(col[0]?.date?.slice(5, 7) ?? "0", 10);
    return m >= 1 && m <= 12 ? MONTH_LABELS[m - 1] : null;
  };

  return (
    <div className="relative" ref={wrapRef}>
      {loading ? (
        <HeatmapSkeleton />
      ) : (
        <>
          {/* Month markers */}
          <div className="mb-1 flex gap-[3px] pl-7 text-[10px] text-gray-500">
            {columns.map((col, ci) => (
              <span key={ci} className="w-3 shrink-0">
                {monthMarkerForCol(col) ?? ""}
              </span>
            ))}
          </div>

          <div className="flex gap-[3px]">
            {/* Weekday labels */}
            <div className="mr-1 flex flex-col gap-[3px] text-[9px] leading-4 text-gray-500">
              {WEEKDAY_LABELS.map((l, i) => (
                <span key={i} className="h-3 w-6">
                  {l}
                </span>
              ))}
            </div>

            {/* Grid — cells always colored */}
            <div className="flex gap-[3px]" onMouseLeave={() => setTip(null)}>
              {columns.map((col, ci) => (
                <div key={ci} className="flex flex-col gap-[3px]">
                  {col.map((d, ri) => {
                    const minutes = Number(d?.focusMinutes ?? 0);
                    const sessions = Number(d?.sessions ?? 0);
                    const level = focusIntensity(minutes, maxMinutes);
                    const anchor = (el: HTMLElement): { x: number; y: number; day: HeatmapDay } | null => {
                      if (!wrapRef.current) return null;
                      const r = el.getBoundingClientRect();
                      const host = wrapRef.current.getBoundingClientRect();
                      return {
                        x: r.left - host.left + r.width / 2,
                        y: r.top - host.top,
                        day: d,
                      };
                    };
                    return (
                      <button
                        key={d.date}
                        type="button"
                        data-heatmap-cell={d.date}
                        aria-label={`${friendlyDate(d.date)}: ${minutes} min focused, ${sessions} session${sessions === 1 ? "" : "s"}`}
                        onMouseEnter={(e) => setTip(anchor(e.currentTarget))}
                        onFocus={(e) => setTip(anchor(e.currentTarget))}
                        onClick={(e) =>
                          setTip((prev) =>
                            prev?.day.date === d.date ? null : anchor(e.currentTarget)
                          )
                        }
                        className={`h-[11px] w-[11px] sm:h-3.5 sm:w-3.5 rounded-[3px] outline-none transition-transform focus-visible:!ring-2 focus-visible:!ring-habeet-400 hover:scale-110 ${
                          LEVEL_BG[level]
                        } ${
                          // v2 Fix 3: today = clear PURPLE border, not a stray
                          // white outline. Legend + grid share the same shades.
                          d.date === today
                            ? "!ring-2 !ring-habeet-400 !ring-offset-0"
                            : ""
                        }`}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          {/* Tooltip — anchored above the hovered cell */}
          {tip && (
            <div
              className="pointer-events-none absolute z-20 w-max rounded-lg bg-surface-overlay px-3 py-2 text-xs shadow-xl ring-1 ring-white/10"
              style={{
                left: tip.x,
                top: tip.y - 6,
                transform: "translate(-50%, -100%)",
              }}
              role="status"
            >
              <p className="font-semibold text-gray-100">
                {friendlyDate(tip.day.date)}
                {tip.day.date === today && (
                  <span className="ml-1.5 text-[10px] font-medium uppercase tracking-wide text-habeet-300">
                    today
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-gray-400 tabular-nums">
                {tip.day.focusMinutes} min focused
              </p>
              <p className="text-gray-400 tabular-nums">
                {tip.day.sessions} session{tip.day.sessions === 1 ? "" : "s"} ·{" "}
                {tip.day.tasksCompleted} task
                {tip.day.tasksCompleted === 1 ? "" : "s"}
              </p>
            </div>
          )}

          {/* Less → More legend */}
          <div className="mt-3 flex items-center justify-end gap-1.5 text-[10px] text-gray-500">
            <span>Less</span>
            {([0, 1, 2, 3, 4] as const).map((lvl) => (
              <span key={lvl} className={`h-3 w-3 rounded-[3px] ${LEVEL_BG[lvl]}`} />
            ))}
            <span>More</span>
          </div>
        </>
      )}
    </div>
  );
}
