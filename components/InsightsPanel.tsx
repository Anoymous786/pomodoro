/**
 * components/InsightsPanel.tsx — Phase 5 personal insights.
 *
 * Pure client-side aggregation over data the app ALREADY persists (the
 * `history` DayStats map + `roadmaps`). No LLM call and no backend request:
 * these three insights are computed with lib/insights.ts on each render of
 * the History modal, so they cost nothing and work offline.
 */
import { useMemo } from "react";
import {
  CalendarClock,
  TrendingDown,
  TrendingUp,
  Minus,
  Gauge,
  Lightbulb,
} from "lucide-react";
import type { DayStats, Roadmap } from "@/lib/types";
import {
  bestFocusDay,
  focusWeeklyTrend,
  roadmapPace,
} from "@/lib/insights";

interface InsightsPanelProps {
  history: Record<string, DayStats>;
  roadmaps: Roadmap[];
}

function Card({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl bg-surface p-3 ring-1 ring-white/5">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="text-habeet-600 dark:text-habeet-400">{icon}</span>
        <h4 className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {title}
        </h4>
      </div>
      <div className="text-sm text-gray-700 dark:text-gray-200">{children}</div>
    </div>
  );
}

export default function InsightsPanel({ history, roadmaps }: InsightsPanelProps) {
  const best = useMemo(() => bestFocusDay(history), [history]);
  const trend = useMemo(() => focusWeeklyTrend(history), [history]);
  const pace = useMemo(() => roadmapPace(roadmaps), [roadmaps]);

  const hasAnyData =
    Object.keys(history).length > 0 || roadmaps.length > 0;

  if (!hasAnyData || (!best && !trend && !pace)) {
    return (
      <div className="mb-4 flex items-start gap-2 rounded-xl border border-dashed border-gray-200 bg-white/60 p-3 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-400">
        <Lightbulb className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          Insights appear once you complete a session or start a roadmap —
          they&apos;re computed locally from your own activity.
        </p>
      </div>
    );
  }

  const trendIcon =
    trend?.direction === "improving" ? (
      <TrendingUp className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
    ) : trend?.direction === "declining" ? (
      <TrendingDown className="h-4 w-4 text-orange-600 dark:text-orange-400" />
    ) : (
      <Minus className="h-4 w-4 text-gray-500 dark:text-gray-400" />
    );

  return (
    <section aria-label="Personal insights" className="mb-5">
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold text-gray-900 dark:text-gray-100">
        <Lightbulb className="h-4 w-4 text-habeet-600" />
        Insights
        <span className="ml-auto text-[10px] font-medium uppercase tracking-wide text-gray-400">
          computed on-device
        </span>
      </h3>

      <div className="grid gap-2 sm:grid-cols-3">
        {best && (
          <Card icon={<CalendarClock className="h-4 w-4" />} title="Best focus day">
            <p>
              <span className="font-semibold">{best.weekday}</span> — you finish{" "}
              <span className="font-semibold">{best.completionPct}%</span> of
              tasks ({best.avgFocusMinutes} min avg focus across{" "}
              {best.activeDays} active {best.activeDays === 1 ? "day" : "days"}).
            </p>
          </Card>
        )}

        {trend && (
          <Card icon={trendIcon} title="Weekly focus trend">
            <p>
              <span className="font-semibold capitalize">
                {trend.direction}
              </span>{" "}
              · {trend.thisWeekMinutes} min this week vs{" "}
              {trend.lastWeekMinutes} min last week (
              {trend.deltaPct > 0 ? "+" : ""}
              {trend.deltaPct}%).
            </p>
          </Card>
        )}

        {pace && (
          <Card icon={<Gauge className="h-4 w-4" />} title="Roadmap pace">
            <p>{pace.label}</p>
          </Card>
        )}
      </div>
    </section>
  );
}