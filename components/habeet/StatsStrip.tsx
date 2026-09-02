"use client";

import { Clock, Flame, Map, Target } from "lucide-react";
import Link from "next/link";

interface Props {
  counts: {
    total: number;
    active: number;
    completed: number;
    overdue: number;
  };
  activeRoadmaps: number;
  streak: number;
  practiceDays: number;
  /** Total practiced time across all roadmap step timers (seconds). */
  totalPracticeSeconds: number;
  /** §10: called when a stat card is clicked (dashboard scrolls/navigates). */
  onNavigate: (target: string) => void;
  todayPracticeMinutes: number;
}

/**
 * One interactive stat tile. §10: cards navigate to a relevant filtered
 * section instead of being purely decorative.
 */
function Tile({
  value,
  label,
  testid,
  tone = "neutral",
  href,
  onClick,
}: {
  value: React.ReactNode;
  label: string;
  testid?: string;
  tone?: "neutral" | "purple" | "amber";
  href?: string;
  onClick?: () => void;
}) {
  const tones = {
    neutral: "text-gray-100",
    purple: "text-habeet-200",
    amber: "text-amber-300",
  } as const;
  const cls = `flex min-w-0 flex-col rounded-xl bg-surface-raised px-3 py-2.5 ring-1 ring-white/5 transition hover:bg-surface-overlay hover:ring-habeet-500/30 ${href || onClick ? "cursor-pointer" : ""}`;
  const inner = (
    <>
      <span
        className={`truncate text-lg font-bold leading-tight tabular-nums ${tones[tone]}`}
      >
        {value}
      </span>
      <span className="mt-0.5 truncate text-[11px] text-gray-500">{label}</span>
    </>
  );
  if (href) {
    return (
      <Link href={href} data-testid={testid} className={cls}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" data-testid={testid} onClick={onClick} className={`${cls} text-left`}>
      {inner}
    </button>
  );
}

/**
 * v5 §10 — overall practice dashboard strip: answers "how consistently am
 * I practicing?" at a glance. Sits directly under the greeting.
 */
export default function StatsStrip({
  counts,
  activeRoadmaps,
  streak,
  practiceDays,
  totalPracticeSeconds,
  todayPracticeMinutes,
  onNavigate,
}: Props) {
  // Compact "Hh Mm" / "Mm" formatting from seconds.
  const fmtSeconds = (s: number) => {
    const sec = Math.max(0, Math.floor(s));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
    if (m > 0) return `${m}m`;
    return sec > 0 ? `${sec}s` : "0m";
  };
  return (
    <section
      aria-label="Overall practice stats"
      data-testid="stats-strip"
      className="rounded-2xl bg-surface p-4 ring-1 ring-white/5"
    >
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
        <Tile value={counts.total} label="Total tasks" testid="stats-total" onClick={() => onNavigate("tasks")} />
        <Tile
          value={counts.active}
          label="Active tasks"
          testid="stats-active"
          tone="purple"
          onClick={() => onNavigate("active")}
        />
        <Tile
          value={counts.completed}
          label="Completed"
          testid="stats-completed"
          onClick={() => onNavigate("completed")}
        />
        <Tile
          value={counts.overdue}
          label="Overdue"
          testid="stats-overdue"
          tone={counts.overdue > 0 ? "amber" : "neutral"}
          onClick={() => onNavigate("overdue")}
        />
        <Tile
          value={
            <span className="inline-flex items-center gap-1">
              <Map className="h-3.5 w-3.5" />
              {activeRoadmaps}
            </span>
          }
          label="Active roadmaps"
          testid="stats-roadmaps"
          onClick={() => onNavigate("roadmaps")}
        />
        <Tile
          value={
            <span
              data-testid="stats-practice-time"
              className="inline-flex items-center gap-1"
            >
              <Clock className="h-3.5 w-3.5" />
              {fmtSeconds(totalPracticeSeconds)}
            </span>
          }
          label="Practice time"
          testid="stats-total-practice"
          tone="purple"
          onClick={() => onNavigate("activity")}
        />
        <Tile
          value={
            <span className="inline-flex items-center gap-1">
              <Flame className="h-3.5 w-3.5" />
              {streak}
            </span>
          }
          label="Day streak"
          testid="stats-streak"
          onClick={() => onNavigate("activity")}
        />
        <Tile
          value={
            <span className="inline-flex items-center gap-1">
              <Target className="h-3.5 w-3.5" />
              {practiceDays}
            </span>
          }
          label="Practice days"
          testid="stats-practice-days"
          tone="purple"
          onClick={() => onNavigate("activity")}
        />
        <Tile
          value={`${todayPracticeMinutes}m`}
          label="Today's practice"
          testid="stats-today-practice"
          tone="purple"
          onClick={() => onNavigate("activity")}
        />
      </div>
    </section>
  );
}
