"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Award,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock,
  FileText,
  Info,
  Loader2,
  Pencil,
  Play,
  RefreshCw,
  Sparkles,
  Trophy,
  Wand2,
  Youtube,
} from "lucide-react";
import {
  Badge,
  effectiveMinutes,
  IntakeContext,
  Roadmap,
  RoadmapDay,
  RoadmapReference,
  sumEffectiveMinutes,
} from "@/lib/types";
import { showToast } from "@/lib/toast";
import { istTodayKey } from "@/lib/date-ist";
import ProgressRing from "@/components/habeet/ProgressRing";
import CircleCheckbox from "@/components/habeet/CircleCheckbox";
import { DayCardSkeleton } from "@/components/Skeleton";
import IntakeFlow from "@/components/IntakeFlow";

interface TopicBoardProps {
  roadmaps: Roadmap[];
  badges: Badge[];
  onGenerate: (topic: string, context?: IntakeContext) => Promise<Roadmap>;
  onStartDay: (roadmapId: string, dayNumber: number) => void;
  onCompleteDay: (roadmapId: string, dayNumber: number) => void;
  onReplanDay: (roadmapId: string, dayNumber: number) => Promise<Roadmap>;
  onEditTaskMinutes: (
    roadmapId: string,
    dayNumber: number,
    taskIndex: number,
    minutes: number | null
  ) => void;
  /** Toggles a single task's done state directly on the roadmap day. */
  onToggleRoadmapTask: (
    roadmapId: string,
    dayNumber: number,
    taskIndex: number
  ) => void;
  /** Study-history jumps force this day open + scroll to it. */
  focusDay?: { roadmapId: string; dayNumber: number } | null;
}

/** Re-plan button lifecycle per "roadmapId:day" key (§4.2). */
type ReplanState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "success" }
  | { phase: "error"; message: string };

/** "135 min" → "~2h 15m" — keeps day rows quiet and scannable. */
export function formatMinutes(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "~0m";
  const h = Math.floor(total / 60);
  const m = Math.round(total % 60);
  return h > 0 ? `~${h}h${m > 0 ? ` ${m}m` : ""}` : `~${m}m`;
}

