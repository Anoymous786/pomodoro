"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { History, Plus, Rocket } from "lucide-react";
import { usePomodoro } from "@/hooks/usePomodoro";
import Timer from "@/components/Timer";
import TaskManager from "@/components/TaskManager";
import HistoryModal from "@/components/HistoryModal";
import ExamModal from "@/components/ExamModal";
import ActivityHeatmap from "@/components/ActivityHeatmap";
import StreakPill from "@/components/habeet/StreakPill";
import StatsStrip from "@/components/habeet/StatsStrip";
import WorkspaceList from "@/components/habeet/WorkspaceList";
import { istTodayKey } from "@/lib/date-ist";
import { WeekDeltaBadge, WeeklyBars } from "@/components/habeet/WeeklyChart";
import { getTodayKey } from "@/lib/storage";
import { computeStreaks } from "@/lib/activity";
import { isActiveDay } from "@/lib/activity";
import { dashboardStats } from "@/lib/dashboard-stats";
import { practiceWindow } from "@/lib/practice";
import AssistantChat, {
  type ChatGrounding,
} from "@/components/AssistantChat";

/**
 * v3: greeting follows INDIAN STANDARD TIME regardless of device timezone,
 * with a wellness nudge when someone is grinding late at night.
 */
function istNow(): { hour: number; label: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    hour12: false,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    hour: Number(get("hour")) % 24,
    label: `${get("weekday")}, ${get("month")} ${get("day")}`,
  };
}
function greeting(): { text: string; date: string; night: boolean } {
  const { hour, label } = istNow();
  const night = hour >= 23 || hour < 5;
  const text =
    hour < 5
      ? "Late-night grind"
      : hour < 12
      ? "Good morning"
      : hour < 17
      ? "Good afternoon"
      : "Good evening";
  return { text, date: `${label} · IST`, night };
}

