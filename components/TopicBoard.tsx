"use client";

import { useEffect, useRef, useState } from "react";
import {
  Award,
  CheckCircle2,
  Clock,
  Loader2,
  Pencil,
  Play,
  RefreshCw,
  Sparkles,
  Trophy,
  Wand2,
  X,
} from "lucide-react";
import {
  Badge,
  effectiveMinutes,
  IntakeContext,
  Roadmap,
  RoadmapDay,
} from "@/lib/types";
import { showToast } from "@/lib/toast";
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
}

/**
 * LLM-powered roadmap generator board.
 * User types a topic -> adaptive AI intake asks a few tailored questions
 * (skippable) -> LLM generates a personalized roadmap -> user works
 * through days via the Pomodoro timer -> badge unlocks on completion.
 *
 * Each day card shows:
 *   - "Estimated: X min | Your time today: Y min"
 *     (Y = sum of effective minutes; defaults to AI estimate when untouched)
 *   - An orange flag when estimated > available (effective) time.
 *   - Per-task inline minute editing.
 *   - A "Re-plan with AI" button that calls /api/replan-day.
 */
export default function TopicBoard({
  roadmaps,
  badges,
  onGenerate,
  onStartDay,
  onCompleteDay,
  onReplanDay,
  onEditTaskMinutes,
}: TopicBoardProps) {
  const [topic, setTopic] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlockedBadge, setUnlockedBadge] = useState<Badge | null>(null);
  const [replanningKey, setReplanningKey] = useState<string | null>(null);
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

  const handleReplan = async (roadmapId: string, dayNumber: number) => {
    const key = `${roadmapId}:${dayNumber}`;
    setReplanningKey(key);
    setError(null);
    try {
      await onReplanDay(roadmapId, dayNumber);
      showToast("Day re-planned successfully.", "success");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to re-plan.";
      setError(message);
      showToast(`Re-plan failed: ${message}`, "error");
    } finally {
      setReplanningKey(null);
    }
  };

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div className="mb-4 flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-tomato-600" />
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">
          {"AI Roadmap Generator"}
        </h2>
      </div>

      {/* Input bar */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleGenerateClick()}
          placeholder="What do you want to learn? (e.g. Spring Boot Basics)"
          disabled={loading}
          className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-tomato-500 focus:ring-2 focus:ring-tomato-500/30 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        />
        <button
          onClick={handleGenerateClick}
          disabled={loading}
          className="flex items-center justify-center gap-2 rounded-lg bg-tomato-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-tomato-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Generating...
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
        <p
          role="alert"
          className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/30 dark:text-red-300"
        >
          {error}
        </p>
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

      {/* Roadmap cards */}
      {roadmaps.length === 0 ? (
        <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
          No roadmaps yet. Type a topic above to generate your first learning
          path!
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {roadmaps.map((roadmap) => (
            <RoadmapCard
              key={roadmap.id}
              roadmap={roadmap}
              replanningKey={replanningKey}
              onStartDay={onStartDay}
              onCompleteDay={onCompleteDay}
              onReplanDay={handleReplan}
              onEditTaskMinutes={onEditTaskMinutes}
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
            className="animate-pop-in flex w-full max-w-sm flex-col items-center rounded-2xl bg-white p-8 text-center shadow-2xl dark:bg-gray-800"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-yellow-400 to-amber-500 text-4xl shadow-lg">
              {unlockedBadge.icon}
            </div>
            <Trophy className="mb-2 h-6 w-6 text-yellow-500" />
            <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100">
              {"Badge Unlocked!"}
            </h3>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
              {unlockedBadge.title}
            </p>
            <button
              onClick={() => setUnlockedBadge(null)}
              className="mt-6 rounded-full bg-tomato-600 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-tomato-700 active:scale-95"
            >
              Awesome!
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

interface RoadmapCardProps {
  roadmap: Roadmap;
  replanningKey: string | null;
  onStartDay: (roadmapId: string, dayNumber: number) => void;
  onCompleteDay: (roadmapId: string, dayNumber: number) => void;
  onReplanDay: (roadmapId: string, dayNumber: number) => void;
  onEditTaskMinutes: (
    roadmapId: string,
    dayNumber: number,
    taskIndex: number,
    minutes: number | null
  ) => void;
}

function RoadmapCard({
  roadmap,
  replanningKey,
  onStartDay,
  onCompleteDay,
  onReplanDay,
  onEditTaskMinutes,
}: RoadmapCardProps) {
  const completedDays = roadmap.days.filter((d) => d.is_completed).length;
  const totalDays = roadmap.days.length;
  const isCompleted = roadmap.status === "completed";

  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900">
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h3 className="font-bold text-gray-900 dark:text-gray-100">
            {roadmap.topic_name}
          </h3>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {completedDays}/{totalDays} days completed
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {isCompleted ? (
            <span className="flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Completed
            </span>
          ) : (
            <span className="flex items-center gap-1 rounded-full bg-tomato-100 px-2.5 py-1 text-xs font-semibold text-tomato-700 dark:bg-tomato-900/40 dark:text-tomato-300">
              <Award className="h-3.5 w-3.5" />
              {roadmap.badge_reward.icon} {roadmap.badge_reward.title}
            </span>
          )}
        </div>
      </div>

      {/* Days */}
      <ul className="space-y-2">
        {roadmap.days.map((day) => (
          <DayRow
            key={day.day_number}
            roadmapId={roadmap.id}
            day={day}
            replanning={replanningKey === `${roadmap.id}:${day.day_number}`}
            onStartDay={onStartDay}
            onCompleteDay={onCompleteDay}
            onReplanDay={onReplanDay}
            onEditTaskMinutes={onEditTaskMinutes}
          />
        ))}
      </ul>
    </div>
  );
}

interface DayRowProps {
  roadmapId: string;
  day: RoadmapDay;
  replanning: boolean;
  onStartDay: (roadmapId: string, dayNumber: number) => void;
  onCompleteDay: (roadmapId: string, dayNumber: number) => void;
  onReplanDay: (roadmapId: string, dayNumber: number) => void;
  onEditTaskMinutes: (
    roadmapId: string,
    dayNumber: number,
    taskIndex: number,
    minutes: number | null
  ) => void;
}

function DayRow({
  roadmapId,
  day,
  replanning,
  onStartDay,
  onCompleteDay,
  onReplanDay,
  onEditTaskMinutes,
}: DayRowProps) {
  const [minutesEditIdx, setMinutesEditIdx] = useState<number | null>(null);
  const [minutesEditValue, setMinutesEditValue] = useState("");

  const estimated = day.tasks.reduce(
    (sum, t) => sum + (t.estimated_minutes || 0),
    0
  );
  const available = day.tasks.reduce(
    (sum, t) => sum + effectiveMinutes(t.estimated_minutes, t.manual_minutes),
    0
  );
  const overBudget = estimated > available;

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
      className={`rounded-lg border p-3 ${
        day.is_completed
          ? "border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-900/20"
          : "border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800"
      }`}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Day {day.day_number}: {day.day_title}
        </span>
        {day.is_completed && (
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        )}
      </div>

      {/* Day-level time summary */}
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span
          className={
            overBudget
              ? "font-semibold text-orange-600 dark:text-orange-400"
              : "text-gray-500 dark:text-gray-400"
          }
        >
          Estimated: {estimated} min
        </span>
        <span className="text-gray-400 dark:text-gray-500">|</span>
        <span className="text-gray-500 dark:text-gray-400">
          Your time today: {available} min
        </span>
        {overBudget && (
          <span className="font-semibold text-orange-600 dark:text-orange-400">
            ⚠ Over budget
          </span>
        )}
      </div>

      {/* Task list with time editing */}
      <ul className="mb-2 space-y-1">
        {day.tasks.map((task, idx) => {
          const effective = effectiveMinutes(
            task.estimated_minutes,
            task.manual_minutes
          );
          const isEditingMinutes = minutesEditIdx === idx;
          return (
            <li
              key={idx}
              className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300"
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  task.priority === "High"
                    ? "bg-red-500"
                    : task.priority === "Medium"
                    ? "bg-yellow-500"
                    : "bg-green-500"
                }`}
              />
              <span className="flex-1 truncate">{task.name}</span>

              {isEditingMinutes ? (
                <span className="flex items-center gap-1 rounded border border-tomato-500 bg-white px-1 py-0.5 dark:bg-gray-800">
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
                    aria-label="Edit task minutes"
                    className="w-10 bg-transparent text-center outline-none dark:text-gray-100"
                  />
                  <span className="text-gray-400">min</span>
                  <button
                    onClick={() => saveMinutesEdit(idx)}
                    aria-label="Save minutes"
                    className="rounded p-0.5 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
                  >
                    <CheckCircle2 className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => setMinutesEditIdx(null)}
                    aria-label="Cancel minutes edit"
                    className="rounded p-0.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => startMinutesEdit(idx)}
                  title="Edit estimated time"
                  aria-label={`Edit estimated time for ${task.name}`}
                  className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium transition ${
                    task.manual_minutes != null
                      ? "bg-sky-100 text-sky-700 hover:bg-sky-200 dark:bg-sky-900/40 dark:text-sky-300"
                      : "bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-400"
                  }`}
                >
                  <Clock className="h-3 w-3" />
                  {effective} min
                  <Pencil className="h-2.5 w-2.5 opacity-60" />
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap gap-2">
        {!day.is_completed && (
          <button
            onClick={() => onStartDay(roadmapId, day.day_number)}
            className="flex items-center gap-1 rounded-lg bg-tomato-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-tomato-700 active:scale-95"
          >
            <Play className="h-3 w-3" />
            Start Day {day.day_number}
          </button>
        )}
        {!day.is_completed && (
          <button
            onClick={() => onCompleteDay(roadmapId, day.day_number)}
            className="flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 transition hover:bg-gray-50 active:scale-95 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <CheckCircle2 className="h-3 w-3" />
            Mark Done
          </button>
        )}
        {!day.is_completed && (
          <button
            onClick={() => onReplanDay(roadmapId, day.day_number)}
            disabled={replanning}
            className="flex items-center gap-1 rounded-lg border border-tomato-300 bg-tomato-50 px-3 py-1.5 text-xs font-semibold text-tomato-700 transition hover:bg-tomato-100 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 dark:border-tomato-700 dark:bg-tomato-900/30 dark:text-tomato-300"
          >
            {replanning ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            {replanning ? "Re-planning..." : "Re-plan with AI"}
          </button>
        )}
      </div>
    </li>
  );
}