export default function TopicBoard({
  roadmaps,
  badges,
  onGenerate,
  onStartDay,
  onCompleteDay,
  onReplanDay,
  onEditTaskMinutes,
  onToggleRoadmapTask,
  focusDay,
}: TopicBoardProps) {
  const [topic, setTopic] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlockedBadge, setUnlockedBadge] = useState<Badge | null>(null);
  /** §4.2 per-day re-plan button state — never a silent failure. */
  const [replanStates, setReplanStates] = useState<Record<string, ReplanState>>({});
  const [intakeOpen, setIntakeOpen] = useState(false);
  const prevBadgeCount = useRef(badges.length);


  // Detect newly unlocked badges (from auto-completion) and show modal.
  useEffect(() => {
    if (badges.length > prevBadgeCount.current) {
      const newest = badges[badges.length - 1];
      if (newest) setUnlockedBadge(newest);
    }
    prevBadgeCount.current = badges.length;
  }, [badges]);

  /** Opens the adaptive intake flow instead of generating immediately. */
  const handleGenerateClick = () => {
    const trimmed = topic.trim();
    if (!trimmed) {
      const msg = "Please enter a topic first — what do you want to learn?";
      setError(msg);
      showToast(msg, "error");
      return;
    }
    setError(null);
    setIntakeOpen(true);
  };

  /** Called by the intake flow once it has enough context (or is skipped). */
  const handleIntakeComplete = async (
    finalTopic: string,
    context: IntakeContext
  ) => {
    setLoading(true);
    setError(null);
    try {
      await onGenerate(finalTopic, context);
      setTopic("");
      setIntakeOpen(false);
      showToast("Roadmap ready — let's go! 🚀", "success");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to generate.";
      setError(message);
      showToast(`Roadmap generation failed: ${message}`, "error");
      // Let the user retry from where they were in the conversation.
      setIntakeOpen(true);
    } finally {
      setLoading(false);
    }
  };

  /** §4.2 idle → loading → success (~1.5s) or error + Retry, per day. */
  const handleReplan = async (roadmapId: string, dayNumber: number) => {
    const key = `${roadmapId}:${dayNumber}`;
    setError(null);
    setReplanStates((prev) => ({ ...prev, [key]: { phase: "loading" } }));
    try {
      await onReplanDay(roadmapId, dayNumber);
      setReplanStates((prev) => ({ ...prev, [key]: { phase: "success" } }));
      showToast("Day re-planned successfully.", "success");
      window.setTimeout(() => {
        setReplanStates((prev) =>
          prev[key]?.phase === "success"
            ? { ...prev, [key]: { phase: "idle" } }
            : prev
        );
      }, 1500);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to re-plan.";
      // Inline error + Retry — never a silent failure.
      setReplanStates((prev) => ({
        ...prev,
        [key]: { phase: "error", message },
      }));
      showToast(`Re-plan failed: ${message}`, "error");
    }
  };

  return (
    <section className="rounded-2xl bg-surface p-5 ring-1 ring-white/5">
      {/* Card header */}
      <div className="mb-4 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-habeet-400" />
        <h2 className="text-base font-semibold text-gray-100">
          Roadmap progress
        </h2>
      </div>

      {/* Topic input row */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleGenerateClick()}
          placeholder="What do you want to learn? (e.g. Spring Boot Basics)"
          disabled={loading}
          className="flex-1 rounded-xl border border-white/10 bg-surface-raised px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none transition focus:border-habeet-500 focus:ring-2 focus:ring-habeet-500/30 disabled:opacity-50"
        />
        <button
          onClick={handleGenerateClick}
          disabled={loading}
          aria-label="Plan a new roadmap with AI"
          data-testid="plan-with-ai-btn"
          className="btn-primary px-4 py-2 text-sm"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Generating…
            </>
          ) : (
            <>
              <Wand2 className="h-4 w-4" />
              Plan with AI
            </>
          )}
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300 ring-1 ring-red-500/30"
        >
          <CircleAlert className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          <button
            onClick={handleGenerateClick}
            className="flex shrink-0 items-center gap-1 rounded-lg bg-red-500/20 px-2.5 py-1 text-xs font-semibold text-red-100 outline-none transition hover:bg-red-500/30 active:scale-95"
          >
            <RefreshCw className="h-3 w-3" />
            Try again
          </button>
        </div>
      )}

      {/* Adaptive pre-plan intake (chat-style) */}
      {intakeOpen && (
        <div className="mb-4">
          <IntakeFlow
            topic={topic}
            generating={loading}
            onCancel={() => setIntakeOpen(false)}
            onComplete={handleIntakeComplete}
          />
        </div>
      )}

      {/* Roadmap groups */}
      {loading && roadmaps.length === 0 ? (
        <ul className="space-y-3" aria-busy="true" aria-label="Loading roadmap">
          <DayCardSkeleton />
          <DayCardSkeleton />
          <DayCardSkeleton />
        </ul>
      ) : roadmaps.length === 0 ? (
        <p className="py-6 text-center text-sm text-gray-500">
          No roadmaps yet. Type a topic above to generate your first learning
          path!
        </p>
      ) : (
        <div className="space-y-6">
          {roadmaps.map((roadmap) => (
            <RoadmapGroup
              key={roadmap.id}
              roadmap={roadmap}
              createdAt={roadmap.createdAt}
              forceExpandDay={
                focusDay && focusDay.roadmapId === roadmap.id
                  ? focusDay.dayNumber
                  : null
              }
              replanStates={replanStates}
              onStartDay={onStartDay}
              onCompleteDay={onCompleteDay}
              onReplanDay={handleReplan}
              onEditTaskMinutes={onEditTaskMinutes}
              onToggleTask={onToggleRoadmapTask}
            />
          ))}
        </div>
      )}

      {/* Badge unlock modal */}
      {unlockedBadge && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
          onClick={() => setUnlockedBadge(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Badge unlocked"
        >
          <div
            className="animate-pop-in flex w-full max-w-sm flex-col items-center rounded-2xl bg-surface-raised p-8 text-center shadow-2xl ring-1 ring-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-yellow-400 to-amber-500 text-4xl shadow-lg">
              {unlockedBadge.icon}
            </div>
            <Trophy className="mb-2 h-6 w-6 text-amber-400" />
            <h3 className="text-xl font-bold text-gray-50">Badge unlocked!</h3>
            <p className="mt-2 text-sm text-gray-400">{unlockedBadge.title}</p>
            <button
              onClick={() => setUnlockedBadge(null)}
              className="mt-6 rounded-full bg-habeet-600 px-6 py-2.5 text-sm font-semibold text-white outline-none transition hover:bg-habeet-500 active:scale-95"
            >
              Awesome!
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

interface RoadmapGroupProps {
  roadmap: Roadmap;
  createdAt: number;
  forceExpandDay: number | null;
  replanStates: Record<string, ReplanState>;
  onStartDay: (roadmapId: string, dayNumber: number) => void;
  onCompleteDay: (roadmapId: string, dayNumber: number) => void;
  onReplanDay: (roadmapId: string, dayNumber: number) => void;
  onEditTaskMinutes: (
    roadmapId: string,
    dayNumber: number,
    taskIndex: number,
    minutes: number | null
  ) => void;
  onToggleTask: (
    roadmapId: string,
    dayNumber: number,
    taskIndex: number
  ) => void;
}

/** One topic block: header ring with overall % + a progress row per day. */
function RoadmapGroup({
  roadmap,
  createdAt,
  forceExpandDay,
  replanStates,
  onStartDay,
  onCompleteDay,
  onReplanDay,
  onEditTaskMinutes,
  onToggleTask,
}: RoadmapGroupProps) {
  const totalDays = roadmap.days.length || 1;
  const doneDays = roadmap.days.filter((d) => d.is_completed).length;
  const pct = Math.round((doneDays / totalDays) * 100);
  const isCompleted = roadmap.status === "completed";

  // v2 Fix 7: ONLY the current/next incomplete day starts expanded;
  // every other day stays a collapsed summary row until tapped.
  const activeDayNumber =
    roadmap.days.find((d) => !d.is_completed)?.day_number ?? null;

  // v5 §9: which planned day is TODAY (IST)? Are we on track?
  const plannedKeyOf = (dayNumber: number) => {
    const d = new Date(createdAt);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + (dayNumber - 1));
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  };
  const todayKey = istTodayKey();
  const todayDayNumber =
    roadmap.days.find(
      (d) => !d.is_completed && plannedKeyOf(d.day_number) === todayKey
    )?.day_number ?? null;
  const firstIncomplete = roadmap.days.find((d) => !d.is_completed);
  const behind =
    !!firstIncomplete &&
    plannedKeyOf(firstIncomplete.day_number) < todayKey;

  return (
    <div>
      {/* Topic header */}
      <div className="mb-2 flex items-center gap-3">
        <ProgressRing
          progress={pct / 100}
          size={40}
          label={`${pct}%`}
          title={`${doneDays}/${totalDays} days completed`}
        />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold text-gray-100">
            {roadmap.topic_name}
          </h3>
          <p className="flex items-center gap-1.5 text-[11px] text-gray-500">
            <span>
              {doneDays}/{totalDays} days ·{" "}
              {isCompleted ? "completed 🎉" : "in progress"}
            </span>
            {!isCompleted && (
              <span
                className={`rounded-full px-1.5 py-0.5 font-semibold ring-1 ${
                  behind
                    ? "bg-amber-500/10 text-amber-300 ring-amber-400/30"
                    : "bg-habeet-500/10 text-habeet-200 ring-habeet-400/30"
                }`}
              >
                {behind ? "Behind" : "On track"}
              </span>
            )}
          </p>
        </div>
        {isCompleted ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Done
          </span>
        ) : (
          <span className="hidden shrink-0 items-center gap-1 rounded-full bg-habeet-500/15 px-2.5 py-1 text-[11px] font-semibold text-habeet-200 sm:flex">
            <Award className="h-3.5 w-3.5" />
            {roadmap.badge_reward.icon} {roadmap.badge_reward.title}
          </span>
        )}
      </div>

      {/* Day rows */}
      <ul className="space-y-2">
        {roadmap.days.map((day) => (
          <DayRow
            key={day.day_number}
            roadmapId={roadmap.id}
            day={day}
            createdAt={createdAt}
            isToday={todayDayNumber === day.day_number}
            defaultExpanded={
              forceExpandDay === day.day_number ||
              day.day_number === activeDayNumber
            }
            forceExpanded={forceExpandDay === day.day_number}
            replanState={
              replanStates[`${roadmap.id}:${day.day_number}`] ?? {
                phase: "idle",
              }
            }
            onStartDay={onStartDay}
            onCompleteDay={onCompleteDay}
            onReplanDay={onReplanDay}
            onEditTaskMinutes={onEditTaskMinutes}
            onToggleTask={onToggleTask}
          />
        ))}
      </ul>
    </div>
  );
}

interface DayRowProps {
  roadmapId: string;
  day: RoadmapDay;
  /** v3: roadmap creation time — Day 1 anchor for planned dates. */
  createdAt: number;
  /** v5 §9: this row's planned date == today (IST). */
  isToday?: boolean;
  defaultExpanded: boolean;
  forceExpanded: boolean;
  replanState: ReplanState;
  onStartDay: (roadmapId: string, dayNumber: number) => void;
  onCompleteDay: (roadmapId: string, dayNumber: number) => void;
  onReplanDay: (roadmapId: string, dayNumber: number) => void;
  onEditTaskMinutes: (
    roadmapId: string,
    dayNumber: number,
    taskIndex: number,
    minutes: number | null
  ) => void;
  onToggleTask: (
    roadmapId: string,
    dayNumber: number,
    taskIndex: number
  ) => void;
}

/**
 * One expandable progress row per topic/day:
 * small ring + %, day label, estimated time, chevron. Expanding in place
 * reveals the full day view â€” task checklist with circular checkboxes,
 * "~"-prefixed estimates, Resources (N), and Start / Mark done / Re-plan.
 */
function DayRow({
  roadmapId,
  day,
  createdAt,
  isToday,
  defaultExpanded,
  forceExpanded,
  replanState,
  onStartDay,
  onCompleteDay,
  onReplanDay,
  onEditTaskMinutes,
  onToggleTask,
}: DayRowProps) {
  const [open, setOpen] = useState(defaultExpanded);
  const [minutesEditIdx, setMinutesEditIdx] = useState<number | null>(null);
  const [minutesEditValue, setMinutesEditValue] = useState("");
  const [openTaskReason, setOpenTaskReason] = useState<number | null>(null);

  // Study-history jumps force the target day open (never auto-collapse).
  useEffect(() => {
    if (forceExpanded) setOpen(true);
  }, [forceExpanded]);

  /* Â§4.3 The header total is ALWAYS recomputed from this day's current
     task-level estimates (manual overrides win; AI estimate otherwise).
     sumEffectiveMinutes falls back per-task, so a populated day can never
     display "Estimated: ~0 min". */
  const totalEstimate = useMemo(
    () => sumEffectiveMinutes(day.tasks),
    [day.tasks]
  );
  const doneTasks = day.tasks.filter((t) => t.is_done).length;
  const pct = day.tasks.length ? doneTasks / day.tasks.length : 0;

  // v3: Day N lands on creation-date + (N-1) days — real calendar dates.
  const plannedDate = useMemo(() => {
    const d = new Date(createdAt);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + (day.day_number - 1));
    return d;
  }, [createdAt, day.day_number]);
  const todayMid = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t.getTime();
  }, []);
  /** Deadline passed & incomplete → missed; no late dashboard credit. */
  const isMissed = !day.is_completed && plannedDate.getTime() < todayMid;
  const dateLabel = plannedDate.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

  const startMinutesEdit = (idx: number) => {
    const task = day.tasks[idx];
    setMinutesEditIdx(idx);
    setMinutesEditValue(
      String(effectiveMinutes(task.estimated_minutes, task.manual_minutes))
    );
  };

  const saveMinutesEdit = (idx: number) => {
    const parsed = parseInt(minutesEditValue, 10);
    onEditTaskMinutes(
      roadmapId,
      day.day_number,
      idx,
      Number.isFinite(parsed) && parsed > 0 ? parsed : null
    );
    setMinutesEditIdx(null);
  };

  return (
    <li
      data-day={day.day_number}
      className="rounded-xl bg-surface-raised ring-1 ring-white/5 transition hover:ring-white/10"
    >
      {/* Collapsed row header */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-habeet-400/60"
      >
        <ProgressRing
          progress={pct}
          size={40}
          label={`${Math.round(pct * 100)}%`}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-gray-100">
            Day {day.day_number}: {day.day_title}
          </span>
          <span data-day-date className="mt-0.5 block text-[11px] tabular-nums text-gray-500">
            {dateLabel} · {formatMinutes(totalEstimate)} Â· {doneTasks}/{day.tasks.length}{" "}
            tasks
          </span>
        </span>
        {day.is_completed && (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
        )}
        {isToday && !day.is_completed && (
          <span
            data-testid="today-badge"
            className="shrink-0 rounded-full bg-habeet-500/15 px-2 py-0.5 text-[10px] font-semibold text-habeet-200 ring-1 ring-habeet-400/40"
          >
            Today
          </span>
        )}
        {isMissed && (
          <span
            data-missed-badge
            title="Deadline passed — this day can no longer be checked in"
            className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300 ring-1 ring-amber-400/30"
          >
            Missed
          </span>
        )}
        <ChevronRight
          className={`h-4 w-4 shrink-0 text-gray-500 transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
      </button>

      {/* Expanded day view â€” expands in place, no navigation */}
      {open && (
        <div className="border-t border-white/5 px-3 pb-3 pt-2">
          {/* Day reason */}
          {day.reason && (
            <p className="mb-2 flex items-start gap-1.5 rounded-lg bg-habeet-500/10 px-2 py-1.5 text-[11px] leading-snug text-habeet-200">
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              {day.reason}
            </p>
          )}

          {/* Task checklist */}
          <ul className="mb-3 space-y-1">
            {day.tasks.map((task, idx) => {
              const effective = effectiveMinutes(
                task.estimated_minutes,
                task.manual_minutes
              );
              const isEditingMinutes = minutesEditIdx === idx;
              return (
                <li key={idx}>
                  <div className="group flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 transition hover:bg-white/5">
                    <CircleCheckbox
                      checked={!!task.is_done}
                      onChange={() =>
                        onToggleTask(roadmapId, day.day_number, idx)
                      }
                      label={`Mark "${task.name}" ${
                        task.is_done ? "not done" : "done"
                      }`}
                      size={18}
                      disabled={isMissed}
                      data-testid={`roadmap-checkbox-${idx}`}
                    />
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ring-1 ${
                        task.priority === "High"
                          ? "bg-orange-400 ring-orange-300/40"
                          : task.priority === "Medium"
                          ? "bg-sky-400 ring-sky-300/40"
                          : "bg-emerald-400 ring-emerald-300/40"
                      }`}
                      aria-label={`${task.priority} priority`}
                    />
                    <span
                      className={`min-w-0 flex-1 truncate text-[13px] ${
                        task.is_done
                          ? "text-gray-500 line-through"
                          : "text-gray-200"
                      }`}
                    >
                      {task.name}
                    </span>
                    {task.reason && (
                      <button
                        onClick={() =>
                          setOpenTaskReason((v) => (v === idx ? null : idx))
                        }
                        aria-label={`Why is "${task.name}" estimated at ${effective} minutes?`}
                        className={`rounded p-0.5 transition ${
                          openTaskReason === idx
                            ? "text-habeet-300"
                            : "text-gray-500 opacity-0 hover:text-gray-300 focus-visible:opacity-100 group-hover:opacity-100"
                        }`}
                      >
                        <Info className="h-3 w-3" />
                      </button>
                    )}
                    {isEditingMinutes ? (
                      <div className="flex items-center gap-1 rounded-lg border border-habeet-500 bg-surface-overlay px-1.5 py-0.5">
                        <input
                          type="number"
                          min={1}
                          value={minutesEditValue}
                          onChange={(e) => setMinutesEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveMinutesEdit(idx);
                            if (e.key === "Escape") setMinutesEditIdx(null);
                          }}
                          autoFocus
                          className="w-11 bg-transparent text-center text-[11px] text-gray-100 outline-none"
                        />
                        <span className="text-[10px] text-gray-500">min</span>
                        <button
                          onClick={() => saveMinutesEdit(idx)}
                          aria-label="Save minutes"
                          className="rounded p-0.5 text-gray-400 hover:bg-white/5 hover:text-gray-100"
                        >
                          <Check className="h-3 w-3" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => startMinutesEdit(idx)}
                        title="Edit estimated time"
                        aria-label={`Edit estimated time for ${task.name}`}
                        className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums outline-none transition focus-visible:ring-2 focus-visible:ring-habeet-400/60 ${
                          task.manual_minutes != null
                            ? "bg-habeet-500/20 text-habeet-200 hover:bg-habeet-500/30"
                            : "text-gray-500 hover:bg-white/5 hover:text-gray-300"
                        }`}
                      >
                        <Clock className="h-3 w-3" />~{effective}m
                        <Pencil className="h-2.5 w-2.5 opacity-60" />
                      </button>
                    )}
                  </div>
                  {/* Per-task AI reasoning */}
                  {openTaskReason === idx && task.reason && (
                    <p className="ml-8 rounded-lg bg-habeet-500/10 px-2 py-1.5 text-[11px] leading-snug text-habeet-200">
                      {task.reason}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>

          {/* Collapsed-by-default curated references (Â§5.1) */}
          {day.references && day.references.length > 0 && (
            <ReferencesList refs={day.references} />
          )}
{/* Phase E: per-day suggested search — one tap becomes a YouTube
              search link for the day's exact focus. No API needed. */}
          {day.search && (
            <a
              href={`https://www.youtube.com/results?search_query=${encodeURIComponent(
                day.search
              )}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Search YouTube for: ${day.search}`}
              className="mb-3 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px] font-semibold text-gray-500 outline-none transition hover:text-habeet-300 focus-visible:ring-2 focus-visible:ring-habeet-400/60"
            >
              <Youtube className="h-3.5 w-3.5 shrink-0" />
              Watch: {day.search}
            </a>
          )}

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2">
            {isToday && !day.is_completed && (
              <button
                onClick={() => onCompleteDay(roadmapId, day.day_number)}
                data-testid="checkin-today"
                title="Check in: mark all of today's tasks done"
                className="btn-primary px-3 py-1.5 text-xs"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Check In
              </button>
            )}
            {!day.is_completed && (
              <>
                <button
                  onClick={() => onStartDay(roadmapId, day.day_number)}
                  disabled={isMissed || replanState.phase === "loading"}
                  title={isMissed ? "Deadline passed — day marked as missed" : undefined}
                  className="btn-primary px-3 py-1.5 text-xs"
                >
                  <Play className="h-3.5 w-3.5" />
                  Start day {day.day_number}
                </button>
                <button
                  onClick={() => onCompleteDay(roadmapId, day.day_number)}
                  disabled={replanState.phase === "loading"}
                  className="btn-secondary px-3 py-1.5 text-xs"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Mark done
                </button>
              </>
            )}
            {day.is_completed && (
              <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                <CheckCircle2 className="h-4 w-4" /> Completed
              </span>
            )}
            <ReplanButton
              state={replanState}
              onClick={() => onReplanDay(roadmapId, day.day_number)}
            />
          </div>

          {/* Â§4.2 inline error + Retry â€” re-plans never fail silently */}
          {replanState.phase === "error" && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-red-500/10 px-2.5 py-2 text-xs text-red-300 ring-1 ring-red-500/30">
              <CircleAlert className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{replanState.message}</span>
              <button
                onClick={() => onReplanDay(roadmapId, day.day_number)}
                className="flex items-center gap-1 rounded-lg bg-red-500/20 px-2.5 py-1 font-semibold text-red-200 outline-none transition hover:bg-red-500/30 active:scale-95"
              >
                <RefreshCw className="h-3 w-3" />
                Retry
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** Â§4.2 Re-plan with AI â€” idle â†’ loading (spinner, disabled) â†’ success
 *  ("Plan updated", auto-reverts ~1.5s) or inline error + Retry below. */
function ReplanButton({
  state,
  onClick,
}: {
  state: ReplanState;
  onClick: () => void;
}) {
  const loading = state.phase === "loading";
  return (
    <button
      onClick={onClick}
      disabled={loading}
      aria-live="polite"
      className={`btn-secondary ml-auto px-3 py-1.5 text-xs ${
        state.phase === "success" ? "!text-habeet-200" : ""
      }}`}
    >
      {state.phase === "success" ? (
        <>
          <Check className="h-3.5 w-3.5" />
          Plan updated
        </>
      ) : loading ? (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Re-planningâ€¦
        </>
      ) : (
        <>
          <RefreshCw className="h-3.5 w-3.5" />
          Re-plan with AI
        </>
      )}
    </button>
  );
}

/** Â§5.1 Collapsed-by-default curated references for one roadmap day. */
function ReferencesList({ refs }: { refs: RoadmapReference[] }) {
  const [open, setOpen] = useState(false);

  const iconFor = (t: RoadmapReference["type"]) =>
    t === "video" ? (
      <Youtube className="h-3.5 w-3.5 shrink-0 text-habeet-300" />
    ) : t === "article" ? (
      <FileText className="h-3.5 w-3.5 shrink-0 text-sky-400" />
    ) : (
      <BookOpen className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
    );

  return (
    <div className="mb-3">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] font-semibold text-gray-500 outline-none transition hover:text-habeet-300 focus-visible:ring-2 focus-visible:ring-habeet-400/60"
      >
        Resources ({refs.length})
        <ChevronDown
          className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <ul className="mt-1 space-y-1 border-l-2 border-white/10 pl-3">
          {refs.map((r) => (
            <li key={r.url}>
              <a
                href={r.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex items-start gap-1.5 rounded px-1 py-0.5 text-[11px] leading-snug text-gray-400 outline-none transition hover:text-habeet-300 focus-visible:ring-2 focus-visible:ring-habeet-400/60"
              >
                {iconFor(r.type)}
                <span className="min-w-0">
                  <span className="font-medium underline-offset-2 group-hover:underline">
                    {r.title}
                  </span>
                  {r.type === "video" && r.channel && (
                    <span className="text-gray-600"> Â· {r.channel}</span>
                  )}
                  <span className="ml-1 text-[10px] uppercase tracking-wide text-gray-600">
                    {r.type === "docs" ? "docs" : r.type}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