export default function Home() {
  const {
    mode,
    isRunning,
    displayTime,
    remainingMs,
    durationMs,
    startTimer,
    pauseTimer,
    resetTimer,
    activeTask,
    activeTaskId,
    tasks,
    tasksCompleted,
    totalTasks,
    addTask,
    toggleTask,
    editTask,
    editTaskMinutes,
    deleteTask,
    startTask,
    todayStats,
    liveProductivity,
    history,
    roadmaps,
    // v5 Practice goals
    practiceTasks,
    todayCheckIns,
    // Per-task exams
    examTaskId,
    examTask,
    attachExam,
    submitExam,
    openExam,
    dismissExam,
    activeRoadmapDay,
    hydrated,
    estimationLog,
    jumpToRoadmapTask,
    // §13/§6: assistant grounding data
    skillProfiles,
    roadmapExamResults,
    loadDemo,
  } = usePomodoro();

  const [historyOpen, setHistoryOpen] = useState(false);

  // §6: grounding for the assistant — the user's REAL tracked data only.
  const chatGrounding = useMemo<ChatGrounding>(
    () => ({
      skillProfiles,
      roadmapExamResults,
      practiceTasks: practiceTasks.map((t) => ({
        id: t.id,
        name: t.name,
        durationDays: t.durationDays,
        is_completed: t.is_completed,
        roadmap: t.roadmap,
        assessment: t.assessment,
      })),
    }),
    [skillProfiles, roadmapExamResults, practiceTasks],
  );

  /**
   * §10: which stat-card filter the "Your workspaces" list should show.
   * null = every saved task; set by clicking the Active/Completed/Overdue
   * stat tiles, cleared by the chip row's Clear button.
   */
  const [wsFilter, setWsFilter] = useState<
    "active" | "completed" | "overdue" | null
  >(null);

  // The shared sidebar (NavRail) is rendered by the (main) layout for task
  // workspaces too; it dispatches a global event to open History from any
  // route. The dashboard owns the modal, so listen for it here.
  useEffect(() => {
    const onOpen = () => setHistoryOpen(true);
    window.addEventListener("habeet:open-history", onOpen);
    return () => window.removeEventListener("habeet:open-history", onOpen);
  }, []);
  /** Â§5 Active resume-jump: expands that day row + highlights the task. */
  const [jumpTarget, setJumpTarget] = useState<{
    name: string;
    roadmapId: string;
    dayNumber: number;
  } | null>(null);

  // Greeting is time/locale-dependent - compute post-mount to avoid any
  // server/client hydration mismatch (acceptance: zero console errors).
  const [hello, setHello] = useState<{
    text: string;
    date: string;
    night: boolean;
  } | null>(null);
  useEffect(() => {
    setHello(greeting());
  }, []);


  // Â§5 Resume-where-you-left-off (Study history entry click): loads that
  // roadmap day with its mirrored progress, closes the modal, force-expands
  // the day row in Roadmap progress, scrolls to the task and pulses it.
  const handleJumpTask = useCallback(
    (item: { name: string; roadmapId?: string; dayNumber?: number }) => {
      if (!item.roadmapId || !item.dayNumber) return;
      const ok = jumpToRoadmapTask(item.roadmapId, item.dayNumber);
      if (!ok) return; // blocked (session running) â€” hook showed a toast
      setHistoryOpen(false);
      setJumpTarget({
        name: item.name,
        roadmapId: item.roadmapId,
        dayNumber: item.dayNumber,
      });
    },
    [jumpToRoadmapTask]
  );

  useEffect(() => {
    if (!jumpTarget) return;
    const scroll = window.setTimeout(() => {
      document
        .querySelector(`[data-day="${jumpTarget.dayNumber}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      const rows = document.querySelectorAll<HTMLElement>("[data-task-name]");
      const match = Array.from(rows).find(
        (el) => el.dataset.taskName === jumpTarget.name
      );
      match?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 120);
    const clear = window.setTimeout(() => setJumpTarget(null), 5000);
    return () => {
      window.clearTimeout(scroll);
      window.clearTimeout(clear);
    };
  }, [jumpTarget]);

  // Current streak over the app's persisted daily activity.
  const { current: currentStreak } = useMemo(
    () => computeStreaks(history, istTodayKey()),
    [history]
  );

  /** Roadmap context for the exam of a task that came from the active day. */
  const examContext = useMemo(() => {
    if (!activeRoadmapDay) return undefined;
    const roadmap = roadmaps.find((r) => r.id === activeRoadmapDay.roadmapId);
    if (!roadmap) return undefined;
    const day = roadmap.days.find(
      (d) => d.day_number === activeRoadmapDay.dayNumber
    );
    if (!day) return undefined;
    return `${roadmap.topic_name} â€” Day ${day.day_number}: ${day.day_title}`;
  }, [activeRoadmapDay, roadmaps]);

  /* The Today card renders twice (inside the desktop right-column card and
     standalone on mobile); both are fed by the same hook state so they agree. */
  const todayCard = (
    <TaskManager
      tasks={tasks}
      tasksCompleted={tasksCompleted}
      totalTasks={totalTasks}
      activeTaskId={activeTaskId}
      onAdd={addTask}
      onToggle={toggleTask}
      onEdit={editTask}
      onEditMinutes={editTaskMinutes}
      onDelete={deleteTask}
      onStartTask={startTask}
      onReviewExam={openExam}
      highlightName={jumpTarget?.name ?? null}
    />
  );

  // Overall dashboard aggregates — the answer to "how am I doing overall?".
  const activeRoadmaps = useMemo(
    () => roadmaps.filter((r) => r.status === "in_progress").length,
    [roadmaps]
  );
  const stats = useMemo(
    () =>
      dashboardStats(
        practiceTasks,
        history,
        activeRoadmaps,
        currentStreak,
        todayStats,
        Date.now()
      ),
    [practiceTasks, history, activeRoadmaps, currentStreak, todayStats]
  );

  /** §10: dashboard stat cards route to a relevant (filtered) section. */
  const handleNavigate = useCallback((target: string) => {
    const ids: Record<string, string> = {
      tasks: "section-practice",
      completed: "section-practice",
      overdue: "section-practice",
      active: "section-practice",
      roadmaps: "section-roadmaps",
      activity: "section-activity",
    };
    if (target === "active") setWsFilter("active");
    else if (target === "completed") setWsFilter("completed");
    else if (target === "overdue") setWsFilter("overdue");
    else if (target === "tasks") setWsFilter(null);
    const id = ids[target];
    if (!id) return;
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  /** §10: workspaces narrowed by the active stat-card filter chip. */
  const filteredTasks = useMemo(
    () =>
      wsFilter
        ? practiceTasks.filter((t) => {
            const s = practiceWindow(t).status;
            // "active" = anything not Completed and not Overdue
            // (matches how dashboardStats counts activeTasks).
            if (wsFilter === "active")
              return s !== "Completed" && s !== "Overdue";
            return s.toLowerCase() === wsFilter;
          })
        : practiceTasks,
    [practiceTasks, wsFilter]
  );

  return (
    <main className="mx-auto w-full max-w-[1440px] px-4 pb-24 pt-6 sm:px-6 lg:px-8 lg:pb-16">
      {/* The ChatGPT-style sidebar + mobile bottom nav are rendered by the
          shared (main) layout; this page provides only dashboard content. */}
      <div className="mb-4">
        <StatsStrip
          counts={{
            total: stats.totalTasks,
            active: stats.activeTasks,
            completed: stats.completedTasks,
            overdue: stats.overdueTasks,
          }}
          activeRoadmaps={stats.activeRoadmaps}
          streak={stats.currentStreak}
          practiceDays={stats.practiceDays}
          totalPracticeSeconds={stats.totalPracticeSeconds}
          todayPracticeMinutes={stats.todayPracticeMinutes}
          onNavigate={handleNavigate}
        />
      </div>
      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[340px_minmax(0,1fr)] lg:items-start lg:gap-5">
        {/* â”€â”€ Header: greeting left Â· streak pill top-right (same row) â”€â”€ */}
        <header className="order-1 flex items-center justify-between gap-3 lg:col-span-2">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold text-gray-50">
              {hello ? hello.text : "Welcome"}
            </h1>
            <p className="mt-0.5 truncate text-xs text-gray-500">{hello?.date ?? ''}</p>
            {hello?.night && (
              <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-300 ring-1 ring-amber-400/30">
                🌙 It&apos;s late in India — you&apos;ve been practicing a lot.
                Plan some rest.
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* §P6: Demo Mode — visible only behind a dev/demo flag. */}
            {process.env.NEXT_PUBLIC_DEMO === "true" && (
              <button
                onClick={loadDemo}
                data-testid="demo-mode-btn"
                title="Load a fully-populated sample state (no LLM call)"
                className="flex items-center gap-2 rounded-full border border-amberAccent-500/30 bg-amberAccent-500/10 px-4 py-2 text-sm font-semibold text-amberAccent-200 outline-none transition duration-150 hover:bg-amberAccent-500/20 hover:text-amberAccent-100 active:scale-95"
              >
                <Rocket className="h-4 w-4" />
                Demo Mode
              </button>
            )}
            {/* Task + Roadmap architecture: "New Task" opens the dedicated
                blank workspace (/task/new) instead of an in-page modal. */}
            <Link
              href="/task/new"
              data-testid="new-task-btn"
              className="btn-primary px-4 py-2 text-sm"
            >
              <Plus className="h-4 w-4" />
              New Task
            </Link>
            <StreakPill days={currentStreak} />
            <button
              onClick={() => setHistoryOpen(true)}
              aria-label="View full history"
              className="flex items-center gap-2 rounded-full border border-white/10 bg-surface-raised px-4 py-2 text-sm font-semibold text-gray-300 outline-none transition hover:bg-surface-overlay hover:text-gray-100 active:scale-95"
            >
              <History className="h-4 w-4" />
              History
            </button>
          </div>
        </header>

        {/* â”€â”€ Timer card (desktop: fixed 340px left column) â”€â”€ */}
        <div className="order-2 lg:row-span-2">
          <Timer
            mode={mode}
            isRunning={isRunning}
            displayTime={displayTime}
            remainingMs={remainingMs}
            durationMs={durationMs}
            activeTaskName={activeTask?.name ?? null}
            onStart={startTimer}
            onPause={pauseTimer}
            onReset={resetTimer}
            currentStreak={currentStreak}
            todayPct={liveProductivity}
          />
        </div>

        {/* â”€â”€ Desktop right column: Activity + Today inside ONE card â”€â”€ */}
        <div className="hidden rounded-2xl bg-surface p-5 ring-1 ring-white/5 lg:order-none lg:block lg:col-start-2 lg:row-start-2">
          {/* Activity â€” 12-week heatmap */}
          <section id="section-activity" aria-label="Activity" data-testid="activity-card">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-100">Activity</h2>
              <span className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
                Last 12 weeks
              </span>
            </div>
            <ActivityHeatmap
              history={history}
              todayStats={{ ...todayStats, check_ins: todayCheckIns }}
              loading={!hydrated}
            />
          </section>

          <div className="my-5 h-px bg-white/5" />

          {/* Today's Tasks below the heatmap, same card */}
          {todayCard}
        </div>

        {/* â”€â”€ Mobile #3: "This week" 7-bar chart card â”€â”€ */}
        <section
          aria-label="This week"
          className="order-3 rounded-2xl bg-surface p-5 ring-1 ring-white/5 lg:hidden"
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-100">This week</h2>
            {hydrated && (
              <WeekDeltaBadge history={history} todayKey={istTodayKey()} />
            )}
          </div>
          {hydrated ? (
            <WeeklyBars
              history={history}
              todayKey={istTodayKey()}
              todayMinutes={todayStats.focus_minutes}
            />
          ) : (
            <p className="py-6 text-center text-sm text-gray-500">Loadingâ€¦</p>
          )}
        </section>

        {/* â”€â”€ Saved workspaces (compact overview — NOT full cards, NOT full
            roadmaps). Each row opens its dedicated /task/:id workspace where
            the full roadmap, timer and daily check-ins live. â”€â”€ */}
        <div id="section-practice" className="order-4 lg:col-span-2">
          <section
            aria-label="Your workspaces"
            className="rounded-2xl bg-surface p-5 ring-1 ring-white/5"
          >
            <div className="mb-1 flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-gray-100">
                Your workspaces
              </h2>
              <span className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
                {practiceTasks.length} saved
              </span>
            </div>
            <p className="mb-2 text-xs text-gray-500">
              Saved tasks — open one to keep working on its roadmap and timer.
            </p>
            {/* §10: stat-card filter (click Active/Completed/Overdue card) */}
            {wsFilter && (
              <div
                data-testid="ws-filter-row"
                aria-label={`Filtering workspaces: ${wsFilter}`}
                className="mb-3 flex items-center gap-2 rounded-xl bg-habeet-500/10 px-3 py-2 ring-1 ring-habeet-500/30"
              >
                <span className="text-xs font-semibold capitalize text-habeet-200">
                  Filter: {wsFilter} tasks
                </span>
                <button
                  type="button"
                  data-testid="ws-filter-clear"
                  onClick={() => setWsFilter(null)}
                  className="ml-auto rounded-lg px-2 py-0.5 text-[11px] font-semibold text-gray-300 outline-none transition hover:bg-white/5 hover:text-gray-100 focus-visible:ring-2 focus-visible:ring-habeet-400"
                >
                  Clear filter ✕
                </button>
              </div>
            )}
            <WorkspaceList
              tasks={filteredTasks}
              emptyHint={
                wsFilter
                  ? `No ${wsFilter} tasks right now.`
                  : "No tasks yet — hit New Task to open a blank workspace and start one today."
              }
            />
          </section>
        </div>

        {/* â€”â€” Active roadmaps: a compact summary, not a full dump of every
            task's roadmap. Roadmaps belong to their task workspace. */}
        <div id="section-roadmaps" className="order-5 lg:col-span-2">
          <section
            aria-label="Active roadmaps"
            className="rounded-2xl bg-surface p-5 ring-1 ring-white/5"
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-gray-100">
                Active roadmaps
              </h2>
              <span className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
                {activeRoadmaps} in progress
              </span>
            </div>
            {roadmaps.length === 0 && practiceTasks.length === 0 ? (
              <p className="py-4 text-center text-sm text-gray-500">
                No roadmaps yet — open a task and build (or AI-generate) its
                roadmap there.
              </p>
            ) : (
              <ul className="divide-y divide-white/5">
                {roadmaps.map((r) => {
                  const linked = practiceTasks.find(
                    (t) => t.name.toLowerCase() === r.topic_name.toLowerCase()
                  );
                  const pct = Math.round(
                    (r.days.filter((d) => d.is_completed).length / r.days.length) *
                      100
                  );
                  return (
                    <li
                      key={r.id}
                      className="flex items-center justify-between gap-3 py-2.5"
                    >
                      <span className="min-w-0 truncate text-sm font-medium text-gray-200">
                        {r.topic_name}
                        {linked && (
                          <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-habeet-500/15 px-2 py-0.5 text-[10px] font-semibold text-habeet-200 ring-1 ring-habeet-400/30">
                            {linked.durationDays || r.days.length} days
                          </span>
                        )}
                        {/* §P5: subtle confidence indicator — transparency, not a warning. */}
                        {r.confidence && (
                          <span
                            className="ml-2 inline-flex items-center gap-1 rounded-full bg-surface-raised px-2 py-0.5 text-[10px] font-medium text-gray-400 ring-1 ring-white/10"
                            title={r.confidence.reason}
                          >
                            confidence: {r.confidence.level}
                          </span>
                        )}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-[11px] tabular-nums text-gray-400">
                          {pct}%
                        </span>
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-overlay">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-habeet-500 to-habeet-400"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        {/* â”€â”€ Mobile #5: standalone Today card â”€â”€ */}
        <div className="order-6 lg:hidden pb-20 lg:pb-0">{todayCard}</div>

              </div>

      {/* Per-task exam (opens automatically when a task is completed) */}
      {examTask && (
        <ExamModal
          task={examTask}
          context={examContext}
          timingOutcome={examTask.timing_outcome ?? null}
          onClose={dismissExam}
          onAttachQuestions={attachExam}
          onSubmitAnswers={submitExam}
        />
      )}

      {/* Full History modal (insights + per-day logs) */}
      <HistoryModal
        open={historyOpen}
        practiceTasks={practiceTasks}
        history={history}
        roadmaps={roadmaps}
        estimationLog={estimationLog}
        onJumpTask={handleJumpTask}
        onClose={() => setHistoryOpen(false)}
      />

      {/* §6 grounded study assistant (floating widget). */}
      <AssistantChat grounding={chatGrounding} />
    </main>
  );
}
