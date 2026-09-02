"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Badge,
  DayStats,
  effectiveMinutes,
  deriveTimingOutcome,
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
  createEmptyState,
  generateId,
  getTodayKey,
  loadState,
  saveState,
} from "@/lib/storage";
import { Calibration, CompletedItem, EstimationRecord } from "@/lib/types";
import { computeCalibration } from "@/lib/calibration";
import {
  apiGet,
  apiPost,
  generateRoadmapRemote,
  isRemoteApi,
  logFocusSession,
} from "@/lib/api";
import { showToast } from "@/lib/toast";
import { fireCelebration } from "@/lib/confetti";
import { istTodayKey } from "@/lib/date-ist";
import {
  makeStep,
  moveRoadmapStep,
  type MoveDirection,
  syncCompletedDays,
  stepSimSeconds,
  isDayComplete,
  canStartStep,
  isStepStartable,
  stepLockReason,
  hasRealPractice,
  roadmapDayNumbers,
  dayStatus,
  taskStatus,
  dayAssessmentEligible,
  finalExamEligible,
} from "@/lib/task-roadmap";
import type {
  RoadmapStep,
  PracticeTask,
  RoadmapExamResult,
  RoadmapExamQuestion,
  SkillProfile,
  TaskAssessment,
  AssessmentAttempt,
} from "@/lib/types";
import { updateSkillProfile,
  skillProfilesFromRoadmapEvidence,
} from "@/lib/skills";
import { buildDemoState } from "@/lib/demo-fixture";
import {
  adoptRemoteTask,
  buildProgressDocPayload,
  mergeHydratedTask,
  progressSignature,
  taskFromProgressDoc,
} from "@/lib/progress-sync";
import {
  fetchProgressDocs,
  putProgressDoc,
  type ProgressDoc,
} from "@/lib/api";

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
  // HYDRATION SAFETY (root cause of the "stuck 1-error" pill on load):
  // This state was previously initialized with useState(() => loadState()),
  // which reads localStorage SYNCHRONOUSLY during the first client render.
  // The server/prerender always rendered the EMPTY default state, so any
  // saved data (tasks, roadmaps, badges, timer progress) made the hydrated
  // tree diverge from the prerendered HTML -> React logged a hydration
  // mismatch error on every page load, which the Next.js dev overlay showed
  // as a persistent error badge in the corner.
  //
  // Fix: render deterministically from the empty state first, then adopt
  // persisted state in a post-mount effect (standard two-pass pattern).
  const [state, setState] = useState<PomodoroAppState>(() =>
    createEmptyState(),
  );
  /** True once persisted localStorage state has been adopted post-mount. */
  const [hydrated, setHydrated] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());
  /**
   * Id of the task whose exam modal is currently open (null = closed).
   * UI-only state; the exam itself + result live on the Task in localStorage.
   */
  const [examTaskId, setExamTaskId] = useState<string | null>(null);
  /**
   * §11: the per-step check-in currently waiting to be answered. When a step is
   * completed (via timer finish or an explicit tick) the UI shows a shared
   * single-question modal; the step is only marked done once answered.
   */
  const [pendingCheckIn, setPendingCheckIn] = useState<{
    taskId: string;
    stepId: string;
    stepTitle: string;
    topic: string;
    completedBy: "timer" | "manual";
  } | null>(null);

  /**
      * §12: when every step of a roadmap is genuinely complete, a FULL-ROADMAP
   * mock exam (~20 MCQ) is pending. The workspace renders a modal to run it.
   */
  const [pendingRoadmapExam, setPendingRoadmapExam] = useState<null>(null);

  /**
   * PART 2 §2/§3: a Day Assessment (10-12 MCQs) is pending for this day.
   * Surfaced when a day's last step completes; the next day stays LOCKED
   * (server-authoritatively) until this is submitted.
   */
  const [dayAssessmentPending, setDayAssessmentPending] = useState<{
    taskId: string;
    dayNumber: number;
  } | null>(null);

  /**
   * PART 2 §7/§8: the currently active exam (Day Assessment or Final Exam)
   * driving the exam section. Draft answers persist via task.assessment.
   */
  const [activeExam, setActiveExam] = useState<{
    taskId: string;
    taskName: string;
    /** "day" | "final" */
    kind: "day" | "final";
    dayNumber?: number;
    questions: RoadmapExamQuestion[];
    /** PART 2 §8: persisted draft restored on resume — answers + position. */
    draftAnswers?: Record<string, string>;
    draftCurrent?: number;
  } | null>(null);



  // (Phase 4) Focus tracking — refs (not state) because they are written by
  // DOM/visibility events and read synchronously at session end, so they never
  // trigger re-renders. Tracking is cleared whenever there is no active work
  // session, and accumulated during a hidden-while-work-running spell.
  const focusSessionStartRef = useRef<number | null>(null);
  const focusHiddenStartRef = useRef<number | null>(null);
  const focusHiddenMsRef = useRef(0);
  const focusHiddenCountRef = useRef(0);
  const lastFocusResultRef = useRef<{
    focusPercent: number;
    distractions: number;
    distractionSeconds: number;
  } | null>(null);

  // Pass 2 (client-only): adopt persisted state AFTER the first paint.
  // Declared BEFORE the persist effect so the very first commit only LOADS,
  // never saves.
  useEffect(() => {
    setState(loadState());
    setHydrated(true);
    // §13 (item 5): when pointed at the deployed stack, pull the user's
    // DURABLE per-topic skill profile from the skill-profile Lambda
    // (DynamoDB `roadmaps` table, SKILL# item kind) and merge it over
    // anything stale in localStorage — scores persist across sessions
    // and devices, not just per-browser localStorage.
    if (isRemoteApi()) {
      apiGet("/api/skill-profile")
        .then(async (res) => {
          if (!res.ok) return;
          // The skill-profile Lambda returns { profiles: SkillProfile[] }.
          const data = (await res.json()) as { profiles?: SkillProfile[] };
          const remote = data.profiles;
          if (!Array.isArray(remote)) return;
          setState((prev) => {
            const local = prev.skillProfiles ?? {};
            const merged: Record<string, SkillProfile> = { ...local };
            let changed = false;
            for (const p of remote) {
              if (!p || typeof p !== "object" || !p.topic) continue;
              const cur = local[p.topic];
              // Newest write wins per topic; remote is the durable source.
              if (cur && cur.lastUpdated >= (p.lastUpdated ?? 0)) continue;
              merged[p.topic] = { ...p, lastUpdated: p.lastUpdated ?? 0 };
              changed = true;
            }
            if (!changed) return prev;
            return { ...prev, skillProfiles: merged };
          });
        })
        .catch(() => undefined); // best-effort; offline keeps local data
    }
  }, []);

  // Persist state to localStorage whenever it changes — but only after
  // hydration. Without this guard, the first commit (still holding the
  // empty default state) would overwrite the user's saved data before it
  // was ever loaded.
  useEffect(() => {
    if (!hydrated) return;
    saveState(state);
  }, [state, hydrated]);

  // ===================================================================
  // PHASE 2 — DURABLE PROGRESS SYNC (server = source of truth)
  // ===================================================================
  /** Latest practiceTasks for timers/callbacks (refs never go stale). */
  const practiceTasksRef = useRef(state.practiceTasks);
  practiceTasksRef.current = state.practiceTasks;

  /**
   * Per-task sync bookkeeping: last signature pushed/acknowledged and the
   * rev we believe the server holds. Kept OUT of React state so pushes
   * never re-trigger the effect that schedules them (no loops).
   */
  const sigRef = useRef<Map<string, string>>(new Map());
  const revRef = useRef<Map<string, number>>(new Map());
  /** taskId -> timeout for coalescing bursts into one push. */
  const pushTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  /** taskId -> true while a pushTaskNow is awaiting (prevents two pushes
   *  for the same task from racing on the same expectedRev, which would
   *  otherwise produce a spurious 409 that could re-adopt a stale doc). */
  const inFlightPushRef = useRef<Map<string, boolean>>(new Map());
  /** True once the initial server hydration has completed. */
  const remoteHydratedRef = useRef(false);

  /** Coalesced push: at most one PUT per task per ~1.5s burst window. */
  const schedulePush = useCallback((taskId: string, delay = 1500) => {
    const timers = pushTimerRef.current;
    if (timers.has(taskId)) return; // already scheduled
    const t = setTimeout(() => {
      timers.delete(taskId);
      void pushTaskNow(taskId);
    }, delay);
    timers.set(taskId, t);
  }, []);

  /**
   * Fire-and-forget conditional write of ONE task's progress doc.
   * On 409 the authoritative doc is re-fetched; if the server is genuinely
   * ahead we adopt it (except a locally running timer keeps its seconds),
   * otherwise a concurrent same-device push that won with a STALER snapshot
   * must NOT wipe richer local data — the local doc wins and is re-pushed
   * from the server's baseline rev (conflict-free upgrade).
   */
  const pushTaskNow = useCallback(async (taskId: string) => {
    if (!remoteHydratedRef.current) return;
    const inFlight = inFlightPushRef.current;
    if (inFlight.get(taskId)) {
      // Another push for this task is awaiting; a 2nd one with the same
      // expectedRev would race it into a spurious 409. Re-arm a short
      // timer instead — the change-driven effect re-fires once state lands.
      schedulePush(taskId, 300);
      return;
    }
    const task = practiceTasksRef.current.find((t) => t.id === taskId);
    if (!task) return;
    const payload = buildProgressDocPayload(task);
    const sig = progressSignature({ ...task, rev: undefined });
    if (sigRef.current.get(taskId) === sig) return; // nothing durable changed
    const expectedRev = revRef.current.get(taskId) ?? 0;
    inFlight.set(taskId, true);
    let res;
    try {
      res = await putProgressDoc(
        { taskId, rev: expectedRev, task: payload },
        expectedRev
      );
    } finally {
      inFlight.delete(taskId);
    }
    if (res.ok && res.doc) {
      revRef.current.set(taskId, res.doc.rev);
      sigRef.current.set(taskId, sig);
      // Stamp the acknowledged rev back onto the task in state so the
      // persisted localStorage copy tracks the server. Otherwise a reload
      // would re-hydrate with a STALE rev (the original adoption rev), the
      // remote doc's higher rev would win, and the server's older snapshot
      // could overwrite fresher local progress that the last push hadn't
      // yet landed (e.g. mid-run seconds rounded to 2s vs the final 7s).
      setState((prev) => ({
        ...prev,
        practiceTasks: prev.practiceTasks.map((t) =>
          t.id === taskId
            ? {
                ...t,
                rev: res.doc?.rev ?? t.rev,
                syncedAt: Date.now(),
              }
            : t,
        ),
      }));
      return;
    }
    if (res.conflict) {
      // A concurrent write advanced the doc first. Re-fetch the authoritative
      // version. If the server is genuinely ahead (higher rev, or a richer
      // snapshot) we adopt it; but if its doc is STALER than our local copy
      // (same-device concurrent push won with an older snapshot), keep local
      // and re-push from the server's baseline rev — never wipe richer data.
      const docs = await fetchProgressDocs();
      const remote = (docs ?? []).find((d) => d.taskId === taskId);
      const remoteTask = remote ? taskFromProgressDoc(remote) : null;
      const local = practiceTasksRef.current.find((t) => t.id === taskId) ?? task;
      if (!remoteTask) {
        revRef.current.delete(taskId); // gone: re-create on next push
        sigRef.current.delete(taskId);
        schedulePush(taskId, 300);
        return;
      }
      const resolved = mergeHydratedTask(local, remoteTask, remoteTask.rev ?? 1);
      const merged = resolved.task;
      // Record the SERVER's signature so an unchanged local copy isn't
      // re-pushed endlessly; only re-push when the winner is richer local.
      sigRef.current.set(
        taskId,
        progressSignature({ ...(remoteTask as PracticeTask), rev: undefined })
      );
      revRef.current.set(taskId, resolved.baselineRev);
      setState((prev) => ({
        ...prev,
        practiceTasks: prev.practiceTasks.map((t) =>
          t.id === taskId ? merged : t
        ),
      }));
      // If the resolved winner is our richer LOCAL copy, push it up from
      // the server baseline (rev already seeded) so the server converges.
      if (resolved.task === local) schedulePush(taskId, 300);
      return;
    }
    // Other failures (offline/5xx): signature untouched -> retried later.
  }, []);

  // Initial server hydration — runs ONCE, after localStorage adoption.
  // Remote docs with a higher rev than the local cache are authoritative
  // (localStorage is only an offline/UI cache); local-only tasks are
  // pushed up so no data is stranded per-device.
  useEffect(() => {
    if (!hydrated || remoteHydratedRef.current) return;
    let cancelled = false;
    (async () => {
      const docs = await fetchProgressDocs();
      if (cancelled) return;
      const remoteByTask = new Map<string, ProgressDoc>();
      for (const d of docs ?? []) {
        if (d && typeof d.taskId === "string") remoteByTask.set(d.taskId, d);
      }
      setState((prev) => {
        const localByTask = new Map(prev.practiceTasks.map((t) => [t.id, t]));
        const merged: PracticeTask[] = [];
        const seen = new Set<string>();
        remoteByTask.forEach((doc) => {
          const rt = taskFromProgressDoc(doc);
          if (!rt) return;
          const local = localByTask.get(doc.taskId);
          const resolved = mergeHydratedTask(local, rt, doc.rev ?? 1);
          merged.push(resolved.task);
          seen.add(doc.taskId);
          revRef.current.set(doc.taskId, resolved.baselineRev);
          // Mark adopted docs as already-synced so they are NOT pushed
          // back (which would overwrite server data with stale local).
          sigRef.current.set(
            doc.taskId,
            progressSignature({ ...rt, rev: undefined })
          );
        });
        // Local-only tasks are deliberately left OUT of sigRef so the
        // change-driven effect below schedules their first push (rev 0
        // create) once the merged state has rendered.
        for (const t of prev.practiceTasks) {
          if (!seen.has(t.id)) merged.push(t); // local-only task
        }
        return { ...prev, practiceTasks: merged };
      });
      remoteHydratedRef.current = true;
    })().catch(() => {
      // Offline / endpoint unavailable: stay on the localStorage cache.
      remoteHydratedRef.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, [hydrated, pushTaskNow]);

  /**
   * Change-driven sync: after every meaningful state change, compare each
   * task's durable signature against the last pushed one and schedule a
   * coalesced push. This single effect covers ALL required persistence
   * moments: timer events (practicedSeconds/startedAt/timerStatus), step
   * completion (isDone), question submission (step.checkIn), day
   * assessment results (examResult / timingRecord on the steps), day
   * unlock (dayNumber changes), and task changes (name/dates/duration/
   * roadmap edits). Pure-UI state (e.g. the 500ms clock tick) does not
   * change the signature, so it never triggers a push.
   */
  useEffect(() => {
    if (!hydrated) return;
    if (!remoteHydratedRef.current) return; // wait for hydrate
    for (const t of state.practiceTasks) {
      const sig = progressSignature({ ...t, rev: undefined });
      if (sigRef.current.get(t.id) !== sig) {
        schedulePush(t.id);
      }
    }
  }, [state.practiceTasks, hydrated, schedulePush]);

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

  // (Phase 4) Live focus score — track how much of the active work session is
  // spent with the tab hidden/backgrounded using the Page Visibility API.
  // Detection is 100% client-side (no backend call); the score is persisted to
  // DynamoDB at session end via completeSession. Refs rather than state so the
  // DOM events never force re-renders.
  useEffect(() => {
    const activeWork = state.timer.mode === "work" && state.timer.isRunning;
    if (!activeWork) {
      // No active work session: clear accumulated focus tracking so the next
      // session records only its OWN distractions.
      focusSessionStartRef.current = null;
      focusHiddenStartRef.current = null;
      focusHiddenMsRef.current = 0;
      focusHiddenCountRef.current = 0;
      return;
    }

    // A work session is running. If we are just now entering one, snapshot its
    // start time; also seed "hidden at session start" so a user who begins the
    // session and immediately tabs away is accounted for.
    if (focusSessionStartRef.current === null) {
      focusSessionStartRef.current = Date.now();
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        focusHiddenStartRef.current = Date.now();
      }
    }

    const onVisibility = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState === "hidden") {
        if (focusHiddenStartRef.current === null) {
          focusHiddenStartRef.current = Date.now();
        }
      } else {
        if (focusHiddenStartRef.current !== null) {
          focusHiddenMsRef.current += Date.now() - focusHiddenStartRef.current;
          focusHiddenStartRef.current = null;
          focusHiddenCountRef.current += 1;
        }
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.timer.mode, state.timer.isRunning]);

  // ---- Derived values ----

  const settings = state.settings;
  const timer = state.timer;
  const tasks = state.tasks;

  const durationMs = getTimerDurationMs(timer, settings);
  // BUG #1 fix: a paused countdown must FREEZE on the preserved `pausedMs`
  // (the exact remaining captured at pause time) and NOT keep draining
  // against the stale `endTimestamp`. The `now` interval ticks in the
  // background regardless of running state (see the interval below), so
  // without this guard the dashboard display silently counts down while
  // paused. startTimer/startTask rebuild endTimestamp = now + pausedMs on
  // resume, so the frozen slice is honored. completeSession/null endTimestamp
  // + null pausedMs leaves the idle state showing the full duration.
  const pausedRemaining = !timer.isRunning ? (timer.pausedMs ?? 0) : 0;
  const remainingMs =
    pausedRemaining > 0
      ? Math.max(0, pausedRemaining)
      : timer.endTimestamp
        ? Math.max(0, timer.endTimestamp - now)
        : durationMs;
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  const displayTime = `${String(minutes).padStart(2, "0")}:${String(
    seconds,
  ).padStart(2, "0")}`;

  const tasksCompleted = countCompletedTasks(tasks);
  const totalTasks = tasks.length;

  const activeTask = timer.activeTaskId
    ? (tasks.find((t) => t.id === timer.activeTaskId) ?? null)
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
    settings.dailySessionGoal,
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
          ctx.currentTime + start + 0.02,
        );
        gain.gain.exponentialRampToValueAtTime(
          0.001,
          ctx.currentTime + start + duration,
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
    [playChime],
  );

  /**
   * Starts a work session for the given task. The countdown uses that
   * task's effective minutes (manual override ?? AI estimate).
   *
   * Phase A3: if this is a resume of a PAUSED run of the SAME active task,
   * it continues from the preserved remaining time instead of silently
   * restarting from zero. Records `lastStartedAt` on the task so Phase C can
   * measure real minutes spent.
   */
  const startTask = useCallback(
    (taskId: string) => {
      requestNotificationPermission();
      setState((prev) => {
        const task = prev.tasks.find((t) => t.id === taskId) ?? null;
        const now = Date.now();
        const isResume =
          !!task &&
          prev.timer.activeTaskId === taskId &&
          (prev.timer.pausedMs ?? 0) > 0;
        const taskMinutes = task
          ? effectiveMinutes(task.estimated_minutes, task.manual_minutes)
          : prev.settings.workMinutes;
        const fullMs = taskMinutes * 60 * 1000;
        const remaining = isResume ? (prev.timer.pausedMs ?? fullMs) : fullMs;
        return {
          ...prev,
          tasks: task
            ? prev.tasks.map((t) =>
                t.id === task.id
                  ? { ...t, lastStartedAt: t.lastStartedAt ?? now }
                  : t,
              )
            : prev.tasks,
          timer: {
            ...prev.timer,
            mode: "work",
            isRunning: true,
            endTimestamp: now + remaining,
            activeTaskId: task ? task.id : null,
            taskDurationMinutes: taskMinutes,
            pausedMs: null,
            runStartAt: now,
          },
        };
      });
    },
    [requestNotificationPermission],
  );

  /**
   * Starts the timer for the currently selected task (or, in break
   * mode, just starts the break countdown). Phase A3: resumes a paused
   * run from its preserved remaining time rather than restarting.
   */
  const startTimer = useCallback(() => {
    requestNotificationPermission();
    setState((prev) => {
      const now = Date.now();
      const task = prev.timer.activeTaskId
        ? (prev.tasks.find((t) => t.id === prev.timer.activeTaskId) ?? null)
        : null;

      if (prev.timer.mode === "work" && task) {
        // Task-driven work session (possibly a resume).
        const taskMinutes = effectiveMinutes(
          task.estimated_minutes,
          task.manual_minutes,
        );
        const fullMs = taskMinutes * 60 * 1000;
        const remaining =
          (prev.timer.pausedMs ?? 0) > 0
            ? (prev.timer.pausedMs ?? fullMs)
            : fullMs;
        return {
          ...prev,
          tasks: prev.tasks.map((t) =>
            t.id === task.id
              ? { ...t, lastStartedAt: t.lastStartedAt ?? now }
              : t,
          ),
          timer: {
            ...prev.timer,
            mode: "work",
            isRunning: true,
            endTimestamp: now + remaining,
            activeTaskId: task.id,
            taskDurationMinutes: taskMinutes,
            pausedMs: null,
            runStartAt: now,
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
          endTimestamp: now + durationMs,
          pausedMs: null,
          runStartAt: now,
        },
      };
    });
  }, [requestNotificationPermission]);

  /**
   * Phase A3: reliably pauses a running timer — preserves the exact remaining
   * countdown (`pausedMs`) and folds the just-running slice into `accruedMs`
   * so the task's real minutes-spent are never lost across pause/resume.
   */
  const pauseTimer = useCallback(() => {
    setState((prev) => {
      if (!prev.timer.isRunning || prev.timer.endTimestamp === null) {
        return prev;
      }
      const now = Date.now();
      const remaining = Math.max(0, prev.timer.endTimestamp - now);
      const slice =
        prev.timer.runStartAt != null
          ? Math.max(0, now - prev.timer.runStartAt)
          : 0;
      return {
        ...prev,
        timer: {
          ...prev.timer,
          isRunning: false,
          pausedMs: remaining,
          accruedMs: (prev.timer.accruedMs ?? 0) + slice,
          runStartAt: null,
        },
      };
    });
  }, []);

  /**
   * Phase A3: fully stops and clears the timer (resets remaining + accrual so
   * the next start begins fresh). Does NOT touch the task's completion state —
   * clearing the timer alone never marks a task done.
   */
  const resetTimer = useCallback(() => {
    setState((prev) => ({
      ...prev,
      timer: {
        ...prev.timer,
        isRunning: false,
        endTimestamp: null,
        pausedMs: null,
        accruedMs: 0,
        runStartAt: null,
      },
    }));
  }, []);

  // §P4 Keyboard shortcuts: Space = start/pause the timer, R = reset.
  // Only active when focus isn't in a text input/textarea/contenteditable
  // to avoid conflicts with typing.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const editable =
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        target?.isContentEditable === true;
      if (editable) return;

      if (e.code === "Space") {
        e.preventDefault();
        if (state.timer.isRunning) {
          pauseTimer();
        } else {
          startTimer();
        }
      } else if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        resetTimer();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.timer.isRunning, pauseTimer, startTimer, resetTimer]);

  const completeSession = useCallback(() => {
    // Phase D: the task finished by a real timer run — its exam should pop up
    // immediately. Capture the id BEFORE the async updater (same stable read
    // pattern used for the focus result).
    const completedTaskId =
      state.timer.mode === "work" && state.timer.isRunning
        ? state.timer.activeTaskId
        : null;

    // (Phase 4) Pre-compute the focus result for a finishing WORK session
    // BEFORE the asynchronous setState updater runs, so both the estimation
    // record and the session-end report read the SAME values regardless of
    // when React materializes the updater. Refs are stable across renders.
    let focusResult: {
      focusPercent: number;
      distractionSeconds: number;
      distractions: number;
    } | null = null;
    if (state.timer.mode === "work" && state.timer.isRunning) {
      // Flush any in-progress hidden spell, then derive 0-100 focus %.
      if (focusHiddenStartRef.current !== null) {
        focusHiddenMsRef.current += Date.now() - focusHiddenStartRef.current;
        focusHiddenStartRef.current = null;
        focusHiddenCountRef.current += 1;
      }
      const sessionMinutes =
        state.timer.taskDurationMinutes ?? state.settings.workMinutes;
      const sessionSeconds = sessionMinutes * 60;
      const focusPercent =
        sessionSeconds > 0
          ? Math.max(
              0,
              Math.min(
                100,
                Math.round(
                  100 * (1 - focusHiddenMsRef.current / sessionSeconds),
                ),
              ),
            )
          : 100;
      focusResult = {
        focusPercent,
        distractionSeconds: Math.round(focusHiddenMsRef.current / 1000),
        distractions: focusHiddenCountRef.current,
      };
      lastFocusResultRef.current = focusResult;
    }

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

        // Mark the active task complete (if any). Also record Phase C timing:
        // real minutes spent (across pauses) and the derived outcome against
        // the estimate (±10% tolerance band).
        if (timer.activeTaskId) {
          const finishedTask = tasks.find((t) => t.id === timer.activeTaskId);
          const viaTimer = true;
          const startedAt = finishedTask?.lastStartedAt ?? timer.runStartAt;
          const nowMs = Date.now();
          const runSlice =
            timer.runStartAt != null
              ? Math.max(0, nowMs - timer.runStartAt)
              : 0;
          const elapsedMs =
            (timer.accruedMs ?? 0) +
            runSlice +
            (viaTimer && startedAt && !timer.runStartAt
              ? Math.max(0, nowMs - startedAt)
              : 0);
          const estimated = finishedTask
            ? effectiveMinutes(
                finishedTask.estimated_minutes,
                finishedTask.manual_minutes,
              )
            : (timer.taskDurationMinutes ?? settings.workMinutes);
          const actualMinutes = Math.max(
            0,
            Math.round(
              (elapsedMs > 0
                ? elapsedMs
                : (timer.taskDurationMinutes ?? 0) * 60 * 1000) / 60000,
            ),
          );
          const outcome = deriveTimingOutcome(estimated, actualMinutes);

          nextTasks = tasks.map((t) =>
            t.id === timer.activeTaskId
              ? {
                  ...t,
                  is_completed: true,
                  actual_minutes: actualMinutes,
                  timing_outcome: outcome,
                  timingRecord: {
                    estimated_minutes: estimated,
                    actual_minutes: actualMinutes,
                    timing_outcome: outcome,
                    startedAt: startedAt ?? null,
                    completedAt: nowMs,
                  },
                }
              : t,
          );
        }

        // Auto-advance to the next incomplete task in the queue.
        const activeIdx = nextTasks.findIndex(
          (t) => t.id === timer.activeTaskId,
        );
        const nextTask =
          nextTasks.find((t, idx) => idx > activeIdx && !t.is_completed) ??
          nextTasks.find((t, idx) => idx <= activeIdx && !t.is_completed) ??
          null;

        nextActiveTaskId = nextTask ? nextTask.id : null;
        nextTaskDurationMinutes = nextTask
          ? effectiveMinutes(
              nextTask.estimated_minutes,
              nextTask.manual_minutes,
            )
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
        settings.dailySessionGoal,
      );

      // Adaptive time estimation (Phase 2): log the observed
      // actual-vs-estimated sample when a task-driven work session ends,
      // so future LLM estimates calibrate to the user's real pace.
      let estimationLog = prev.estimationLog;
      if (timer.mode === "work" && timer.activeTaskId) {
        const completedTask = tasks.find((t) => t.id === timer.activeTaskId);
        if (completedTask) {
          const est = effectiveMinutes(
            completedTask.estimated_minutes,
            completedTask.manual_minutes,
          );
          // Credit the focused minutes for the session that actually ran
          // (mirrors the work-branch formula above).
          const actualMinutes =
            timer.taskDurationMinutes ?? settings.workMinutes;
          const record: EstimationRecord = {
            taskId: completedTask.id,
            taskName: completedTask.name,
            estimated_minutes: est,
            actual_minutes: actualMinutes,
            ratio: est > 0 ? actualMinutes / est : 1,
            completedAt: Date.now(),
            // (Phase 4) Attach the focus measurement for this sample (if a
            // work session just ended), so calibration also sees focus.
            ...(lastFocusResultRef.current
              ? {
                  focus_percent: lastFocusResultRef.current.focusPercent,
                  distraction_count: lastFocusResultRef.current.distractions,
                }
              : {}),
            ...(prev.activeRoadmapDay
              ? {
                  roadmapId: prev.activeRoadmapDay.roadmapId,
                  dayNumber: prev.activeRoadmapDay.dayNumber,
                }
              : {}),
          };
          estimationLog = [...(prev.estimationLog ?? []), record];
        }
      }

      // Mirror this session's completion onto the roadmap document and the
      // per-day completed-task log (History jump-back source of truth).
      let nextRoadmaps = prev.roadmaps;
      const justDoneName =
        timer.mode === "work" && timer.activeTaskId
          ? nextTasks.find((t) => t.id === timer.activeTaskId)?.name
          : undefined;
      if (justDoneName && prev.activeRoadmapDay) {
        const ar = prev.activeRoadmapDay;
        nextRoadmaps = nextRoadmaps.map((r) =>
          r.id === ar.roadmapId
            ? {
                ...r,
                days: r.days.map((d) =>
                  d.day_number === ar.dayNumber
                    ? {
                        ...d,
                        tasks: d.tasks.map((rt) =>
                          rt.name.toLowerCase() === justDoneName.toLowerCase()
                            ? { ...rt, is_done: true }
                            : rt,
                        ),
                      }
                    : d,
                ),
              }
            : r,
        );
      }
      const completedItems: CompletedItem[] = [
        ...(prevStats.completed_items ?? []),
      ];
      if (
        justDoneName &&
        !completedItems.some(
          (c) => c.name.toLowerCase() === justDoneName.toLowerCase(),
        )
      ) {
        completedItems.push({
          name: justDoneName,
          ...(prev.activeRoadmapDay
            ? {
                roadmapId: prev.activeRoadmapDay.roadmapId,
                dayNumber: prev.activeRoadmapDay.dayNumber,
              }
            : {}),
        });
      }

      return {
        ...prev,
        tasks: nextTasks,
        roadmaps: nextRoadmaps,
        timer: {
          mode: nextMode,
          isRunning: false,
          endTimestamp: null,
          completedWorkSessions,
          activeTaskId: nextActiveTaskId,
          taskDurationMinutes: nextTaskDurationMinutes,
          pausedMs: null,
          accruedMs: 0,
          runStartAt: null,
        },
        history: {
          ...history,
          [todayKey]: { ...updatedStats, completed_items: completedItems },
        },
        estimationLog,
      };
    });

    // Phase D: auto-open the exam for the task that just genuinely finished via
    // its timer. The modal reads the task's timing outcome to tailor the prompt.
    if (completedTaskId) {
      setExamTaskId(completedTaskId);
    }

    // Fire notification + sound for the session that just ended.
    notify(state.timer.mode);

    // (Phase 4) Session-end focus reporting: show the score and persist it to
    // the focus_sessions table. Best-effort; never blocks or surfaces errors.
    const focus = focusResult;
    if (focus) {
      const focused = focus.focusPercent >= 97;
      const ep =
        focus.distractions === 0
          ? "no distractions"
          : `${focus.distractions} ${focus.distractions === 1 ? "short distraction" : "short distractions"}`;
      showToast(
        `${focus.focusPercent}% focused — ${ep}`,
        focused ? "success" : "info",
      );
      void logFocusSession({
        taskName: state.timer.activeTaskId
          ? (tasks.find((t) => t.id === state.timer.activeTaskId)?.name ?? null)
          : null,
        mode: state.timer.mode,
        durationMinutes:
          state.timer.taskDurationMinutes ?? state.settings.workMinutes,
        distractions: focus.distractions,
        distractionSeconds: focus.distractionSeconds,
        focusPercent: focus.focusPercent,
      });
      // Reset the focus ref so the NEXT work session starts clean (the Page
      // Visibility effect also clears it when no work session is active).
      lastFocusResultRef.current = null;
    }
  }, [
    notify,
    state.timer.mode,
    state.timer.isRunning,
    state.timer.activeTaskId,
    state.timer.taskDurationMinutes,
    state.settings,
    tasks,
  ]);

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
                prev.settings.dailySessionGoal,
              ),
            }
          : buildDayStats(
              todayKey,
              0,
              0,
              0,
              nextTasks.length,
              prev.settings.dailySessionGoal,
            );
        return {
          ...prev,
          tasks: nextTasks,
          history: { ...prev.history, [todayKey]: updatedStats },
        };
      });
    },
    [],
  );

  const toggleTask = useCallback(
    (id: string) => {
      // v3 UX: checkbox "Mark Done" is a manual check-in — it mirrors
      // completion onto the active roadmap day + the shared daily record,
      // but deliberately does NOT open the post-task exam. The exam auto-
      // opens only on a genuine timer-reached-zero completion (completeSession).
      const target = state.tasks.find((t) => t.id === id);

      setState((prev) => {
        const nextTasks = prev.tasks.map((t) =>
          t.id === id ? { ...t, is_completed: !t.is_completed } : t,
        );
        const todayKey = getTodayKey();
        const prevStats = prev.history[todayKey];
        const completed = countCompletedTasks(nextTasks);
        // v2 Fix 5: manual check-off (no running timer) still logs the
        // task's effective minutes as focus time on today's SHARED record,
        // so History / heatmap / weekly chart never show "0 min" beside
        // real completed work. Un-checking removes the credit again.
        const toggledNow = nextTasks.find((t) => t.id === id);
        const creditMin =
          toggledNow && !prev.timer.isRunning
            ? effectiveMinutes(
                toggledNow.estimated_minutes,
                toggledNow.manual_minutes,
              )
            : 0;
        const focusMinutesNow = Math.max(
          0,
          (prevStats?.focus_minutes ?? 0) +
            (toggledNow?.is_completed ? creditMin : -creditMin),
        );
        const sessionsCountNow = prevStats?.sessions_count ?? 0;
        const updatedStats: DayStats = buildDayStats(
          todayKey,
          sessionsCountNow,
          focusMinutesNow,
          completed,
          nextTasks.length,
          prev.settings.dailySessionGoal,
        );

        // Mirror manual toggles onto the roadmap document (is_done) so task
        // progress survives leaving/re-entering the day.
        const toggledTask = nextTasks.find((t) => t.id === id);
        let roadmaps = prev.roadmaps;
        if (toggledTask && prev.activeRoadmapDay) {
          const ar = prev.activeRoadmapDay;
          roadmaps = roadmaps.map((r) =>
            r.id === ar.roadmapId
              ? {
                  ...r,
                  days: r.days.map((d) =>
                    d.day_number === ar.dayNumber
                      ? {
                          ...d,
                          tasks: d.tasks.map((rt) =>
                            rt.name.toLowerCase() ===
                            toggledTask.name.toLowerCase()
                              ? { ...rt, is_done: toggledTask.is_completed }
                              : rt,
                          ),
                        }
                      : d,
                  ),
                }
              : r,
          );
        }
        let badges = prev.badges;
        const active = prev.activeRoadmapDay;

        if (
          active &&
          nextTasks.length > 0 &&
          nextTasks.every((t) => t.is_completed)
        ) {
          const roadmap = roadmaps.find((r) => r.id === active.roadmapId);
          if (roadmap) {
            const days = roadmap.days.map((d) =>
              d.day_number === active.dayNumber
                ? { ...d, is_completed: true }
                : d,
            );
            const allDaysDone = days.every((d) => d.is_completed);
            let status: Roadmap["status"] = "in_progress";

            if (allDaysDone) {
              status = "completed";
              const alreadyUnlocked = badges.some(
                (b) => b.title === roadmap.badge_reward.title,
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
              r.id === active.roadmapId ? { ...r, days, status } : r,
            );
          }
        }

        // Day log: add/remove this task's clickable History entry.
        const baseItems = updatedStats.completed_items ?? [];
        const nextItems = toggledTask?.is_completed
          ? baseItems.some(
              (c) => c.name.toLowerCase() === toggledTask.name.toLowerCase(),
            )
            ? baseItems
            : [
                ...baseItems,
                {
                  name: toggledTask.name,
                  ...(prev.activeRoadmapDay
                    ? {
                        roadmapId: prev.activeRoadmapDay.roadmapId,
                        dayNumber: prev.activeRoadmapDay.dayNumber,
                      }
                    : {}),
                },
              ]
          : baseItems.filter(
              (c) =>
                c.name.toLowerCase() !==
                (toggledTask?.name ?? "").toLowerCase(),
            );

        return {
          ...prev,
          tasks: nextTasks,
          history: {
            ...prev.history,
            [todayKey]: { ...updatedStats, completed_items: nextItems },
          },
          roadmaps,
          badges,
        };
      });

      // v3 UX: no exam is opened for a checkbox completion — see the note
      // above. The post-task exam only auto-opens from completeSession (the
      // timer actually reaching zero), so a manual check-off is just a
      // check-in without a forced quiz.
    },
    [state],
  );

  const editTask = useCallback(
    (id: string, name: string, priority: Priority) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      setState((prev) => ({
        ...prev,
        tasks: prev.tasks.map((t) =>
          t.id === id ? { ...t, name: trimmed, priority } : t,
        ),
      }));
    },
    [],
  );

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
              prev.settings.dailySessionGoal,
            ),
          }
        : buildDayStats(
            todayKey,
            0,
            0,
            completed,
            nextTasks.length,
            prev.settings.dailySessionGoal,
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
        t.id === id ? { ...t, manual_minutes: m } : t,
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
                i === idx ? { ...rt, manual_minutes: m } : rt,
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
      minutes: number | null,
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
                i === taskIndex ? { ...rt, manual_minutes: m } : rt,
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
            i === taskIndex ? { ...t, manual_minutes: m } : t,
          );
        }

        return { ...prev, roadmaps, tasks: nextTasks };
      });
    },
    [],
  );

  // ---- Roadmap actions ----

  /**
   * Calls the LLM API to generate a roadmap for a topic and
   * saves it to state. Returns the new roadmap or throws.
   */
  const generateRoadmap = useCallback(
    async (topic: string, context?: IntakeContext) => {
      // Adaptive time estimation (Phase 2): attach the user's observed pace
      // so the roadmap's time estimates calibrate to reality.
      const calib = computeCalibration(state.estimationLog ?? []);
      const ctxWithCalibration:
        (IntakeContext & { calibration?: Calibration }) | undefined = calib
        ? { ...(context ?? {}), topic, calibration: calib }
        : context;

      let data: { roadmap?: Roadmap; error?: string };
      if (isRemoteApi()) {
        // Deployed path (Phase 4): enqueue on SQS, then poll the
        // DynamoDB-backed status endpoint until the worker finishes.
        const ready = await generateRoadmapRemote(topic, ctxWithCalibration);
        data = ready
          ? { roadmap: ready as unknown as Roadmap }
          : { error: "Failed to generate roadmap." };
      } else {
        // Local dev path: original synchronous Next.js route handler.
        const res = await fetch("/api/generate-roadmap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic, context: ctxWithCalibration }),
        });
        data = (await res.json()) as { roadmap?: Roadmap; error?: string };
        if (!res.ok || !data.roadmap) {
          throw new Error(data.error ?? "Failed to generate roadmap.");
        }
      }

      const raw = data.roadmap;
      if (!raw) {
        throw new Error(data.error ?? "Failed to generate roadmap.");
      }

      const roadmap: Roadmap = {
        ...raw,
        id: generateId(),
        status: "in_progress",
        createdAt: Date.now(),
        days: raw.days.map((day) => ({
          ...day,
          is_completed: false,
          // §5.1 Curated per-day references from the LLM (sanitized; omitted
          // entries are simply absent rather than rendered as placeholders).
          references: Array.isArray(day.references)
            ? day.references
                .filter(
                  (r): r is NonNullable<typeof r> =>
                    !!r &&
                    typeof r.url === "string" &&
                    /^https?:\/\//i.test(r.url) &&
                    typeof r.title === "string",
                )
                .map((r) => ({
                  type:
                    r.type === "video" || r.type === "docs"
                      ? r.type
                      : "article",
                  title: r.title.slice(0, 160),
                  url: r.url,
                  ...(typeof r.channel === "string"
                    ? { channel: r.channel.slice(0, 80) }
                    : {}),
                }))
            : [],
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
    // Calibration depends on the estimation log, so regenerating a fresh
    // roadmap always reflects the latest observed pace.
    [state.estimationLog],
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
        // Restore mirrored completion state so re-entering a day shows
        // real progress instead of resetting everything to not-started.
        is_completed: t.is_done ?? false,
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
                firstIncomplete.manual_minutes,
              )
            : null,
          pausedMs: null,
          accruedMs: 0,
          runStartAt: null,
        },
      };
    });
  }, []);

  /**
   * Resume-where-you-left-off (History → task click): loads a roadmap day
   * WITHOUT hijacking a running timer, restoring each task's mirrored
   * completion state. Returns false (with a toast) when blocked.
   */
  const jumpToRoadmapTask = useCallback(
    (roadmapId: string, dayNumber: number): boolean => {
      if (state.timer.isRunning) {
        showToast(
          "Pause or reset the current session before switching days.",
          "error",
        );
        return false;
      }
      setState((prev) => {
        const roadmap = prev.roadmaps.find((r) => r.id === roadmapId);
        const day = roadmap?.days.find((d) => d.day_number === dayNumber);
        if (!roadmap || !day) return prev;

        const newTasks: Task[] = day.tasks.map((t) => ({
          id: generateId(),
          name: t.name,
          priority: t.priority.toLowerCase() as Priority,
          estimated_minutes: t.estimated_minutes ?? 25,
          is_completed: t.is_done ?? false,
          createdAt: Date.now(),
          manual_minutes: t.manual_minutes ?? null,
        }));
        const firstOpen = newTasks.find((t) => !t.is_completed) ?? null;

        return {
          ...prev,
          tasks: newTasks,
          activeRoadmapDay: { roadmapId, dayNumber },
          timer: {
            ...prev.timer,
            mode: "work",
            isRunning: false,
            endTimestamp: null,
            activeTaskId: firstOpen ? firstOpen.id : null,
            taskDurationMinutes: firstOpen
              ? effectiveMinutes(
                  firstOpen.estimated_minutes,
                  firstOpen.manual_minutes,
                )
              : null,
            pausedMs: null,
            accruedMs: 0,
            runStartAt: null,
          },
        };
      });
      return true;
    },
    [state.timer.isRunning],
  );

  /**
   * Marks a roadmap day as completed and, if all days are done,
   * marks the roadmap completed and unlocks its badge.
   * §P4: fires confetti when the full roadmap hits 100%.
   */
  const completeRoadmapDay = useCallback(
    (roadmapId: string, dayNumber: number) => {
      let reachedFullCompletion = false;
      setState((prev) => {
        const roadmap = prev.roadmaps.find((r) => r.id === roadmapId);
        if (!roadmap) return prev;

        const days = roadmap.days.map((d) =>
          d.day_number === dayNumber ? { ...d, is_completed: true } : d,
        );
        const allDaysDone = days.every((d) => d.is_completed);

        let badges = prev.badges;
        let status: Roadmap["status"] = "in_progress";

        if (allDaysDone) {
          status = "completed";
          reachedFullCompletion = true;
          const alreadyUnlocked = badges.some(
            (b) => b.title === roadmap.badge_reward.title,
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
          r.id === roadmapId ? { ...r, days, status } : r,
        );

        return {
          ...prev,
          roadmaps: updatedRoadmaps,
          badges,
        };
      });
      // §P4: confetti when the whole roadmap is finally complete.
      if (reachedFullCompletion) {
        fireCelebration();
      }
    },
    [],
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

      // §4.2 context: which topic this day belongs to (sent to the endpoint).
      const replanRoadmap = state.roadmaps.find((r) => r.id === roadmapId);

      // Source tasks: prefer the working list if the day is loaded,
      // otherwise use the roadmap day directly.
      // Source snapshot WITH completion/override metadata: feeds richer AI
      // context AND lets us faithfully restore user tweaks after the re-plan.
      const sourceMeta: {
        name: string;
        priority: Priority;
        effective: number;
        done: boolean;
        manual: number | null;
      }[] = isActive
        ? state.tasks.map((t) => ({
            name: t.name,
            priority: t.priority,
            effective: effectiveMinutes(t.estimated_minutes, t.manual_minutes),
            done: t.is_completed,
            manual: t.manual_minutes,
          }))
        : (() => {
            const roadmap = state.roadmaps.find((r) => r.id === roadmapId);
            const day = roadmap?.days.find((d) => d.day_number === dayNumber);
            return (day?.tasks ?? []).map((t) => ({
              name: t.name,
              priority: t.priority.toLowerCase() as Priority,
              effective: effectiveMinutes(
                t.estimated_minutes,
                t.manual_minutes,
              ),
              done: t.is_done ?? false,
              manual: t.manual_minutes,
            }));
          })();

      const sourceTasks = sourceMeta.map((m) => ({
        name: m.name,
        priority: m.priority,
        estimated_minutes: m.effective,
      }));

      if (sourceTasks.length === 0) {
        throw new Error("This day has no tasks to re-plan.");
      }

      // The user's edited time budget = sum of effective minutes
      // (manual overrides win, otherwise the AI estimate).
      const budgetMinutes = sourceTasks.reduce(
        (sum, t) => sum + (t.estimated_minutes || 0),
        0,
      );

      // Adaptive time estimation (Phase 2): fold the user's recent pace into
      // the re-plan so the AI scales task estimates to their true speed.
      const calib = computeCalibration(state.estimationLog ?? []);

      // Re-plan context (§2.2/§4): already-done tasks, time already spent on
      // this day (from logged focus sessions), and hand-tuned estimates.
      const completedNames = sourceMeta
        .filter((m) => m.done)
        .map((m) => m.name);
      const lockedNames = sourceMeta
        .filter((m) => m.manual != null)
        .map((m) => m.name);
      const spentMinutes = (state.estimationLog ?? [])
        .filter((e) => e.roadmapId === roadmapId && e.dayNumber === dayNumber)
        .reduce((s, e) => s + (e.actual_minutes || 0), 0);

      const res = await apiPost("/api/replan-day", {
        // §4.2: the endpoint receives full context — which topic/day is being
        // re-planned, what's already done, and how much time was logged.
        topic: replanRoadmap?.topic_name ?? "",
        day_number: dayNumber,
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
        ...(calib ? { calibration: calib } : {}),
        ...(completedNames.length ? { completed_tasks: completedNames } : {}),
        ...(spentMinutes > 0 ? { spent_minutes: spentMinutes } : {}),
        ...(lockedNames.length ? { locked_tasks: lockedNames } : {}),
      });

      const data = (await res.json()) as {
        tasks?: {
          name: string;
          priority: "High" | "Medium" | "Low";
          estimated_minutes: number;
          /** (Phase 3) Optional AI one-line reason from the re-plan. */
          reason?: string;
        }[];
        error?: string;
      };

      if (!res.ok || !data.tasks) {
        throw new Error(data.error ?? "Failed to re-plan tasks.");
      }

      // Map the LLM's task priority back to lowercase Task priority.
      const toPriority = (p: "High" | "Medium" | "Low"): Priority =>
        p === "High" ? "high" : p === "Medium" ? "medium" : "low";

      // Name-normalised lookups: a re-plan must never lose user state.
      const norm = (s: string) => s.trim().toLowerCase();
      const doneByName = new Map(
        sourceMeta.map((m) => [norm(m.name), m.done] as const),
      );
      const manualByName = new Map(
        sourceMeta
          .filter((m) => m.manual != null)
          .map((m) => [norm(m.name), m.manual as number] as const),
      );
      const newTasks: Task[] = data.tasks.map((newTask) => {
        const key = norm(newTask.name);
        return {
          id: generateId(),
          name: newTask.name,
          priority: toPriority(newTask.priority),
          estimated_minutes: Math.max(1, Math.round(newTask.estimated_minutes)),
          is_completed: doneByName.get(key) ?? false,
          createdAt: Date.now(),
          // §4: manual overrides survive re-plans unless the user explicitly
          // re-plans that task by editing it again.
          manual_minutes: manualByName.get(key) ?? null,
        };
      });

      // Captured outside callbacks: TS can't keep the throw-guard narrowing
      // inside applyToRoadmaps' closure.
      const plannedTasks = data.tasks ?? [];

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
              const newDayTasks: RoadmapTask[] = plannedTasks.map((nt) => {
                const k = norm(nt.name);
                const src = plannedTasks.find(
                  (n) => n.name.toLowerCase() === k,
                );
                return {
                  name: nt.name,
                  priority: (nt.priority.charAt(0).toUpperCase() +
                    nt.priority.slice(1)) as RoadmapPriority,
                  estimated_minutes: Math.max(
                    1,
                    Math.round(nt.estimated_minutes),
                  ),
                  // Overrides + mirrored completion state survive the re-plan.
                  manual_minutes: manualByName.get(k) ?? null,
                  is_done: doneByName.get(k) ?? false,
                  // (Phase 3) Carry the re-plan's one-line reason through so
                  // the info icon still explains this re-planned estimate.
                  ...(src?.reason ? { reason: src.reason } : {}),
                };
              });
              return { ...d, tasks: newDayTasks };
            }),
          };
        });

      // Update the working list + timer if the day is active.
      if (isActive) {
        const nextIncomplete = newTasks.find((t) => !t.is_completed) ?? null;
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
                  nextIncomplete.manual_minutes,
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
        (r) => r.id === roadmapId,
      );
      if (!updated) {
        throw new Error("Re-planned roadmap could not be found.");
      }
      return updated;
    },
    [state],
  );

  // ---- Per-task exam ----

  /**
   * Stores generated exam questions on the task (persisted via the
   * global state -> localStorage effect). Immutably maps over tasks.
   */
  const attachExam = useCallback(
    (taskId: string, questions: ExamQuestion[]) => {
      setState((prev) => ({
        ...prev,
        tasks: prev.tasks.map((t) =>
          t.id === taskId
            ? {
                ...t,
                exam: { taskName: t.name, questions, createdAt: Date.now() },
              }
            : t,
        ),
      }));
    },
    [],
  );

  /**
   * Submits answers for a task's exam, grades them via /api/grade-exam,
   * and stores the result on the task in localStorage.
   */
  const submitExam = useCallback(
    async (
      taskId: string,
      questions: ExamQuestion[],
      answers: Record<string, string>,
    ): Promise<TaskExamResult> => {
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error("Task not found.");
      if (!questions.length) throw new Error("This task has no exam yet.");

      const res = await apiPost("/api/grade-exam", {
        taskName: task.name,
        questions,
        answers,
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
          t.id === taskId ? { ...t, examResult: result } : t,
        ),
      }));

      return result;
    },
    [state],
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

  /**
   * §1/§2 Roadmap day checklist: toggles a single task's done state directly
   * on the roadmap document (works from the progress rows without loading
   * the day). When that day is the active working list, the mirrored Task
   * is kept in sync so the timer/history stay consistent.
   */
  const toggleRoadmapTask = useCallback(
    (roadmapId: string, dayNumber: number, taskIndex: number) => {
      // Phase B: decide whether this toggle completes the task, so we can
      // open the exam AFTER the state update (no side-effects inside setState).
      const roadmap0 = state.roadmaps.find((r) => r.id === roadmapId);
      const day0 = roadmap0?.days.find((d) => d.day_number === dayNumber);
      const task0 = day0?.tasks[taskIndex];
      const willComplete = !!task0 && !task0.is_done;
      // Resolve the matching Today working-list task by name so the exam
      // modal can read its timing outcome record.
      const matchedTaskId =
        willComplete && task0
          ? ((state.tasks as Task[]).find((t) =>
              t.name.toLowerCase() === task0.name.toLowerCase() ? t.id : null,
            )?.id ?? null)
          : null;

      setState((prev) => {
        const roadmap = prev.roadmaps.find((r) => r.id === roadmapId);
        const day = roadmap?.days.find((d) => d.day_number === dayNumber);
        const task = day?.tasks[taskIndex];
        if (!roadmap || !day || !task) return prev;

        const newDone = !task.is_done;
        const updatedDayTasks = day.tasks.map((t, i) =>
          i === taskIndex ? { ...t, is_done: newDone } : t,
        );

        // Auto-complete / un-complete the DAY when every task is done.
        const allDone = updatedDayTasks.every((t) => t.is_done);
        let days = roadmap.days.map((d) =>
          d.day_number === dayNumber
            ? { ...d, tasks: updatedDayTasks, is_completed: allDone }
            : d,
        );

        // v2 Fix 5: same crediting rule for roadmap checklists (skipped
        // mid-session so the live timer isn't counted twice at its end).
        const deltaMin = effectiveMinutes(
          task.estimated_minutes,
          task.manual_minutes,
        );
        const focusDelta = prev.timer.isRunning
          ? 0
          : newDone
            ? deltaMin
            : -deltaMin;
        const rk = getTodayKey();
        const rs = prev.history[rk];
        const focusNow = Math.max(0, (rs?.focus_minutes ?? 0) + focusDelta);
        const historyNext = {
          ...prev.history,
          [rk]: rs
            ? {
                ...rs,
                focus_minutes: focusNow,
                productivity: computeProductivity(
                  rs.tasks_completed,
                  rs.total_tasks,
                  rs.sessions_count,
                  prev.settings.dailySessionGoal,
                ),
              }
            : buildDayStats(
                rk,
                0,
                focusNow,
                0,
                0,
                prev.settings.dailySessionGoal,
              ),
        };

        let badges = prev.badges;
        let status: Roadmap["status"] = roadmap.status;
        if (allDone && status !== "completed") {
          if (days.every((d) => d.is_completed)) {
            status = "completed";
            const alreadyUnlocked = badges.some(
              (b) => b.title === roadmap.badge_reward.title,
            );
            if (!alreadyUnlocked) {
              badges = [
                ...badges,
                {
                  id: generateId(),
                  title: roadmap.badge_reward.title,
                  icon: roadmap.badge_reward.icon,
                  unlockedAt: Date.now(),
                },
              ];
              showToast(
                `Badge unlocked: ${roadmap.badge_reward.title}!`,
                "success",
              );
            }
          }
        }

        const nextRoadmaps = prev.roadmaps.map((r) =>
          r.id === roadmapId ? { ...r, days, status } : r,
        );

        // Mirror into the active working list when this day is loaded.
        const isActive =
          prev.activeRoadmapDay?.roadmapId === roadmapId &&
          prev.activeRoadmapDay?.dayNumber === dayNumber;
        let tasks = prev.tasks;
        if (isActive) {
          tasks = prev.tasks.map((t) =>
            t.name.toLowerCase() === task.name.toLowerCase()
              ? { ...t, is_completed: newDone }
              : t,
          );
          // Sync today's history counters with the mirrored list.
          const todayKey = getTodayKey();
          const completed = countCompletedTasks(tasks);
          const prevStats = prev.history[todayKey];
          const history = {
            ...prev.history,
            [todayKey]: prevStats
              ? {
                  ...prevStats,
                  tasks_completed: completed,
                  total_tasks: tasks.length,
                  productivity: computeProductivity(
                    completed,
                    tasks.length,
                    prevStats.sessions_count,
                    prev.settings.dailySessionGoal,
                  ),
                }
              : buildDayStats(
                  todayKey,
                  0,
                  0,
                  completed,
                  tasks.length,
                  prev.settings.dailySessionGoal,
                ),
          };
          const mergedHistory = {
            ...history,
            [rk]: { ...(history[rk] ?? {}), focus_minutes: focusNow },
          };
          return {
            ...prev,
            roadmaps: nextRoadmaps,
            tasks,
            history: mergedHistory,
            badges,
          };
        }

        return {
          ...prev,
          roadmaps: nextRoadmaps,
          badges,
          history: historyNext,
        };
      });

      // Phase D: completing a roadmap day task (e.g. checking it off in the
      // TopicBoard) must open its exam — exactly like the Today-card checkbox
      // path (toggleTask). Runs AFTER the state update so the task row is
      // already flipped to is_completed before the modal reads it.
      if (willComplete) {
        if (matchedTaskId) {
          // Matching Today-list task exists — open its exam directly.
          setExamTaskId(matchedTaskId);
        } else if (task0) {
          // Task only exists in the roadmap (not loaded into Today).
          // Synthesize a transient Task so the exam modal has a record to
          // read timing_outcome/exam from — the exam is still scoped to
          // THIS task, not the global dashboard.
          const synthesizedId = `roadmap-task-${task0.name.replaceAll(/\s+/g, "-").toLowerCase()}`;
          const synthTask: Task = {
            id: synthesizedId,
            name: task0.name,
            priority: (task0.priority ?? "Medium").toLowerCase() as Priority,
            estimated_minutes: task0.estimated_minutes ?? 25,
            is_completed: true,
            createdAt: Date.now(),
            manual_minutes: task0.manual_minutes ?? null,
          };
          setState((prev) =>
            prev.tasks.some((t) => t.id === synthesizedId)
              ? prev
              : { ...prev, tasks: [...prev.tasks, synthTask] },
          );
          // Open the exam on the synthesized task (next render).
          setExamTaskId(synthesizedId);
        }
      }
    },
    [state],
  );

  // ---- v5 Practice goals (multi-day tasks with daily check-ins) ----

  /**
   * Creates a practice task starting TODAY (IST); Day 1 is immediately live.
   * Returns the new task's id so callers can navigate straight into its
   * dedicated workspace. Also persists synchronously (write-through) so a
   * client-side route change immediately after sees the saved state.
   */
  const addPracticeTask = useCallback(
    (name: string, description: string | undefined, durationDays: number) => {
      const trimmed = name.trim();
      if (!trimmed) return null;
      const days = Math.min(60, Math.max(1, Math.round(durationDays)));
      const id = generateId();
      setState((prev) => {
        const next: PomodoroAppState = {
          ...prev,
          practiceTasks: [
            {
              id,
              name: trimmed.slice(0, 120),
              ...(description && description.trim()
                ? { description: description.trim().slice(0, 300) }
                : {}),
              startDate: istTodayKey(),
              durationDays: days,
              checkIns: [],
              // Task + Roadmap architecture: every task owns an empty,
              // fully independent roadmap from birth.
              roadmap: [],
              createdAt: Date.now(),
            },
            ...prev.practiceTasks,
          ],
        };
        // Write-through: the /task/[id] page mounts its own hook instance
        // and must find this task on first hydration.
        saveState(next);
        return next;
      });
      showToast("Task created 🎯 Day 1 starts today.", "success");
      return id;
    },
    [],
  );

  // ---- Task-owned roadmap actions (Task + Roadmap architecture) ----
  // Every operation targets ONE task by id and rewrites only that task's
  // embedded steps — different tasks never share roadmap data.

  /** Replaces a task's whole roadmap (used by AI attach + future import). */
  const setTaskRoadmap = useCallback((taskId: string, steps: RoadmapStep[]) => {
    setState((prev) => ({
      ...prev,
      practiceTasks: prev.practiceTasks.map((t) =>
        t.id === taskId ? { ...t, roadmap: steps } : t,
      ),
    }));
  }, []);

  /** Appends one new step to the END of a task's roadmap. */
  const addTaskRoadmapStep = useCallback(
    (taskId: string, title: string, note?: string) => {
      if (!title.trim()) return;
      setState((prev) => ({
        ...prev,
        practiceTasks: prev.practiceTasks.map((t) =>
          t.id === taskId
            ? { ...t, roadmap: [...(t.roadmap ?? []), makeStep(title, note)] }
            : t,
        ),
      }));
    },
    [],
  );

  /** Edits a step's title/note in place (order preserved). */
  const updateTaskRoadmapStep = useCallback(
    (
      taskId: string,
      stepId: string,
      patch: { title?: string; note?: string | null },
    ) => {
      setState((prev) => ({
        ...prev,
        practiceTasks: prev.practiceTasks.map((t) => {
          if (t.id !== taskId) return t;
          return {
            ...t,
            roadmap: (t.roadmap ?? []).map((s) => {
              if (s.id !== stepId) return s;
              const next = { ...s };
              if (typeof patch.title === "string" && patch.title.trim()) {
                next.title = patch.title.trim().slice(0, 160);
              }
              if (patch.note === null) {
                delete next.note;
              } else if (typeof patch.note === "string" && patch.note.trim()) {
                next.note = patch.note.trim().slice(0, 400);
              }
              return next;
            }),
          };
        }),
      }));
    },
    [],
  );

  /** Removes a step from ONE task's roadmap. */
  const deleteTaskRoadmapStep = useCallback(
    (taskId: string, stepId: string) => {
      setState((prev) => ({
        ...prev,
        practiceTasks: prev.practiceTasks.map((t) =>
          t.id === taskId
            ? {
                ...t,
                roadmap: (t.roadmap ?? []).filter((s) => s.id !== stepId),
              }
            : t,
        ),
      }));
    },
    [],
  );

  /**
   * §10/§11 Gating: a step is only genuinely COMPLETE when it has a
   * completedAt (set via the timer finishing OR an explicit "Mark Done" that
   * passed the per-step check-in). A bare checkbox flip must NOT set isDone
   * directly, so a stray click can never cascade into day + task completion.
   *
   * Un-ticking (done -> not done) is always allowed so progress can be undone.
   */
  const toggleTaskRoadmapStep = useCallback(
    (taskId: string, stepId: string) => {
      const task = (state.practiceTasks as PracticeTask[]).find(
        (t) => t.id === taskId,
      );
      const steps = task?.roadmap ?? [];
      const idx = steps.findIndex((s) => s.id === stepId);
      const step = steps[idx];

      // Un-tick path: reversing a genuinely-completed step is free undo.
      // WORKFLOW §16: review history (practicedSeconds, checkIn, timing) is
      // RETAINED — only the done/completion markers are lifted so the step can
      // be worked again. The task's own completion flag is assessment/exam
      // derived, so it is recomputed from the persisted assessment state
      // (never from raw step counts).
      if (step && step.isDone) {
        setState((prev) => {
          const nextPracticeTasks = prev.practiceTasks.map((t) => {
            if (t.id !== taskId) return t;
            const nextRoadmap = (t.roadmap ?? []).map((s) =>
              s.id === stepId
                ? {
                    ...s,
                    isDone: false,
                    completedAt: undefined,
                    completedBy: undefined,
                  }
                : s,
            );
            const checkIns = syncCompletedDays(nextRoadmap, t.checkIns ?? []);
            // `assessment` is untouched by the un-tick, so reading it off the
            // task being mapped is safe (and avoids referencing the array we
            // are still building).
            const prior = getOrCreateAssessment(t);
            return {
              ...t,
              roadmap: nextRoadmap,
              checkIns,
              is_completed:
                prior.exam != null &&
                prior.completedDays.length >=
                  Math.max(1, roadmapDayNumbers(nextRoadmap).length),
            };
          });
          return { ...prev, practiceTasks: nextPracticeTasks };
        });
        return;
      }

      // WORKFLOW §1/§2 guards (unchanged day-lock + NEW sequential + started):
      if (step) {
        const assessment = task?.assessment
          ? { completedDays: task.assessment.completedDays ?? [] }
          : undefined;
        // §1 SEQUENTIAL LOCK: this step must be the next startable one.
        if (!canStartStep(steps, idx, assessment)) {
          showToast(
            stepLockReason(steps, idx, assessment) ||
              "Complete the previous step first.",
            "info",
          );
          return;
        }
        // WORKFLOW §2/§3: no completion before a genuine timer session exists.
        if (!hasRealPractice(step)) {
          showToast(
            "Start the timer and practice before marking this step done.",
            "info",
          );
          return;
        }
        // Tick path: completing a step requires the mandatory per-step
        // question — the checkbox routes through the SAME question gate as a
        // timer Finish (no READY→COMPLETED shortcut).
        setPendingCheckIn({
          taskId,
          stepId,
          stepTitle: step.title,
          topic: task?.name ?? step.title,
          completedBy: "manual",
          // Phase 1 (token saving): reuse the persisted question when present.
          ...(step.checkInQuestion ? { cachedQuestion: step.checkInQuestion } : {}),
        });
        showToast("Confirm this step's quick check to mark it done.", "info");
      }
    },
    [state, setPendingCheckIn],
  );

  /** Closes the check-in modal WITHOUT completing the step (user backed out). */
  const dismissCheckIn = useCallback(() => setPendingCheckIn(null), []);

  /** Closes the roadmap-exam modal (result is kept when already graded). */
  const dismissRoadmapExam = useCallback(() => setPendingRoadmapExam(null), []);

  /**
   * §10/§11: the ONE genuine per-step completion path. Sets isDone + completedAt
   * + checkIn, re-derives day/task completion, mirrors to the Today list, and
   * (when the last step is done) triggers the full-roadmap mock exam.
   */
  const completeStep = useCallback(
    (
      taskId: string,
      stepId: string,
      checkIn: {
        question: string;
        options?: string[];
        answer: string;
        correct: boolean;
        passed: boolean;
        explanation?: string;
        /** True when the learner marked done WITHOUT answering (unverified). */
        skipped?: boolean;
      },
      completedBy: "timer" | "manual",
    ) => {
      // WORKFLOW §2/§5 — the QUESTION IS THE GATE. The required per-step question
      // must be genuinely ANSWERED (not skipped) for the step to complete.
      // Completion never depends on minimum practice time — a Finish press
      // is allowed early, but skipping the question keeps the step at
      // STEP_QUESTION_PENDING (isDone stays false).
      const gateTask = (state.practiceTasks as PracticeTask[]).find(
        (t) => t.id === taskId,
      );
      const gateSteps = gateTask?.roadmap ?? [];
      const gateIdx = gateSteps.findIndex((s) => s.id === stepId);
      const gateStep = gateSteps[gateIdx];

      // WORKFLOW §1: a locked/out-of-sequence step can never be completed.
      const gateAssessment = gateTask?.assessment
        ? { completedDays: gateTask.assessment.completedDays ?? [] }
        : undefined;
      if (gateStep && !gateStep.isDone && !isStepStartable(gateSteps, gateIdx, gateAssessment)) {
        showToast(stepLockReason(gateSteps, gateIdx, gateAssessment) || "Complete the previous step first.", "info");
        setPendingCheckIn(null);
        return;
      }
      // WORKFLOW §2/§3: no completion before a genuine timer session exists.
      if (gateStep && !gateStep.isDone && !hasRealPractice(gateStep)) {
        showToast("Start the timer and practice before completing this step.", "info");
        setPendingCheckIn(null);
        return;
      }
      // WORKFLOW §5: a skipped/unanswered question must NOT complete the step.
      if (gateStep && !gateStep.isDone && !!checkIn.skipped) {
        showToast("Please answer the required question to mark this step complete.", "info");
        setPendingCheckIn(null);
        return;
      }
      setState((prev) => {
        const nextPracticeTasks = prev.practiceTasks.map((t) => {
          if (t.id !== taskId) return t;
          const nextRoadmap = (t.roadmap ?? []).map((s) =>
            s.id === stepId
              ? {
                  ...s,
                  // WORKFLOW §5: reached ONLY after the mandatory question was
                  // genuinely answered (skips return above). This is the single
                  // QUESTION_SUBMITTED → STEP_COMPLETED transition.
                  isDone: true,
                  completedAt: Date.now(),
                  completedBy,
                  // The step leaves STEP_QUESTION_PENDING now that its question
                  // has been submitted and stored.
                  questionPending: false,
                  checkIn: {
                    ...checkIn,
                    answeredAt: Date.now(),
                  },
                }
              : s,
          );
          // WORKFLOW §14: is_completed is NOT derived from step completion.
          // A task only completes after every day is assessed AND the final
          // exam is submitted, so leave any persisted flag untouched here.
          const checkIns = syncCompletedDays(nextRoadmap, t.checkIns ?? []);
          return {
            ...t,
            roadmap: nextRoadmap,
            checkIns,
          };
        });

        // Mirror the completed step onto the Today working-list item (if one
        // matches by name). This mirrors a STEP's completion only — it must
        // not mark the learning TASK itself completed.
        let tasks = prev.tasks;
        if (tasks.length) {
          const stepTitle =
            prev.practiceTasks
              .find((t) => t.id === taskId)
              ?.roadmap?.find((s) => s.id === stepId)?.title ?? "";
          if (stepTitle) {
            tasks = tasks.map((t) =>
              t.name.toLowerCase() === stepTitle.toLowerCase()
                ? { ...t, is_completed: true }
                : t,
            );
          }
        }

        return { ...prev, practiceTasks: nextPracticeTasks, tasks };
      });

            // The gate is satisfied — close the check-in modal immediately.
      setPendingCheckIn(null);

      // After the state update, decide cascade side-effects. Compute whether
      // the LAST step is now complete from the pre-update list (allDoneBefore
      // means every OTHER step was already done, so this one completes the set).
      const updated = (state.practiceTasks as PracticeTask[]).find(
        (t) => t.id === taskId,
      );
      const pool = updated?.roadmap ?? [];
      const step = pool.find((s) => s.id === stepId);
      if (step && !step.isDone) {
        // PART 2 §2/§3: when the LAST step of a day completes, surface that
        // day's Day Assessment (10-12 questions). The next day stays LOCKED
        // until each prior day is both step-complete AND assessed.
        const stepDay = step.dayNumber ?? 1;
        const daySteps = pool.filter((s) => (s.dayNumber ?? 1) === stepDay);
        const lastOfDayDone =
          daySteps.length > 0 &&
          daySteps
            .filter((s) => s.id !== stepId)
            .every((s) => s.isDone && !!s.completedAt);
        const updatedTask = updated;
        const assessment = getOrCreateAssessment(updatedTask);
        // The step isn't yet marked done in `updated` (setState is async), so
        // compute day-unlock as if THIS step just completed. Day N is current
        // when N-1 prior days are done+assessed and day N's remaining steps are
        // all done (this one is the last pending).
        const unlock = dayUnlockState(updatedTask);
        const currentDay = stepDay > unlock.currentDay ? stepDay : unlock.currentDay;
        if (
          lastOfDayDone &&
          stepDay === currentDay &&
          currentDay <= (updatedTask?.durationDays ?? 1) &&
          !assessment.completedDays.includes(currentDay)
        ) {
          setDayAssessmentPending({ taskId, dayNumber: currentDay });
        }
        // PART 2 §5: when the LAST day's last step completes AND every prior
        // day already has an assessment, the final exam becomes available.
        // We do NOT auto-open it — the user must enter the dedicated section.
        void completeStepCascade(taskId);
      }


      // §P3: Repeated-failure detection — if the user missed this check-in,
      // count it. On the SECOND miss for the same topic, auto-insert a
      // prerequisite task before the next attempt.
      if (checkIn && !checkIn.correct && !checkIn.skipped) {
        const topicSlug = (step?.title ?? "general").toLowerCase().replace(/[^a-z0-9]+/g, "-");
        setState((prev) => {
          const ft = prev.failureTracker ?? {};
          const failures = (ft[topicSlug] ?? 0) + 1;
          if (failures < 2) {
            return { ...prev, failureTracker: { ...ft, [topicSlug]: failures } };
          }
          // Second+ failure — insert a prerequisite step immediately before.
          const task = prev.practiceTasks.find((t) => t.id === taskId);
          const steps = task?.roadmap ?? [];
          const targetIdx = steps.findIndex((s) => s.id === stepId);
          if (targetIdx < 0) return prev;
          const prereq: RoadmapStep = {
            id: `prereq-${Date.now()}`,
            title: `Prerequisite: review "${step?.title ?? topicSlug}"`,
            note: `Inserted automatically after repeated misses on this topic.`,
            dayNumber: step?.dayNumber ?? 1,
            isDone: false,
            practicedSeconds: 0,
            elapsedSeconds: 0,
            timerStatus: "idle",
          };
          const nextSteps = [...steps];
          nextSteps.splice(targetIdx + 1, 0, prereq);
          showToast(
            "Repeated misses detected — a prerequisite step was added 🧠",
            "info",
          );
          return {
            ...prev,
            failureTracker: { ...ft, [topicSlug]: 0 }, // reset after inserting
            practiceTasks: prev.practiceTasks.map((t) =>
              t.id === taskId ? { ...t, roadmap: nextSteps } : t,
            ),
          };
        });
      }
    },[state, setPendingRoadmapExam, setPendingCheckIn],
  );

  /**
   * §12/§13: records a completed FULL-ROADMAP mock exam, recomputes the
   * persistent per-topic skill profile from the steps' check-ins + this exam's
   * per-topic breakdown, persists it (localStorage via the normal save effect),
   * and best-effort syncs to the remote skill-profile endpoint when deployed.
   */
  const completeRoadmapExam = useCallback(
    (taskId: string, result: RoadmapExamResult) => {
      setState((prev) => {
        const task = prev.practiceTasks.find((t) => t.id === taskId);
        const steps = task?.roadmap ?? [];

        // 1) Persist the graded roadmap exam result keyed by roadmap/task id.
        const roadmapExamResults = {
          ...(prev.roadmapExamResults ?? {}),
          [taskId]: result,
        };

        // 2) Build skill evidence from the steps' check-ins + exam breakdown.
        const groups = skillProfilesFromRoadmapEvidence({
          topicLabel: task?.name ?? "General",
          steps: steps.map((s) => ({
            title: s.title,
            checkIn: s.checkIn ? { correct: s.checkIn.correct } : undefined,
          })),
          exam: { breakdown: result.breakdown, gradedAt: result.gradedAt },
        });

        // 3) Merge each group into the persistent profile map.
        const skillProfiles = { ...(prev.skillProfiles ?? {}) };
        let changed = false;
        for (const group of groups) {
          if (group.length === 0) continue;
          const topic = group[0].topic;
          const next = updateSkillProfile(skillProfiles[topic], group);
          if (next) {
            skillProfiles[topic] = next;
            changed = true;
          }
        }
        if (!changed && Object.keys(roadmapExamResults).length === 0)
          return prev;

        // 4) Best-effort remote sync (only when pointed at the deployed stack).
        if (isRemoteApi() && Object.keys(skillProfiles).length > 0) {
          apiPost("/api/skill-profile", {
            profiles: Object.values(skillProfiles),
          })
            .then(() => undefined)
            .catch(() => undefined);
        }

        return { ...prev, roadmapExamResults, skillProfiles };
      });
      setPendingRoadmapExam(null);
      showToast("Roadmap complete — skill profile updated 🎉", "success");
    },
    [],
  );
  // ---- PART 2: assessment + exam logic -------------------------------------

  /** Returns the durable TaskAssessment for a task, creating a default when
   *  none exists yet (a task with no roadmap/assessments yet is Day 1). */
  function getOrCreateAssessment(task?: PracticeTask): TaskAssessment {
    return (
      task?.assessment ?? {
        completedDays: [],
        dayScores: {},
        attempts: [],
      }
    );
  }

  /** Removes ONE day's persisted question bank from the assessment, returning
   *  a fresh map (or the original when nothing to change). */
  function clearDayQuestions(
    dayQuestions: Record<string, RoadmapExamQuestion[]> | undefined,
    dayNumber: number,
  ): Record<string, RoadmapExamQuestion[]> | undefined {
    if (!dayQuestions) return undefined;
    const next = { ...dayQuestions };
    delete next[String(dayNumber)];
    return next;
  }

  /** PART 2 §3 + §13: authoritative day-unlock state from persisted task data.
   * Day N is current only if days 1..N-1 steps done AND assessed. Pure so the
   * server progress route can re-derive and reject bypass attempts. */
  function dayUnlockState(task: PracticeTask | undefined) {
    const roadmap = task?.roadmap ?? [];
    const duration = Math.max(1, task?.durationDays ?? 1);
    const assessment = getOrCreateAssessment(task);
    const assessed = new Set(assessment.completedDays);
    const completedDays: number[] = [];
    for (let d = 1; d <= duration; d++) {
      if (isDayComplete(roadmap, d) && assessed.has(d)) completedDays.push(d);
      else break;
    }
    return {
      completedDays,
      currentDay: completedDays.length + 1,
      finalDay: duration,
      allDaysDone: completedDays.length >= duration,
    };
  }

  /** PART 2 §5: after a step completes, re-evaluate whether the final exam is
   * now available (last day done + all prior days assessed). Never auto-opens. */
  function completeStepCascade(taskId: string): void {
    const unlock = dayUnlockState(
      (state.practiceTasks as PracticeTask[]).find((t) => t.id === taskId),
    );
    // Final-exam availability is derived live (dayUnlockState.allDaysDone) in
    // the exam section, so no state write is required here.
    void unlock;
  }
