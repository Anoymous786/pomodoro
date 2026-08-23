import {
  DEFAULT_SETTINGS,
  DEFAULT_TIMER,
  PomodoroAppState,
  STORAGE_KEY,
  Task,
} from "./types";

/**
 * Normalizes a raw task from localStorage so it always has the
 * shape required by the current schema. This migrates data saved
 * before the task-driven timer update (where tasks only had
 * `completed: boolean` and no time estimate).
 */
function normalizeTask(raw: Partial<Task> & { completed?: boolean }): Task {
  const fallback = 25;
  return {
    id: typeof raw.id === "string" ? raw.id : String(Math.random()),
    name: typeof raw.name === "string" ? raw.name : "Untitled task",
    priority: raw.priority ?? "medium",
    estimated_minutes:
      typeof raw.estimated_minutes === "number" && raw.estimated_minutes > 0
        ? raw.estimated_minutes
        : fallback,
    is_completed:
      typeof raw.is_completed === "boolean"
        ? raw.is_completed
        : typeof raw.completed === "boolean"
        ? raw.completed
        : false,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    manual_minutes:
      typeof raw.manual_minutes === "number" && raw.manual_minutes > 0
        ? raw.manual_minutes
        : null,
    // Preserve per-task exam data across reloads (added schema v1.1).
    exam: raw.exam ?? null,
    examResult: raw.examResult ?? null,
  };
}

/**
 * Migrates the raw parsed state into the current shape.
 */
function normalizeState(parsed: Partial<PomodoroAppState>): Partial<PomodoroAppState> {
  const timer = parsed.timer ?? { ...DEFAULT_TIMER };
  return {
    ...parsed,
    timer: {
      mode: timer.mode ?? DEFAULT_TIMER.mode,
      isRunning: timer.isRunning ?? false,
      endTimestamp: timer.endTimestamp ?? null,
      completedWorkSessions: timer.completedWorkSessions ?? 0,
      activeTaskId: timer.activeTaskId ?? null,
      taskDurationMinutes: timer.taskDurationMinutes ?? null,
    },
    tasks: (parsed.tasks ?? []).map((t) => normalizeTask(t)),
  };
}

/**
 * Returns today's date as a local "YYYY-MM-DD" string.
 * Uses local time (not UTC) so the day rolls over at midnight
 * in the user's timezone.
 */
export function getTodayKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Returns a "YYYY-MM-DD" string for a given Date.
 */
export function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Creates a fresh, empty app state for a new day.
 * Tasks start empty; history is preserved.
 */
export function createEmptyState(
  history: PomodoroAppState["history"] = {}
): PomodoroAppState {
  return {
    activeDate: getTodayKey(),
    settings: { ...DEFAULT_SETTINGS },
    timer: { ...DEFAULT_TIMER },
    tasks: [],
    history,
    roadmaps: [],
    badges: [],
    activeRoadmapDay: null,
  };
}

/**
 * Loads the app state from localStorage.
 * If nothing is stored, returns a fresh state.
 * If the stored state is from a previous day, rolls the day over:
 *   - Logs the previous day's stats into history
 *   - Resets tasks and timer for the new day
 */
export function loadState(): PomodoroAppState {
  if (typeof window === "undefined") {
    return createEmptyState();
  }

  const todayKey = getTodayKey();

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return createEmptyState();
    }

    const parsed = normalizeState(
      JSON.parse(raw) as Partial<PomodoroAppState>
    );
    const settings = { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) };
    const history = parsed.history ?? {};
    const activeDate = parsed.activeDate ?? todayKey;

    // If the stored state belongs to a previous day, roll it over.
    if (activeDate !== todayKey) {
      // Log the previous day's stats into history before resetting.
      const prevTasks = parsed.tasks ?? [];
      const prevCompleted = prevTasks.filter((t) => t.is_completed).length;
      const prevSessions = parsed.timer?.completedWorkSessions ?? 0;
      const prevFocusMinutes = 0; // Not reliably reconstructable from a stale state.

      // We only log if we have meaningful activity to preserve.
      const prevStats = history[activeDate];
      if (!prevStats && (prevTasks.length > 0 || prevSessions > 0)) {
        history[activeDate] = {
          date: activeDate,
          sessions_count: prevSessions,
          focus_minutes: prevFocusMinutes,
          tasks_completed: prevCompleted,
          total_tasks: prevTasks.length,
          productivity: computeProductivity(
            prevCompleted,
            prevTasks.length,
            prevSessions,
            settings.dailySessionGoal
          ),
        };
      }

      // Reset for the new day.
      return {
        activeDate: todayKey,
        settings,
        timer: { ...DEFAULT_TIMER },
        tasks: [],
        history,
        roadmaps: parsed.roadmaps ?? [],
        badges: parsed.badges ?? [],
        activeRoadmapDay: null,
      };
    }

    return {
      activeDate,
      settings,
      timer: parsed.timer ?? { ...DEFAULT_TIMER },
      tasks: parsed.tasks ?? [],
      history,
      roadmaps: parsed.roadmaps ?? [],
      badges: parsed.badges ?? [],
      activeRoadmapDay: parsed.activeRoadmapDay ?? null,
    };
  } catch {
    return createEmptyState();
  }
}

/**
 * Persists the app state to localStorage.
 */
export function saveState(state: PomodoroAppState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage may be unavailable (private mode, quota). Fail silently.
  }
}

/**
 * Generates a unique id for tasks.
 */
export function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Computes the productivity percentage for a day.
 *
 * FORMULA (documented):
 *   productivity = 0.5 * (tasks_completed / total_tasks) * 100
 *                + 0.5 * (sessions_count / dailySessionGoal) * 100
 *
 * This is a weighted average where tasks and sessions each
 * contribute 50%. Each term is clamped to 100% so a single
 * strong metric can't exceed the total.
 */
export function computeProductivity(
  tasksCompleted: number,
  totalTasks: number,
  sessionsCount: number,
  dailySessionGoal: number
): number {
  const taskRatio = totalTasks > 0 ? tasksCompleted / totalTasks : 0;
  const sessionRatio = sessionsCount / dailySessionGoal;
  const raw =
    0.5 * Math.min(taskRatio, 1) * 100 + 0.5 * Math.min(sessionRatio, 1) * 100;
  return Math.round(raw);
}

/**
 * Builds a DayStats record for a given date from raw counters.
 */
export function buildDayStats(
  date: string,
  sessionsCount: number,
  focusMinutes: number,
  tasksCompleted: number,
  totalTasks: number,
  dailySessionGoal: number
): {
  date: string;
  sessions_count: number;
  focus_minutes: number;
  tasks_completed: number;
  total_tasks: number;
  productivity: number;
} {
  return {
    date,
    sessions_count: sessionsCount,
    focus_minutes: focusMinutes,
    tasks_completed: tasksCompleted,
    total_tasks: totalTasks,
    productivity: computeProductivity(
      tasksCompleted,
      totalTasks,
      sessionsCount,
      dailySessionGoal
    ),
  };
}

/**
 * Sorts history entries by date, most recent first.
 */
export function sortHistoryByDate(
  history: PomodoroAppState["history"]
): PomodoroAppState["history"][string][] {
  return Object.values(history).sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0
  );
}

/**
 * Helper to count how many tasks are marked complete.
 */
export function countCompletedTasks(tasks: Task[]): number {
  return tasks.filter((t) => t.is_completed).length;
}