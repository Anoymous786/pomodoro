"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  DayStats,
  effectiveMinutes,
  ExamQuestion,
  getTimerDurationMs,
  IntakeContext,
  PomodoroAppState,
  Priority,
  Roadmap,
  RoadmapPriority,
  RoadmapTask,
  Settings,
  Task,
  TaskExamResult,
  TimerMode,
} from "@/lib/types";
import {
  buildDayStats,
  computeProductivity,
  countCompletedTasks,
  generateId,
  getTodayKey,
  loadState,
  saveState,
} from "@/lib/storage";

/**
 * Custom hook that owns the entire Pomodoro app state:
 * timer, tasks, daily stats, roadmaps, and badges. All state is
 * persisted to localStorage via the shared schema in lib/types.ts.
 *
 * The timer survives tab backgrounding because we store an
 * absolute endTimestamp and derive remaining time from it,
 * rather than counting setInterval ticks.
 *
 * Task-driven timing: when a task is selected/started, its
 * effective minutes (manual override ?? AI estimate) become the
 * work countdown duration. When a task's timer finishes, the task
 * is marked complete and the timer auto-advances to the next
 * incomplete task in that day's queue after a short break.
 */
export function usePomodoro() {
  const [state, setState] = useState<PomodoroAppState>(() => loadState());
  const [now, setNow] = useState<number>(() => Date.now());
  /**
   * Id of the task whose exam modal is currently open (null = closed).
   * UI-only state; the exam itself + result live on the Task in localStorage.
   */
  const [examTaskId, setExamTaskId] = useState<string | null>(null);

  // Persist state to localStorage whenever it changes.
  useEffect(() => {
    saveState(state);
  }, [state]);

  // Tick every 500ms to re-render the countdown. The actual
  // remaining time is always derived from endTime, so this
  // interval is only for UI refresh — it never accumulates drift.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);

  // When the timer is running and the end timestamp passes,
  // complete the session.
  useEffect(() => {
    const { timer } = state;
    if (!timer.isRunning || timer.endTimestamp === null) return;
    if (now >= timer.endTimestamp) {
      completeSession();
    }
  }, [now, state.timer.isRunning, state.timer.endTimestamp]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Derived values ----

  const settings = state.settings;
  const timer = state.timer;
  const tasks = state.tasks;

  const durationMs = getTimerDurationMs(timer, settings);
  const remainingMs = timer.endTimestamp
    ? Math.max(0, timer.endTimestamp - now)
    : durationMs;
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  const displayTime = `${String(minutes).padStart(2, "0")}:${String(
    seconds
  ).padStart(2, "0")}`;

  const tasksCompleted = countCompletedTasks(tasks);
  const totalTasks = tasks.length;

  const activeTask = timer.activeTaskId
    ? tasks.find((t) => t.id === timer.activeTaskId) ?? null
    : null;

  // Today's stats (from history or computed live).
  const todayKey = getTodayKey();
  const todayStats: DayStats = state.history[todayKey] ?? {
    date: todayKey,
    sessions_count: 0,
    focus_minutes: 0,
    tasks_completed: 0,
    total_tasks: 0,
    productivity: 0,
  };

  // Live productivity for today (recomputed on every render so the
  // dashboard stays current without waiting for a session to end).
  const liveProductivity = computeProductivity(
    tasksCompleted,
    totalTasks,
    todayStats.sessions_count,
    settings.dailySessionGoal
  );

  // ---- Timer actions ----

  const requestNotificationPermission = useCallback(async () => {
    if (typeof window !== "undefined" && "Notification" in window) {
      if (Notification.permission === "default") {
        try {
          await Notification.requestPermission();
        } catch {
          // Permission request failed; ignore.
        }
      }
    }
  }, []);

  const playChime = useCallback(() => {
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new AudioCtx();
      const playTone = (freq: number, start: number, duration: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.001, ctx.currentTime + start);
        gain.gain.exponentialRampToValueAtTime(
          0.3,
          ctx.currentTime + start + 0.02
        );
        gain.gain.exponentialRampToValueAtTime(
          0.001,
          ctx.currentTime + start + duration
        );
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + start);
        osc.stop(ctx.currentTime + start + duration);
      };
      playTone(880, 0, 0.2);
      playTone(660, 0.25, 0.2);
      playTone(880, 0.5, 0.3);
    } catch {
      // Audio not available; ignore.
    }
  }, []);

  const notify = useCallback(
    (mode: TimerMode) => {
      const labels: Record<TimerMode, string> = {
        work: "Work session complete! Time for a break. 🎉",
        shortBreak: "Short break over. Back to focus! 💪",
        longBreak: "Long break over. Ready for the next round! 🚀",
      };
      if (typeof window !== "undefined" && "Notification" in window) {
        if (Notification.permission === "granted") {
          try {
            new Notification("Pomodoro", { body: labels[mode] });
          } catch {
            // Notification constructor failed; ignore.
          }
        }
      }
      playChime();
    },
    [playChime]
  );

  /**
   * Starts a work session for the given task. The countdown uses that
   * task's effective minutes (manual override ?? AI estimate).
   */
  const startTask = useCallback(
    (taskId: string) => {
      requestNotificationPermission();
      setState((prev) => {
        const task = prev.tasks.find((t) => t.id === taskId) ?? null;
        const taskMinutes = task
          ? effectiveMinutes(task.estimated_minutes, task.manual_minutes)
          : prev.settings.workMinutes;
        return {
          ...prev,
          timer: {
            ...prev.timer,
            mode: "work",
            isRunning: true,
            endTimestamp: Date.now() + taskMinutes * 60 * 1000,
            activeTaskId: task ? task.id : null,
            taskDurationMinutes: taskMinutes,
          },
        };
      });
    },
    [requestNotificationPermission]
  );

  /**
   * Starts the timer for the currently selected task (or, in break
   * mode, just starts the break countdown).
   */
  const startTimer = useCallback(() => {
    requestNotificationPermission();
    setState((prev) => {
      const task = prev.timer.activeTaskId
        ? prev.tasks.find((t) => t.id === prev.timer.activeTaskId) ?? null
        : null;

      if (prev.timer.mode === "work" && task) {
        // Task-driven work session.
        const taskMinutes = effectiveMinutes(
          task.estimated_minutes,
          task.manual_minutes
        );
        return {
          ...prev,
          timer: {
            ...prev.timer,
            mode: "work",
            isRunning: true,
            endTimestamp: Date.now() + taskMinutes * 60 * 1000,
            activeTaskId: task.id,
            taskDurationMinutes: taskMinutes,
          },
        };
      }

      // Break session (or generic work with no active task).
      const durationMs = getTimerDurationMs(prev.timer, prev.settings);
      return {
        ...prev,
        timer: {
          ...prev.timer,
          mode: prev.timer.mode,
          isRunning: true,
          endTimestamp: Date.now() + durationMs,
        },
      };
    });
  }, [requestNotificationPermission]);

  const pauseTimer = useCallback(() => {
    setState((prev) => {
      if (!prev.timer.isRunning || prev.timer.endTimestamp === null) {
        return prev;
      }
      // Preserve remaining time by recomputing endTimestamp from now.
      const remaining = Math.max(0, prev.timer.endTimestamp - Date.now());
      return {
        ...prev,
        timer: {
          ...prev.timer,
          isRunning: false,
          endTimestamp: Date.now() + remaining,
        },
      };
    });
  }, []);

  const resetTimer = useCallback(() => {
    setState((prev) => ({
      ...prev,
      timer: {
        ...prev.timer,
        isRunning: false,
        endTimestamp: null,
      },
    }));
  }, []);

  const completeSession = useCallback(() => {
    setState((prev) => {
      const { timer, settings, history, tasks } = prev;
      const todayKey = getTodayKey();
      const prevStats = history[todayKey] ?? {
        date: todayKey,
        sessions_count: 0,
        focus_minutes: 0,
        tasks_completed: 0,
        total_tasks: 0,
        productivity: 0,
      };

      let nextMode: TimerMode;
      let completedWorkSessions = timer.completedWorkSessions;
      let sessionsCount = prevStats.sessions_count;
      let focusMinutes = prevStats.focus_minutes;

      let nextTasks = tasks;
      let nextActiveTaskId = timer.activeTaskId;
      let nextTaskDurationMinutes = timer.taskDurationMinutes;

      if (timer.mode === "work") {
        completedWorkSessions += 1;
        sessionsCount += 1;
        // Credit the focus minutes for the session that actually ran
        // (the active task's effective minutes, or settings default).
        const sessionMinutes =
          timer.taskDurationMinutes ?? settings.workMinutes;
        focusMinutes += sessionMinutes;

        // Mark the active task complete (if any).
        if (timer.activeTaskId) {
          nextTasks = tasks.map((t) =>
            t.id === timer.activeTaskId ? { ...t, is_completed: true } : t
          );
        }

        // Auto-advance to the next incomplete task in the queue.
        const activeIdx = nextTasks.findIndex(
          (t) => t.id === timer.activeTaskId
        );
        const nextTask =
          nextTasks.find(
            (t, idx) => idx > activeIdx && !t.is_completed
          ) ??
          nextTasks.find((t, idx) => idx <= activeIdx && !t.is_completed) ??
          null;

        nextActiveTaskId = nextTask ? nextTask.id : null;
        nextTaskDurationMinutes = nextTask
          ? effectiveMinutes(nextTask.estimated_minutes, nextTask.manual_minutes)
          : null;

        // Long break after every N completed work sessions.
        nextMode =
          completedWorkSessions % settings.longBreakInterval === 0
            ? "longBreak"
            : "shortBreak";
      } else {
        // Break finished; return to work. The active task is already
        // loaded (or null = generic session).
        nextMode = "work";
      }

      const tasksCompletedFinal = countCompletedTasks(nextTasks);
      const totalTasksFinal = nextTasks.length;
      const updatedStats: DayStats = buildDayStats(
        todayKey,
        sessionsCount,
        focusMinutes,
        tasksCompletedFinal,
        totalTasksFinal,
        settings.dailySessionGoal
      );

      return {
        ...prev,
        tasks: nextTasks,
        timer: {
          mode: nextMode,
          isRunning: false,
          endTimestamp: null,
          completedWorkSessions,
          activeTaskId: nextActiveTaskId,
          taskDurationMinutes: nextTaskDurationMinutes,
        },
        history: {
          ...history,
          [todayKey]: updatedStats,
        },
      };
    });

    // Fire notification + sound for the session that just ended.
    notify(state.timer.mode);
  }, [notify, state.timer.mode]);

  // ---- Task actions ----

  const addTask = useCallback(
    (name: string, priority: Priority, estimatedMinutes: number = 25) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const estimate =
        Number.isFinite(estimatedMinutes) && estimatedMinutes > 0
          ? Math.round(estimatedMinutes)
          : 25;
      const task: Task = {
        id: generateId(),
        name: trimmed,
        priority,
        estimated_minutes: estimate,
        is_completed: false,
        createdAt: Date.now(),
        manual_minutes: null,
      };
      setState((prev) => {
        const nextTasks = [...prev.tasks, task];
        const todayKey = getTodayKey();
        const prevStats = prev.history[todayKey];
        const updatedStats: DayStats = prevStats
          ? {
              ...prevStats,
              total_tasks: nextTasks.length,
              productivity: computeProductivity(
                countCompletedTasks(nextTasks),
                nextTasks.length,
                prevStats.sessions_count,
                prev.settings.dailySessionGoal
              ),
            }
          : buildDayStats(
              todayKey,
              0,
              0,
              0,
              nextTasks.length,
              prev.settings.dailySessionGoal
            );
        return {
          ...prev,
          tasks: nextTasks,
          history: { ...prev.history, [todayKey]: updatedStats },
        };
      });
    },
    []
  );

  const toggleTask = useCallback(
    (id: string) => {
      // Decide up-front (from the current snapshot) whether this toggle
      // completes the task and needs an exam, so we can open the modal
      // outside of the state updater (no side effects inside setState).
      const target = state.tasks.find((t) => t.id === id);
      const willComplete = !!target && !target.is_completed;
      const shouldShowExam =
        willComplete && target != null && !target.examResult;

      setState((prev) => {
        const nextTasks = prev.tasks.map((t) =>
          t.id === id ? { ...t, is_completed: !t.is_completed } : t
        );
      const todayKey = getTodayKey();
      const prevStats = prev.history[todayKey];
      const completed = countCompletedTasks(nextTasks);
      const updatedStats: DayStats = prevStats
        ? {
            ...prevStats,
            tasks_completed: completed,
            total_tasks: nextTasks.length,
            productivity: computeProductivity(
              completed,
              nextTasks.length,
              prevStats.sessions_count,
              prev.settings.dailySessionGoal
            ),
          }
        : buildDayStats(
            todayKey,
            0,
            0,
            completed,
            nextTasks.length,
            prev.settings.dailySessionGoal
          );

      // AUTO-COMPLETION: if the current task list came from a roadmap
      // day and all its tasks are now complete, mark that day completed.
      let roadmaps = prev.roadmaps;
      let badges = prev.badges;
      const active = prev.activeRoadmapDay;

      if (active && nextTasks.length > 0 && nextTasks.every((t) => t.is_completed)) {
        const roadmap = roadmaps.find((r) => r.id === active.roadmapId);
        if (roadmap) {
          const days = roadmap.days.map((d) =>
            d.day_number === active.dayNumber
              ? { ...d, is_completed: true }
              : d
          );
          const allDaysDone = days.every((d) => d.is_completed);
          let status: Roadmap["status"] = "in_progress";

          if (allDaysDone) {
            status = "completed";
            const alreadyUnlocked = badges.some(
              (b) => b.title === roadmap.badge_reward.title
            );
            if (!alreadyUnlocked) {
              const badge: Badge = {
                id: generateId(),
                title: roadmap.badge_reward.title,
                icon: roadmap.badge_reward.icon,
                unlockedAt: Date.now(),
              };
              badges = [...badges, badge];
            }
          }

          roadmaps = roadmaps.map((r) =>
            r.id === active.roadmapId ? { ...r, days, status } : r
          );
        }
      }

      return {
        ...prev,
        tasks: nextTasks,
        history: { ...prev.history, [todayKey]: updatedStats },
        roadmaps,
        badges,
      };
      });

      // Immediately surface the per-task exam for the just-completed task.
      if (shouldShowExam) {
        setExamTaskId(id);
      }
    },
    [state]
  );

  const editTask = useCallback((id: string, name: string, priority: Priority) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setState((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) =>
        t.id === id ? { ...t, name: trimmed, priority } : t
      ),
    }));
  }, []);

  const deleteTask = useCallback((id: string) => {
    setState((prev) => {
      const nextTasks = prev.tasks.filter((t) => t.id !== id);
      const todayKey = getTodayKey();
      const prevStats = prev.history[todayKey];
      const completed = countCompletedTasks(nextTasks);
      const updatedStats: DayStats = prevStats
        ? {
            ...prevStats,
            tasks_completed: completed,
            total_tasks: nextTasks.length,
            productivity: computeProductivity(
              completed,
              nextTasks.length,
              prevStats.sessions_count,
              prev.settings.dailySessionGoal
            ),
          }
        : buildDayStats(
            todayKey,
            0,
            0,
            completed,
            nextTasks.length,
            prev.settings.dailySessionGoal
          );
      return {
        ...prev,
        tasks: nextTasks,
        history: { ...prev.history, [todayKey]: updatedStats },
      };
    });
  }, []);

  /**
   * Overrides the estimated minutes for a working task. When the task
   * belongs to an active roadmap day, the override is also synced back
   * to the roadmap day so the day summary and re-planning use
   * consistent values.
   */
  const editTaskMinutes = useCallback((id: string, minutes: number | null) => {
    const m = minutes == null || !(minutes > 0) ? null : Math.round(minutes);
    setState((prev) => {
      const idx = prev.tasks.findIndex((t) => t.id === id);
      if (idx === -1) return prev;

      const nextTasks = prev.tasks.map((t) =>
        t.id === id ? { ...t, manual_minutes: m } : t
      );

      let roadmaps = prev.roadmaps;
      const active = prev.activeRoadmapDay;
      if (active) {
        roadmaps = roadmaps.map((r) => {
          if (r.id !== active.roadmapId) return r;
          return {
            ...r,
            days: r.days.map((d) => {
              if (d.day_number !== active.dayNumber) return d;
              const dayTasks = d.tasks.map((rt, i) =>
                i === idx ? { ...rt, manual_minutes: m } : rt
              );
              return { ...d, tasks: dayTasks };
            }),
          };
        });
      }

      return { ...prev, tasks: nextTasks, roadmaps };
    });
  }, []);

  /**
   * Overrides a task's minutes directly in a roadmap day card
   * (TopicBoard). If that day is the active day, the change is also
   * reflected in the working task list.
   */
  const updateRoadmapTaskMinutes = useCallback(
    (
      roadmapId: string,
      dayNumber: number,
      taskIndex: number,
      minutes: number | null
    ) => {
      const m = minutes == null || !(minutes > 0) ? null : Math.round(minutes);
      setState((prev) => {
        const roadmaps = prev.roadmaps.map((r) => {
          if (r.id !== roadmapId) return r;
          return {
            ...r,
            days: r.days.map((d) => {
              if (d.day_number !== dayNumber) return d;
              const dayTasks = d.tasks.map((rt, i) =>
                i === taskIndex ? { ...rt, manual_minutes: m } : rt
              );
              return { ...d, tasks: dayTasks };
            }),
          };
        });

        // Sync into the working task list if this is the active day.
        let nextTasks = prev.tasks;
        const active = prev.activeRoadmapDay;
        if (
          active &&
          active.roadmapId === roadmapId &&
          active.dayNumber === dayNumber
        ) {
          nextTasks = prev.tasks.map((t, i) =>
            i === taskIndex ? { ...t, manual_minutes: m } : t
          );
        }

        return { ...prev, roadmaps, tasks: nextTasks };
      });
    },
    []
  );

  // ---- Roadmap actions ----

  /**
   * Calls the LLM API to generate a roadmap for a topic and
   * saves it to state. Returns the new roadmap or throws.
   */
  const generateRoadmap = useCallback(
    async (topic: string, context?: IntakeContext) => {
      const res = await fetch("/api/generate-roadmap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, context }),
      });

    const data = (await res.json()) as {
      roadmap?: Roadmap;
      error?: string;
    };

    if (!res.ok || !data.roadmap) {
      throw new Error(data.error ?? "Failed to generate roadmap.");
    }

    const roadmap: Roadmap = {
      ...data.roadmap,
      id: generateId(),
      status: "in_progress",
      createdAt: Date.now(),
      days: data.roadmap.days.map((day) => ({
        ...day,
        is_completed: false,
        tasks: day.tasks.map((t) => ({
          ...t,
          priority: t.priority,
          estimated_minutes:
            typeof t.estimated_minutes === "number" && t.estimated_minutes > 0
              ? t.estimated_minutes
              : 25,
          manual_minutes: null,
        })),
      })),
    };

    setState((prev) => ({
      ...prev,
      roadmaps: [...prev.roadmaps, roadmap],
    }));

      return roadmap;
    },
    []
  );

  /**
   * Loads a roadmap day's tasks into the current task list.
   * Also selects the first incomplete task and loads its effective
   * minutes as the working countdown duration.
   */
  const startDay = useCallback((roadmapId: string, dayNumber: number) => {
    setState((prev) => {
      const roadmap = prev.roadmaps.find((r) => r.id === roadmapId);
      if (!roadmap) return prev;
      const day = roadmap.days.find((d) => d.day_number === dayNumber);
      if (!day) return prev;

      // Convert roadmap tasks to Task objects (with AI estimates and
      // any manual overrides from this day).
      const newTasks: Task[] = day.tasks.map((t) => ({
        id: generateId(),
        name: t.name,
        priority: t.priority.toLowerCase() as Priority,
        estimated_minutes: t.estimated_minutes ?? 25,
        is_completed: false,
        createdAt: Date.now(),
        manual_minutes: t.manual_minutes ?? null,
      }));

      const firstIncomplete =
        newTasks.find((t) => !t.is_completed) ?? newTasks[0] ?? null;

      return {
        ...prev,
        tasks: newTasks,
        activeRoadmapDay: { roadmapId, dayNumber },
        timer: {
          ...prev.timer,
          mode: "work",
          isRunning: false,
          endTimestamp: null,
          activeTaskId: firstIncomplete ? firstIncomplete.id : null,
          taskDurationMinutes: firstIncomplete
            ? effectiveMinutes(
                firstIncomplete.estimated_minutes,
                firstIncomplete.manual_minutes
              )
            : null,
        },
      };
    });
  }, []);

  /**
   * Marks a roadmap day as completed and, if all days are done,
   * marks the roadmap completed and unlocks its badge.
   */
  const completeRoadmapDay = useCallback(
    (roadmapId: string, dayNumber: number) => {
      setState((prev) => {
        const roadmap = prev.roadmaps.find((r) => r.id === roadmapId);
        if (!roadmap) return prev;

        const days = roadmap.days.map((d) =>
          d.day_number === dayNumber ? { ...d, is_completed: true } : d
        );
        const allDaysDone = days.every((d) => d.is_completed);

        let badges = prev.badges;
        let status: Roadmap["status"] = "in_progress";

        if (allDaysDone) {
          status = "completed";
          const alreadyUnlocked = badges.some(
            (b) => b.title === roadmap.badge_reward.title
          );
          if (!alreadyUnlocked) {
            const badge: Badge = {
              id: generateId(),
              title: roadmap.badge_reward.title,
              icon: roadmap.badge_reward.icon,
              unlockedAt: Date.now(),
            };
            badges = [...badges, badge];
          }
        }

        const updatedRoadmaps = prev.roadmaps.map((r) =>
          r.id === roadmapId ? { ...r, days, status } : r
        );

        return {
          ...prev,
          roadmaps: updatedRoadmaps,
          badges,
        };
      });
    },
    []
  );

  /**
   * Calls the new /api/replan-day route with the day's current tasks
   * plus the user's edited time budget (sum of effective minutes).
   * Replaces the day's task list with the AI's re-planned version,
   * preserving is_completed for tasks whose name didn't change.
   */
  const replanDay = useCallback(
    async (roadmapId: string, dayNumber: number): Promise<Roadmap> => {
      const isActive =
        state.activeRoadmapDay?.roadmapId === roadmapId &&
        state.activeRoadmapDay?.dayNumber === dayNumber;

      // Source tasks: prefer the working list if the day is loaded,
      // otherwise use the roadmap day directly.
      const sourceTasks: {
        name: string;
        priority: Priority;
        estimated_minutes: number;
      }[] = isActive
        ? state.tasks.map((t) => ({
            name: t.name,
            priority: t.priority,
            estimated_minutes: effectiveMinutes(
              t.estimated_minutes,
              t.manual_minutes
            ),
          }))
        : (() => {
            const roadmap = state.roadmaps.find((r) => r.id === roadmapId);
            const day = roadmap?.days.find(
              (d) => d.day_number === dayNumber
            );
            return (day?.tasks ?? []).map((t) => ({
              name: t.name,
              priority: t.priority.toLowerCase() as Priority,
              estimated_minutes: effectiveMinutes(
                t.estimated_minutes,
                t.manual_minutes
              ),
            }));
          })();

      if (sourceTasks.length === 0) {
        throw new Error("This day has no tasks to re-plan.");
      }

      // The user's edited time budget = sum of effective minutes
      // (manual overrides win, otherwise the AI estimate).
      const budgetMinutes = sourceTasks.reduce(
        (sum, t) => sum + (t.estimated_minutes || 0),
        0
      );

      const res = await fetch("/api/replan-day", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tasks: sourceTasks.map((t) => ({
            name: t.name,
            priority:
              t.priority === "high"
                ? "High"
                : t.priority === "medium"
                ? "Medium"
                : "Low",
            estimated_minutes: t.estimated_minutes,
          })),
          budget_minutes: budgetMinutes,
        }),
      });

      const data = (await res.json()) as {
        tasks?: {
          name: string;
          priority: "High" | "Medium" | "Low";
          estimated_minutes: number;
        }[];
        error?: string;
      };

      if (!res.ok || !data.tasks) {
        throw new Error(data.error ?? "Failed to re-plan tasks.");
      }

      // Map the LLM's task priority back to lowercase Task priority.
      const toPriority = (p: "High" | "Medium" | "Low"): Priority =>
        p === "High" ? "high" : p === "Medium" ? "medium" : "low";

      // Preserve is_completed for tasks whose name didn't change.
      // Only reference the working list when the day is active; a
      // non-active day's roadmap tasks don't carry completion state.
      const completionLookup = isActive
        ? new Map(
            state.tasks.map((t) => [t.name.toLowerCase(), t.is_completed])
          )
        : null;
      const newTasks: Task[] = data.tasks.map((newTask) => {
        const key = newTask.name.toLowerCase();
        const wasCompleted = completionLookup?.get(key) ?? false;
        return {
          id: generateId(),
          name: newTask.name,
          priority: toPriority(newTask.priority),
          estimated_minutes: Math.max(1, Math.round(newTask.estimated_minutes)),
          is_completed: wasCompleted,
          createdAt: Date.now(),
          manual_minutes: null,
        };
      });

      // Pure helper: produces the updated roadmaps array from any base.
      // Deriving inside the updater (from `prev`) prevents clobbering any
      // state changes that happened while the API call was in flight.
      const applyToRoadmaps = (base: Roadmap[]): Roadmap[] =>
        base.map((r) => {
          if (r.id !== roadmapId) return r;
          return {
            ...r,
            days: r.days.map((d) => {
              if (d.day_number !== dayNumber) return d;
              const newDayTasks: RoadmapTask[] = newTasks.map((t) => ({
                name: t.name,
                priority: (
                  t.priority.charAt(0).toUpperCase() + t.priority.slice(1)
                ) as RoadmapPriority,
                estimated_minutes: t.estimated_minutes,
                manual_minutes: null,
              }));
              return { ...d, tasks: newDayTasks };
            }),
          };
        });

      // Update the working list + timer if the day is active.
      if (isActive) {
        const nextIncomplete =
          newTasks.find((t) => !t.is_completed) ?? null;
        setState((prev) => ({
          ...prev,
          tasks: newTasks,
          roadmaps: applyToRoadmaps(prev.roadmaps),
          activeRoadmapDay: { roadmapId, dayNumber },
          timer: {
            ...prev.timer,
            mode: "work",
            isRunning: false,
            endTimestamp: null,
            activeTaskId: nextIncomplete ? nextIncomplete.id : null,
            taskDurationMinutes: nextIncomplete
              ? effectiveMinutes(
                  nextIncomplete.estimated_minutes,
                  nextIncomplete.manual_minutes
                )
              : null,
          },
        }));
      } else {
        setState((prev) => ({
          ...prev,
          roadmaps: applyToRoadmaps(prev.roadmaps),
        }));
      }

      // Return the FRESH roadmap (same mapping the updater applied), not
      // the stale pre-replan object — callers rely on this reflecting the
      // re-planned tasks immediately.
      const updated = applyToRoadmaps(state.roadmaps).find(
        (r) => r.id === roadmapId
      );
      if (!updated) {
        throw new Error("Re-planned roadmap could not be found.");
      }
      return updated;
    },
    [state]
  );

  // ---- Per-task exam ----

  /**
   * Stores generated exam questions on the task (persisted via the
   * global state -> localStorage effect). Immutably maps over tasks.
   */
  const attachExam = useCallback((taskId: string, questions: ExamQuestion[]) => {
    setState((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              exam: { taskName: t.name, questions, createdAt: Date.now() },
            }
          : t
      ),
    }));
  }, []);

  /**
   * Submits answers for a task's exam, grades them via /api/grade-exam,
   * and stores the result on the task in localStorage.
   */
  const submitExam = useCallback(
    async (
      taskId: string,
      questions: ExamQuestion[],
      answers: Record<string, string>
    ): Promise<TaskExamResult> => {
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error("Task not found.");
      if (!questions.length) throw new Error("This task has no exam yet.");

      const res = await fetch("/api/grade-exam", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskName: task.name,
          questions,
          answers,
        }),
      });

      const data = (await res.json()) as {
        score?: number;
        message?: string;
        error?: string;
      };

      if (!res.ok || typeof data.score !== "number") {
        throw new Error(data.error ?? "Failed to grade the exam.");
      }

      const score = Math.max(0, Math.min(100, Math.round(data.score)));
      const passed = score >= 70;
      const needsReview = score < 60;
      // Approximate correct count from the authoritative LLM score —
      // short-answer grading is fuzzy, so we don't count exactly.
      const correct = Math.round((score / 100) * questions.length);

      const fallbackMessage =
        score >= 70
          ? "Nice work — you've got this down!"
          : "A quick review of this task would help before moving on.";
      const result: TaskExamResult = {
        score,
        passed,
        needs_review: needsReview,
        message:
          typeof data.message === "string" && data.message.trim()
            ? data.message.trim()
            : fallbackMessage,
        gradedAt: Date.now(),
        answers,
        total: questions.length,
        correct,
      };

      setState((prev) => ({
        ...prev,
        tasks: prev.tasks.map((t) =>
          t.id === taskId ? { ...t, examResult: result } : t
        ),
      }));

      return result;
    },
    [state]
  );

  /** Re-opens a task's exam (review mode). */
  const openExam = useCallback((taskId: string) => {
    setExamTaskId(taskId);
  }, []);

  /** Closes the exam modal. */
  const dismissExam = useCallback(() => {
    setExamTaskId(null);
  }, []);

  // ---- Settings ----

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setState((prev) => ({
      ...prev,
      settings: { ...prev.settings, ...patch },
    }));
  }, []);

  return {
    // Roadmaps
    roadmaps: state.roadmaps,
    badges: state.badges,
    activeRoadmapDay: state.activeRoadmapDay,
    generateRoadmap,
    startDay,
    completeRoadmapDay,
    replanDay,
    updateRoadmapTaskMinutes,
    // Timer
    mode: timer.mode,
    isRunning: timer.isRunning,
    displayTime,
    remainingMs,
    durationMs,
    completedWorkSessions: timer.completedWorkSessions,
    activeTaskId: timer.activeTaskId ?? null,
    activeTask,
    startTimer,
    startTask,
    pauseTimer,
    resetTimer,
    // Tasks
    tasks,
    tasksCompleted,
    totalTasks,
    addTask,
    toggleTask,
    editTask,
    editTaskMinutes,
    deleteTask,
    // Per-task exams
    examTaskId,
    examTask:
      examTaskId != null
        ? state.tasks.find((t) => t.id === examTaskId) ?? null
        : null,
    attachExam,
    submitExam,
    openExam,
    dismissExam,
    // Stats
    todayStats,
    liveProductivity,
    // Settings
    settings,
    updateSettings,
    // History
    history: state.history,
  };
}

export type UsePomodoroReturn = ReturnType<typeof usePomodoro>;