// ---- Offline generators (provider-outage safety nets) ---------------------
  /** A stable slug/topic label for a day assessment fallback. */
  function dayTopicLabel(topicLabel: string, dayNumber: number, steps: RoadmapStep[]): string {
    const first = steps[0];
    return first?.dayTitle ?? `Day ${dayNumber}: ${topicLabel}`;
  }

  /** All (day,title) pairs across a task's roadmap, unique by day number. */
  function allDayTopics(steps: RoadmapStep[]): { day: number; title: string }[] {
    const map = new Map<number, string>();
    for (const s of steps) {
      const d = s.dayNumber ?? 1;
      if (!map.has(d)) map.set(d, s.dayTitle ?? `Day ${d}`);
    }
    return Array.from(map.entries()).map(([day, title]) => ({ day, title }));
  }

  /** Offline Day Assessment: one question per step, drawn from its title+note. */
  function buildOfflineDayQuestions(
    topicLabel: string,
    dayTitle: string,
    dayNumber: number,
    steps: RoadmapStep[],
  ): RoadmapExamQuestion[] {
    if (steps.length === 0) {
      return [
        {
          id: `offline-day-${dayNumber}-0`,
          topic: topicLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          day_number: dayNumber,
          prompt: `Based on Day ${dayNumber} — ${dayTitle} — which concept was central to this study session?`,
          options: ["The roadmap steps", "The exam", "The dashboard", "None of these"],
          referenceAnswer: "The roadmap steps",
          difficulty: "medium",
          explanation: `Day ${dayNumber} was ~\"${dayTitle}\". The steps center on it.`,
          source: dayTitle,
        },
      ];
    }
    return steps.map((s, i) => {
      const topic = (s.dayTitle ?? s.title).toLowerCase().replace(/[^a-z0-9]+/g, "-");
      return {
        id: `offline-day-${dayNumber}-${i}`,
        topic,
        day_number: dayNumber,
        prompt: `Self-check — which of the following best captures \"${s.title}\"?`,
        options: [s.title.replace(/^Step \\d+[\\-–.]*/, "").trim() || s.title, `${topicLabel} fundamentals`, "A later day's topic", "An unrelated concept"],
        referenceAnswer: s.title.replace(/^Step \\d+[\\-–.]*/, "").trim() || s.title,
        difficulty: "medium",
        explanation: `This step was ~\"${s.title}\". ${s.note ?? ("Focus on " + topic)}.`,
        source: s.title,
      };
    });
  }

  /** Offline Final Exam: a few questions sampled across every day. */
  function buildOfflineFinalQuestions(topicLabel: string, steps: RoadmapStep[]): RoadmapExamQuestion[] {
    const days = allDayTopics(steps);
    const picked = days.slice(0, Math.min(3, days.length));
    if (picked.length === 0) {
      return [
        {
          id: `offline-final-0`,
          topic: topicLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          prompt: `Time to consolidate what you learned. What is the core subject of this learning path?`,
          options: [topicLabel, "A single step", "The dashboard", "None of the above"],
          referenceAnswer: topicLabel,
          difficulty: "medium",
          explanation: `This roadmap focused on ${topicLabel}.`,
          source: topicLabel,
        },
      ];
    }
    return picked.map((d, i) => {
      const stepsInDay = steps.filter((s) => (s.dayNumber ?? 1) === d.day);
      const topic = (d.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") || topicLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
      return {
        id: `offline-final-${i}`,
        topic,
        prompt: `Final check — day \"${d.title}\" covered which of the following most directly?`,
        options: stepsInDay.length
          ? [stepsInDay[0].title, `${topicLabel} overview`, "Settings", "History"]
          : [topicLabel, "A random fact", "The timer", "None of these"],
        referenceAnswer: stepsInDay.length ? stepsInDay[0].title : topicLabel,
        difficulty: "medium",
        explanation: `Day ${d.day} (${d.title}) centred on these steps.`,
        source: d.title,
      };
    });
  }
// ---- PART 2 callbacks -----------------------------------------------------
  /**
   * PART 2 §2 + Req 2/3: starts a Day Assessment for `dayNumber`.
   * BACKEND-ENFORCED: refuses to start unless every step of that day is
   * genuinely complete AND verified, and every earlier day is step-complete
   * AND assessed (dayAssessmentEligible). If a question bank was already
   * generated for this day, it is REUSED (token efficiency, Req 17) instead
   * of calling the LLM again.
   */
  const startDayAssessment = useCallback(
    async (taskId: string, dayNumber: number) => {
      const task = (state.practiceTasks as PracticeTask[]).find(
        (t) => t.id === taskId,
      );
      // Req 2/3: hard gate — do not open an exam the day has not earned.
      const gate = task ? dayAssessmentEligible(task, dayNumber) : { ready: false, reason: "Task not found." };
      if (!gate.ready) {
        showToast(gate.reason || "This assessment is not ready yet.", "info");
        setDayAssessmentPending(null);
        return;
      }
      const steps = (task?.roadmap ?? []).filter(
        (s) => (s.dayNumber ?? 1) === dayNumber,
      );
      const topicLabel = task?.name?.trim() || `Day ${dayNumber}`;
      const dayTitle = dayTopicLabel(topicLabel, dayNumber, steps);

      // Req 17: reuse the already-generated bank for this day when it exists.
      const existing = task?.assessment?.dayQuestions?.[String(dayNumber)];
      let questions: RoadmapExamQuestion[] = existing && existing.length ? existing : [];
      if (questions.length === 0) {
        try {
          const res = await apiPost("/api/generate-day-assessment", {
            topicLabel,
            dayNumber,
            dayTitle,
            stepTitles: steps.map((s) => s.title),
          });
          const data = (await res.json()) as {
            questions?: RoadmapExamQuestion[];
          };
          if (res.ok && Array.isArray(data.questions) && data.questions.length) {
            questions = data.questions.slice(0, 12);
          }
        } catch {
          questions = [];
        }
        if (questions.length === 0) {
          questions = buildOfflineDayQuestions(topicLabel, dayTitle, dayNumber, steps);
        }
        // Persist the generated bank so re-opening does NOT call AI again.
        setState((prev) => ({
          ...prev,
          practiceTasks: prev.practiceTasks.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  assessment: {
                    ...getOrCreateAssessment(t),
                    dayQuestions: {
                      ...(t.assessment?.dayQuestions ?? {}),
                      [String(dayNumber)]: questions,
                    },
                  },
                }
              : t,
          ),
        }));
      }
      setActiveExam({ taskId, taskName: topicLabel, kind: "day", dayNumber, questions });
      setDayAssessmentPending(null);
    },
    [state],
  );

  /**
   * PART 2 §8: persist the in-progress exam draft (answers + position) into
   * task.assessment.examDraft on every change so a refresh restores it.
   */
  const saveExamDraft = useCallback(
    (
      taskId: string,
      examId: string,
      questions: RoadmapExamQuestion[],
      answers: Record<string, string>,
      currentQuestion: number,
      violations?: { fullscreen?: number; visibility?: number },
    ) => {
      setState((prev) => ({
        ...prev,
        practiceTasks: prev.practiceTasks.map((t) => {
          if (t.id !== taskId) return t;
          const existing = t.assessment?.examDraft;
          return {
            ...t,
            assessment: {
              ...getOrCreateAssessment(t),
              examDraft: {
                examId,
                questions,
                answers,
                currentQuestion,
                startedAt: existing?.startedAt ?? Date.now(),
                updatedAt: Date.now(),
                // Preserve/merge monitoring counters so they survive refresh.
                fullscreenViolations:
                  violations?.fullscreen ?? existing?.fullscreenViolations ?? 0,
                visibilityViolations:
                  violations?.visibility ?? existing?.visibilityViolations ?? 0,
              },
            },
          };
        }),
      }));
    },
    [],
  );

  /**
   * PART 2 §8: reports a Fullscreen / tab-visibility violation during the
   * currently active exam. Increments the matching counter on the persisted
   * draft so refresh keeps it, and the submitted/interrupted attempt records it.
   */
  const reportExamViolation = useCallback(
    (taskId: string, type: "fullscreen" | "visibility") => {
      setState((prev) => ({
        ...prev,
        practiceTasks: prev.practiceTasks.map((t) => {
          if (t.id !== taskId || !t.assessment?.examDraft) return t;
          const draft = t.assessment.examDraft;
          return {
            ...t,
            assessment: {
              ...t.assessment,
              examDraft: {
                ...draft,
                fullscreenViolations:
                  (draft.fullscreenViolations ?? 0) + (type === "fullscreen" ? 1 : 0),
                visibilityViolations:
                  (draft.visibilityViolations ?? 0) + (type === "visibility" ? 1 : 0),
                updatedAt: Date.now(),
              },
            },
          };
        }),
      }));
    },
    [],
  );

  /**
   * PART 2 §8/§9: TERMINATES the currently active attempt without grading it.
   * Persists an immutable interrupted attempt (attemptState="interrupted"),
   * records an interruptedAttempt marker on the Assessment Hub, and clears the
   * in-flight draft so the learner later sees "Attempt Interrupted / Retry".
   * The exam requirement STILL exists (nothing here erases it).
   */
  const interruptActiveExam = useCallback(
    (taskId: string, reason: string) => {
      setState((prev) => {
        const task = prev.practiceTasks.find((t) => t.id === taskId);
        if (!task?.assessment?.examDraft) return prev;
        const prior = getOrCreateAssessment(task);
        const draft = prior.examDraft!;
        const examId = draft.examId;
        const dayMatch = /^day-(\d+)-/.exec(examId);
        const isFinal = examId.startsWith("final");
        const kind: "day" | "exam" = isFinal ? "exam" : "day";
        const interruptedAt = Date.now();
        const attemptCount =
          (prior.attempts ?? []).filter((a) => a.kind === kind).length + 1;
        const answeredCount = Object.keys(draft.answers ?? {}).length;
        const attempt: AssessmentAttempt = {
          attempt: attemptCount,
          kind,
          ...(dayMatch ? { day: Number(dayMatch[1]) } : {}),
          score: 0,
          total: draft.questions?.length ?? 0,
          pct: 0,
          passed: false,
          answers: draft.answers ?? {},
          questions: (draft.questions ?? []).map((q) => ({ id: q.id, prompt: q.prompt })),
          startedAt: draft.startedAt ?? interruptedAt,
          submittedAt: interruptedAt,
          durationSeconds: Math.max(
            0,
            Math.round((interruptedAt - (draft.startedAt ?? interruptedAt)) / 1000),
          ),
          fullscreenViolations: draft.fullscreenViolations ?? 0,
          visibilityViolations: draft.visibilityViolations ?? 0,
          attemptState: "interrupted",
          interruptionReason: reason,
          examId,
        };
        const nextAssessment: TaskAssessment = {
          ...prior,
          attempts: [...(prior.attempts ?? []), attempt],
          examDraft: undefined,
          interruptedAttempt: {
            examId,
            kind,
            ...(dayMatch ? { day: Number(dayMatch[1]) } : {}),
            reason,
            answeredCount,
            interruptedAt,
          },
        };
        return {
          ...prev,
          practiceTasks: prev.practiceTasks.map((t) =>
            t.id === taskId ? { ...t, assessment: nextAssessment } : t,
          ),
        };
      });
      setActiveExam(null);
    },
    [],
  );

  /** Dismisses the open exam section (results/drafts remain persisted).
   *  This NEVER erases the exam requirement or any persisted attempt. */
  const dismissActiveExam = useCallback(() => setActiveExam(null), []);

  /**
   * PART 2 §3: grades a Day Assessment purely from referenceAnswer (no LLM),
   * records it in the immutable attempt log + completedDays, and unlocks the
   * chain (next day's assessment becomes actionable once its last step is done).
   */
  const submitDayAssessment = useCallback(
    (taskId: string, dayNumber: number, questions: RoadmapExamQuestion[], answers: Record<string, string>) => {
      setState((prev) => {
        const task = prev.practiceTasks.find((t) => t.id === taskId);
        // Req 2/3: enforce on SUBMIT too — never accept a day exam the day did
        // not earn (covers hand-crafted UI/API bypass).
        if (task && !dayAssessmentEligible(task, dayNumber).ready) {
          return prev;
        }
        const total = questions.length;
        const correct = questions.filter((q) => answers[q.id] === q.referenceAnswer).length;
        const pct = total ? Math.round((correct / total) * 100) : 0;
        const passed = pct >= 70;
        const prior = getOrCreateAssessment(task);
        const attemptCount = (prior.attempts ?? []).filter((a) => a.kind === "day").length + 1;
        const examId = `day-${dayNumber}-${taskId}`;
        const startedAt = prior.examDraft?.startedAt ?? Date.now();
        const submittedAt = Date.now();
        // Req 12/14: per-question review record + correct answers + explanations,
        // so the submitted day exam can be reviewed later and survives refresh.
        const questionReview = questions.map((q) => ({
          id: q.id,
          prompt: q.prompt,
          selectedAnswer: answers[q.id] ?? "(no answer)",
          correctAnswer: q.referenceAnswer,
          correct: answers[q.id] === q.referenceAnswer,
          explanation: q.explanation,
        }));
        const attempt: AssessmentAttempt = {
          attempt: attemptCount,
          kind: "day",
          day: dayNumber,
          score: correct,
          total,
          pct,
          passed,
          answers,
          questions: questions.map((q) => ({ id: q.id, prompt: q.prompt })),
          startedAt,
          submittedAt,
          questionReview,
          correctAnswers: Object.fromEntries(questions.map((q) => [q.id, q.referenceAnswer])),
          explanations: Object.fromEntries(
            questions.map((q) => [q.id, q.explanation ?? ""]).filter(([, v]) => v !== ""),
          ),
          durationSeconds: Math.max(0, Math.round((submittedAt - startedAt) / 1000)),
          fullscreenViolations: prior.examDraft?.fullscreenViolations ?? 0,
          visibilityViolations: prior.examDraft?.visibilityViolations ?? 0,
          attemptState: "completed",
          examId,
        };
        const nextAssessment: TaskAssessment = {
          ...prior,
          completedDays: prior.completedDays.includes(dayNumber)
            ? prior.completedDays
            : [...prior.completedDays, dayNumber].sort((a, b) => a - b),
          dayScores: {
            ...(prior.dayScores ?? {}),
            [String(dayNumber)]: { score: correct, total, pct, passed, submittedAt },
          },
          attempts: [...(prior.attempts ?? []), attempt],
          // The day is now assessed: drop its persisted question bank and any
          // interrupted-attempt marker so the hub shows Completed.
          dayQuestions: clearDayQuestions(prior.dayQuestions, dayNumber),
          // Clear only THIS exam's interrupted marker (if it points here).
          interruptedAttempt:
            prior.interruptedAttempt && prior.interruptedAttempt.examId === examId
              ? undefined
              : prior.interruptedAttempt,
        };
        return {
          ...prev,
          practiceTasks: prev.practiceTasks.map((t) =>
            t.id === taskId ? { ...t, assessment: nextAssessment } : t,
          ),
        };
      });
      setActiveExam(null);
      setDayAssessmentPending(null);
      showToast("Day Assessment recorded ✔", "success");
    },
    [],
  );
/**
   * PART 2 §8: starts the FINAL TASK EXAM (20-30 q) once every day is complete
   * and assessed. Fetches online or falls back to the offline generator.
   */
  /**
   * PART 2 §8 + Req 4: starts the FINAL TASK EXAM (20-30 q).
   * BACKEND-ENFORCED: only available once EVERY required day exists, every
   * step of every day is completed AND verified, and every required Day
   * Assessment is submitted (finalExamEligible). Reuses a persisted final
   * question bank when present (Req 17).
   */
  const startFinalExam = useCallback(
    async (taskId: string) => {
      const task = (state.practiceTasks as PracticeTask[]).find(
        (t) => t.id === taskId,
      );
      const gate = task ? finalExamEligible(task) : { ready: false, reason: "Task not found." };
      if (!gate.ready) {
        showToast(gate.reason || "The final exam is not ready yet.", "info");
        return;
      }
      const topicLabel = task?.name?.trim() || "Final Exam";
      const dayTopics = allDayTopics(task?.roadmap ?? []);

      // Req 17: reuse the already-generated final bank when it exists.
      const existing = task?.assessment?.finalQuestions;
      let questions: RoadmapExamQuestion[] = existing && existing.length ? existing : [];
      if (questions.length === 0) {
        try {
          const res = await apiPost("/api/generate-roadmap-exam", {
            topicLabel,
            dayTopics,
            questionCount: 20,
          });
          const data = (await res.json()) as {
            questions?: RoadmapExamQuestion[];
          };
          if (res.ok && Array.isArray(data.questions) && data.questions.length) {
            questions = data.questions.slice(0, 20);
          }
        } catch {
          questions = [];
        }
        if (questions.length === 0) {
          questions = buildOfflineFinalQuestions(topicLabel, task?.roadmap ?? []);
        }
        // Persist the generated bank so re-opening does NOT call AI again.
        setState((prev) => ({
          ...prev,
          practiceTasks: prev.practiceTasks.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  assessment: {
                    ...getOrCreateAssessment(t),
                    finalQuestions: questions,
                  },
                }
              : t,
          ),
        }));
      }
      setActiveExam({ taskId, taskName: topicLabel, kind: "final", questions });
    },
    [state],
  );

  /**
   * PART 2 §9: submits the final exam, stores the immutable attempt + summary,
   * and clears any persisted draft. Final-exam availability is server-derived.
   */
  const submitFinalExam = useCallback(
    (taskId: string, questions: RoadmapExamQuestion[], answers: Record<string, string>) => {
      setState((prev) => {
        const task = prev.practiceTasks.find((t) => t.id === taskId);
        // Req 4: never accept a final exam the roadmap has not earned.
        if (task && !finalExamEligible(task).ready) {
          return prev;
        }
        const total = questions.length;
        const correct = questions.filter((q) => answers[q.id] === q.referenceAnswer).length;
        const pct = total ? Math.round((correct / total) * 100) : 0;
        const passed = pct >= 70;
        const prior = getOrCreateAssessment(task);
        const attemptCount = (prior.attempts ?? []).filter((a) => a.kind === "exam").length + 1;
        const examId = `final-${taskId}`;
        const startedAt = prior.examDraft?.startedAt ?? Date.now();
        const submittedAt = Date.now();
        // Req 12/14: per-question review so the completed final exam is
        // reviewable later and survives refresh.
        const questionReview = questions.map((q) => ({
          id: q.id,
          prompt: q.prompt,
          selectedAnswer: answers[q.id] ?? "(no answer)",
          correctAnswer: q.referenceAnswer,
          correct: answers[q.id] === q.referenceAnswer,
          explanation: q.explanation,
        }));
        const attempt: AssessmentAttempt = {
          attempt: attemptCount,
          kind: "exam",
          score: correct,
          total,
          pct,
          passed,
          answers,
          questions: questions.map((q) => ({ id: q.id, prompt: q.prompt })),
          startedAt,
          submittedAt,
          questionReview,
          correctAnswers: Object.fromEntries(questions.map((q) => [q.id, q.referenceAnswer])),
          explanations: Object.fromEntries(
            questions.map((q) => [q.id, q.explanation ?? ""]).filter(([, v]) => v !== ""),
          ),
          durationSeconds: Math.max(0, Math.round((submittedAt - startedAt) / 1000)),
          fullscreenViolations: prior.examDraft?.fullscreenViolations ?? 0,
          visibilityViolations: prior.examDraft?.visibilityViolations ?? 0,
          attemptState: "completed",
          examId,
        };
        const nextAssessment: TaskAssessment = {
          ...prior,
          exam: { score: correct, total, pct, passed, submittedAt },
          attempts: [...(prior.attempts ?? []), attempt],
          examDraft: undefined,
          finalQuestions: undefined,
          interruptedAttempt:
            prior.interruptedAttempt && prior.interruptedAttempt.examId === examId
              ? undefined
              : prior.interruptedAttempt,
        };
        // WORKFLOW §14: the final exam is the ONLY transition that can mark a
        // learning task completed. Derive it from the same pure rule the UI
        // uses (all roadmap days step-complete AND assessed) so a tampered
        // or stale snapshot can never fake task completion.
        const mapped = prev.practiceTasks.map((t) => {
          if (t.id !== taskId) return t;
          const steps = task?.roadmap ?? t.roadmap ?? [];
          const days = roadmapDayNumbers(steps);
          const allDaysAssessed =
            days.length > 0 && days.every((d) => nextAssessment.completedDays.includes(d));
          return {
            ...t,
            assessment: nextAssessment,
            ...(allDaysAssessed ? { is_completed: true } : {}),
          };
        });
        return {
          ...prev,
          practiceTasks: mapped,
        };
      });
      setActiveExam(null);
      showToast("Final Exam recorded 🎉", "success");
    },
    [],
  );



/**
   * PART 2 §8/§10: restores an in-flight exam from its persisted draft
   * (survived refresh/navigation). Rebuilds activeExam from the task's saved
   * draft so the learner returns exactly where they left off (answers +
   * current question). The section must stay available (server-derived):
   * day assessments resume only while that day is incomplete; the final exam
   * resumes whenever a draft exists.
   */
  const resumeExamDraft = useCallback(
    (taskId: string, draft: NonNullable<TaskAssessment["examDraft"]>) => {
      const task = (state.practiceTasks as PracticeTask[]).find(
        (t) => t.id === taskId,
      );
      const topicLabel = task?.name?.trim() || "Exam";
      // Draft examId is "final-<taskId>" or "day-<day>-<taskId>".
      const isFinal = draft.examId.startsWith("final");
      const dayMatch = /^day-(\d+)-/.exec(draft.examId);
      setActiveExam({
        taskId,
        taskName: topicLabel,
        kind: isFinal ? "final" : "day",
        ...(dayMatch ? { dayNumber: Number(dayMatch[1]) } : {}),
        questions: draft.questions ?? [],
        draftAnswers: draft.answers ?? {},
        draftCurrent: draft.currentQuestion ?? 0,
      });
    },
    [state],
  );
  const moveTaskRoadmapStep = useCallback(
    (taskId: string, stepId: string, direction: MoveDirection) => {
      setState((prev) => ({
        ...prev,
        practiceTasks: prev.practiceTasks.map((t) =>
          t.id === taskId
            ? {
                ...t,
                roadmap: moveRoadmapStep(t.roadmap ?? [], stepId, direction),
              }
            : t,
        ),
      }));
    },
    [],
  );

  // ---- Per-step time tracking + timers --------------------------------
  // Every timer action re-targets exactly ONE task and ONE step, updating
  // only that step's fields. Estimated/live values flow straight through
  // the pure helpers in lib/task-roadmap.ts.

  /** Sets a step's estimated duration in minutes (totals auto-update). */
  const setStepEstimatedMinutes = useCallback(
    (taskId: string, stepId: string, minutes: number | null) => {
      setState((prev) => ({
        ...prev,
        practiceTasks: prev.practiceTasks.map((t) => {
          if (t.id !== taskId) return t;
          return {
            ...t,
            roadmap: (t.roadmap ?? []).map((s) => {
              if (s.id !== stepId) return s;
              const minutesCeil =
                minutes != null && Number.isFinite(minutes) && minutes > 0
                  ? Math.floor(minutes)
                  : null;
              const next = { ...s };
              if (minutesCeil == null) delete next.estimated_minutes;
              else next.estimated_minutes = minutesCeil;
              return next;
            }),
          };
        }),
      }));
    },
    [],
  );

  /** Starts counting practice time for a step (idle/paused/finished → run).
   *  WORKFLOW §1/§2: the step must be startable (sequential lock) and the
   *  timer stamps the first-start audit trail used for no-completion-before-start. */
  const startStepTimer = useCallback((taskId: string, stepId: string) => {
    const now = Date.now();
    setState((prev) => {
      const task = prev.practiceTasks.find((t) => t.id === taskId);
      const steps = task?.roadmap ?? [];
      const idx = steps.findIndex((s) => s.id === stepId);
      const step = steps[idx];
      if (!step) return prev;
      if (step.isDone) {
        showToast("This step is already completed.", "info");
        return prev;
      }
      const assessment = task?.assessment
        ? { completedDays: task.assessment.completedDays ?? [] }
        : undefined;
      if (!canStartStep(steps, idx, assessment)) {
        showToast(stepLockReason(steps, idx, assessment) || "Complete the previous step first.", "info");
        return prev;
      }
      return {
        ...prev,
        practiceTasks: prev.practiceTasks.map((t) =>
          t.id === taskId
            ? {
                ...t,
                roadmap: (t.roadmap ?? []).map((s) => {
                  if (s.id !== stepId) return s;
                  return {
                    ...s,
                    timerStatus: "running" as const,
                    startedAt: now,
                    // AUDIT (§4): stamp the first start once, never overwrite.
                    ...(typeof s.firstStartedAt !== "number"
                      ? { firstStartedAt: now }
                      : {}),
                    lastPausedAt: null,
                  };
                }),
              }
            : t,
        ),
      };
    });
  }, []);

  /** Pauses a running step, folding the current run into practicedSeconds. */
  const pauseStepTimer = useCallback((taskId: string, stepId: string) => {
    const now = Date.now();
    setState((prev) => ({
      ...prev,
      practiceTasks: prev.practiceTasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              roadmap: (t.roadmap ?? []).map((s) => {
                if (s.id !== stepId || s.timerStatus !== "running") return s;
                const added = Math.max(
                  0,
                  Math.round((now - (s.startedAt ?? now)) / 1000),
                );
                return {
                  ...s,
                  practicedSeconds: s.practicedSeconds + added,
                  timerStatus: "paused" as const,
                  startedAt: undefined,
                  // AUDIT (§4): pause time + count.
                  lastPausedAt: now,
                  pauseCount: (s.pauseCount ?? 0) + 1,
                };
              }),
            }
          : t,
      ),
    }));
  }, []);

  /** Resumes a paused step: starts a fresh run from the frozen total. */
  const resumeStepTimer = useCallback((taskId: string, stepId: string) => {
    const now = Date.now();
    setState((prev) => ({
      ...prev,
      practiceTasks: prev.practiceTasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              roadmap: (t.roadmap ?? []).map((s) => {
                if (s.id !== stepId || s.timerStatus !== "paused") return s;
                return {
                  ...s,
                  timerStatus: "running" as const,
                  startedAt: now,
                  // AUDIT (§4): record resume time.
                  lastResumedAt: now,
                };
              }),
            }
          : t,
      ),
    }));
  }, []);

  /**
   * Finish / end a step's timer. Folds any live run into practicedSeconds,
   * clears the running state and moves the step to STEP_QUESTION_PENDING.
   * Finishing EARLY is allowed but does NOT complete the step — the mandatory
   * per-step question must be answered (non-skipped) before isDone is set.
   * The task itself is never completed here; that is derived from assessed
   * days + the final exam (see taskStatus).
   */
  const finishStepTimer = useCallback(
    (taskId: string, stepId: string) => {
      const now = Date.now();
      // WORKFLOW §2/§5: the timer ending only moves the step to
      // STEP_QUESTION_PENDING — could be finished early, but a Finish press
      // alone NEVER completes the step. The mandatory per-step question must
      // be answered before isDone is set. No min-practice hard-block here.
      setState((prev) => ({
        ...prev,
        practiceTasks: prev.practiceTasks.map((t) => {
          if (t.id !== taskId) return t;
          const nextRoadmap = (t.roadmap ?? []).map((s) => {
            if (s.id !== stepId) return s;
            const added =
              s.timerStatus === "running" && typeof s.startedAt === "number"
                ? Math.max(0, Math.round((now - s.startedAt) / 1000))
                : 0;
            // Phase C: measure the real minutes spent across ALL runs of this
            // step (pauses excluded — time only accrues while running) and
            // derive early/on-time/late vs the estimate with a ±10% band.
            const totalSeconds = s.practicedSeconds + added;
            const actualMinutes = Math.max(1, Math.round(totalSeconds / 60));
            const estimated = s.estimated_minutes ?? 0;
            const record =
              estimated > 0
                ? {
                    estimated_minutes: estimated,
                    actual_minutes: actualMinutes,
                    timing_outcome: deriveTimingOutcome(
                      estimated,
                      actualMinutes,
                    ),
                    completedAt: now,
                  }
                : null;
            return {
              ...s,
              practicedSeconds: totalSeconds,
              timerStatus: "finished" as const,
              startedAt: undefined,
              // WORKFLOW §2/§5: the timer ending moves the step to
              // STEP_QUESTION_PENDING — it DOES NOT complete it. completeStep()
              // (after the mandatory non-skipped question) sets isDone and
              // clears questionPending. A Finish press alone never marks done.
              questionPending: true,
              actual_minutes: record ? record.actual_minutes : s.actual_minutes,
              timing_outcome: record ? record.timing_outcome : s.timing_outcome,
              timingRecord: record ?? s.timingRecord,
              // AUDIT (§4): finish-request time.
              finishedAt: now,
            };
          });
          // NOTE: is_completed is NOT derived from steps here. Task completion
          // requires all days assessed AND the final exam submitted (see
          // taskStatus in lib/task-roadmap.ts). Keep any prior value until
          // the final exam records it.
          const checkIns = syncCompletedDays(nextRoadmap, t.checkIns ?? []);
          return {
            ...t,
            roadmap: nextRoadmap,
            checkIns,
          };
        }),
      }));

      // §11 gate: the step's timer finished, so the per-step check-in must be
      // answered before the step is genuinely marked done.
      const finishedStep = (state.practiceTasks as PracticeTask[])
        .find((t) => t.id === taskId)
        ?.roadmap?.find((s) => s.id === stepId);
      const finishedTask = (state.practiceTasks as PracticeTask[]).find(
        (t) => t.id === taskId,
      );
      if (finishedStep) {
        setPendingCheckIn({
          taskId,
          stepId,
          stepTitle: finishedStep.title,
          topic: finishedTask?.name ?? finishedStep.title,
          completedBy: "timer",
          // Phase 1 (token saving): reuse the persisted question when present.
          ...(finishedStep.checkInQuestion
            ? { cachedQuestion: finishedStep.checkInQuestion }
            : {}),
        });
      }
    },
    [state, setPendingCheckIn],
  );

  /** Re-opens a finished step so it can be worked on again.
 * WORKFLOW §16: review history (practicedSeconds, timingRecord, checkIn) is
 * RETAINED — only the run state resets. A pending question request is
 * withdrawn since the step is back to READY/IN_PROGRESS. */
  const reopenStepTimer = useCallback((taskId: string, stepId: string) => {
    setState((prev) => ({
      ...prev,
      practiceTasks: prev.practiceTasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              roadmap: (t.roadmap ?? []).map((s) => {
                if (s.id !== stepId) return s;
                return {
                  ...s,
                  timerStatus: "idle",
                  startedAt: undefined,
                  questionPending: false,
                };
              }),
            }
          : t,
      ),
    }));
  }, []);

  /** WORKFLOW §5: re-opens the mandatory question for a step that finished
   * (or was skipped) but is not yet genuinely complete. The step stays in
   * STEP_QUESTION_PENDING until the question is answered (non-skipped). */
  const requestStepQuestion = useCallback(
    (taskId: string, stepId: string) => {
      const task = (state.practiceTasks as PracticeTask[]).find(
        (t) => t.id === taskId,
      );
      const step = task?.roadmap?.find((s) => s.id === stepId);
      if (!step || step.isDone) return;
      setPendingCheckIn({
        taskId,
        stepId,
        stepTitle: step.title,
        topic: task?.name ?? step.title,
        completedBy: "timer",
        // Phase 1 (token saving): reuse the persisted question when present.
        ...(step.checkInQuestion ? { cachedQuestion: step.checkInQuestion } : {}),
      });
    },
    [state, setPendingCheckIn],
  );

  /**
   * Phase 1 (token saving): stores a freshly generated check-in question on
   * the step so reopening it (refresh / navigation) reuses it instead of
   * calling the LLM again. Fire-and-forget; failures are harmless.
   */
  const persistCheckInQuestion = useCallback(
    (taskId: string, stepId: string, question: {
      question: string;
      options: string[];
      correctIndex: number;
      explanation?: string;
      difficulty?: "easy" | "medium" | "hard";
      source?: string;
    }) => {
      setState((prev) => ({
        ...prev,
        practiceTasks: prev.practiceTasks.map((t) =>
          t.id === taskId
            ? {
                ...t,
                roadmap: (t.roadmap ?? []).map((s) =>
                  s.id === stepId ? { ...s, checkInQuestion: question } : s,
                ),
              }
            : t,
        ),
      }));
    },
    [],
  );

  /**
   * Daily check-in / un-check (§3): NO exam, NO quiz. Toggling a day
   * records one practice signal on that calendar day (check_ins), which
   * lights up the activity heatmap, streaks and history.
   */
  const togglePracticeCheckIn = useCallback((taskId: string, day: number) => {
    setState((prev) => {
      const task = prev.practiceTasks.find((t) => t.id === taskId);
      if (!task) return prev;
      if (day < 1 || day > task.durationDays) return prev;

      // Future days can't be checked in yet.

      const has = task.checkIns.includes(day);
      const checkIns = has
        ? task.checkIns.filter((d) => d !== day)
        : [...task.checkIns, day].sort((a, b) => a - b);

      const tk = istTodayKey();
      const s = prev.history[tk];
      const nextCi = Math.max(0, (s?.check_ins ?? 0) + (has ? -1 : 1));
      const history = {
        ...prev.history,
        [tk]: s
          ? { ...s, check_ins: nextCi }
          : {
              ...buildDayStats(tk, 0, 0, 0, 0, prev.settings.dailySessionGoal),
              check_ins: nextCi,
            },
      };

      return {
        ...prev,
        practiceTasks: prev.practiceTasks.map((t) =>
          t.id === taskId ? { ...t, checkIns } : t,
        ),
        history,
      };
    });
  }, []);

  /** §P6: Demo Mode — instantly load a static, fully-populated fixture.
   *  No LLM call, no network dependency. Useful for live demos where
   *  waiting on generation isn't practical. Wipes existing local state. */
  const loadDemo = useCallback(() => {
    const demo = buildDemoState();
    setState(demo);
    setHydrated(true);
    showToast("Demo mode loaded — sample roadmap, results & skill profile 🎉", "success");
  }, []);

  return {
    // Roadmaps
    roadmaps: state.roadmaps,
    // v5 Practice goals
    practiceTasks: state.practiceTasks,
    addPracticeTask,
    togglePracticeCheckIn,
    // Task + Roadmap architecture (per-task roadmap workspaces)
    setTaskRoadmap,
    addTaskRoadmapStep,
    updateTaskRoadmapStep,
    deleteTaskRoadmapStep,
    toggleTaskRoadmapStep,
    moveTaskRoadmapStep,
    // Per-step time tracking + timers
    setStepEstimatedMinutes,
    startStepTimer,
    pauseStepTimer,
    resumeStepTimer,
    finishStepTimer,
    reopenStepTimer,
    requestStepQuestion,
    // Phase 1: persist-once check-in questions (never regenerate on reopen)
    persistCheckInQuestion,
    // §10/§11/§12 Completion gating + full-roadmap mock exam
    pendingCheckIn,
    dismissCheckIn,
    completeStep,
    pendingRoadmapExam,
    dismissRoadmapExam,
    completeRoadmapExam,
// PART 2: Day Assessments + Final Exam section
    dayAssessmentPending,
    activeExam,
    startDayAssessment,
    submitDayAssessment,
    startFinalExam,
    submitFinalExam,
    saveExamDraft,
    reportExamViolation,
    interruptActiveExam,
    dismissActiveExam,
    resumeExamDraft,
    skillProfiles: state.skillProfiles ?? {},
    roadmapExamResults: state.roadmapExamResults ?? {},
    todayCheckIns: state.history[istTodayKey()]?.check_ins ?? 0,
    // Live epoch tick (500ms) — lets step timers count up in real time.
    now,
    badges: state.badges,
    activeRoadmapDay: state.activeRoadmapDay,
    generateRoadmap,
    startDay,
    completeRoadmapDay,
    replanDay,
    updateRoadmapTaskMinutes,
    toggleRoadmapTask,
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
        ? (state.tasks.find((t) => t.id === examTaskId) ?? null)
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
    // Hydration + history/resume
    hydrated,
    loadDemo,
    estimationLog: state.estimationLog ?? [],
    jumpToRoadmapTask,
    // History
    history: state.history,
  };
}

export type UsePomodoroReturn = ReturnType<typeof usePomodoro>;
