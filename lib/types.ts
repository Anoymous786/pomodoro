/**
 * ============================================================
 * LOCALSTORAGE SCHEMA (single source of truth)
 * ============================================================
 * This schema is shared by the timer, tasks, dashboard, history
 * modal, and roadmap generator. Field names are intentionally
 * kept consistent with what will later map onto Supabase tables.
 *
 * Root key: "pomodoro:app:v1"
 * Value:    PomodoroAppState (see below)
 *
 * ────────────────────────────────────────────────────────────
 * interface PomodoroAppState {
 *   activeDate: string; // "YYYY-MM-DD" this state belongs to
 *   settings: {
 *     workMinutes: number;       // default 25
 *     shortBreakMinutes: number; // default 5
 *     longBreakMinutes: number;  // default 15
 *     longBreakInterval: number; // long break after every N work sessions (default 4)
 *     dailySessionGoal: number;  // target sessions per day (default 8)
 *   };
 *   timer: {
 *     mode: "work" | "shortBreak" | "longBreak";
 *     isRunning: boolean;
 *     endTimestamp: number | null; // epoch ms when the current session ends
 *     completedWorkSessions: number; // work sessions completed in the current cycle
 *     activeTaskId: string | null;   // task currently being timed (null = generic session)
 *     taskDurationMinutes: number | null; // countdown minutes for the active task
 *   };
 *   tasks: Task[]; // today's tasks (see Task below)
 *   history: Record<string, DayStats>; // keyed by date "YYYY-MM-DD"
 *   roadmaps: Roadmap[]; // LLM-generated learning roadmaps
 *   badges: Badge[];     // unlocked badges
 * }
 *
 * interface Task {
 *   id: string;              // uuid
 *   name: string;
 *   priority: "high" | "medium" | "low";
 *   estimated_minutes: number;  // realistic AI estimate (or custom when added manually)
 *   is_completed: boolean;
 *   createdAt: number;       // epoch ms
 *   manual_minutes: number | null; // user override; null = use estimated_minutes
 * }
 *
 * interface DayStats {
 *   date: string;              // "YYYY-MM-DD"
 *   sessions_count: number;    // sessions completed that day
 *   focus_minutes: number;     // focus minutes accumulated that day
 *   tasks_completed: number;   // tasks completed that day
 *   total_tasks: number;       // total tasks created that day
 *   productivity: number;      // 0-100 computed percentage
 * }
 *
 * interface Roadmap {
 *   id: string;
 *   topic_name: string;
 *   badge_reward: { title: string; icon: string };
 *   days: RoadmapDay[];
 *   status: "in_progress" | "completed";
 *   createdAt: number; // epoch ms
 * }
 *
 * interface RoadmapDay {
 *   day_number: number;
 *   day_title: string;
 *   tasks: RoadmapTask[];
 *   is_completed: boolean;
 *   reason: string | null; // (Phase 3) AI one-liner explaining this day's position/order
 * }
 *
 * interface RoadmapTask {
 *   name: string;
 *   priority: "High" | "Medium" | "Low";
 *   estimated_minutes: number;  // realistic AI estimate for that specific task
 *   manual_minutes: number | null; // user override; null = untouched
 *   reason: string | null; // (Phase 3) AI one-liner explaining this task's estimate/order
 * }

 *
 * interface Badge {
 *   id: string;
 *   title: string;
 *   icon: string;
 *   unlockedAt: number; // epoch ms
 * }
 * ============================================================
 */

export type TimerMode = "work" | "shortBreak" | "longBreak";

export type Priority = "high" | "medium" | "low";

export type RoadmapPriority = "High" | "Medium" | "Low";

export type RoadmapStatus = "in_progress" | "completed";

/**
 * How a task's actual spent time compared with its estimate. Derived with a
 * small tolerance band — anything within ±10% of the estimate counts as
 * "on-time"; meaningfully under is "early"; meaningfully over is "late".
 */
export type TimingOutcome = "early" | "on-time" | "late";

/**
 * Per-task record required by Phase D — timing accuracy + exam accuracy,
 * scoped strictly to THIS task (never merged into the global dashboard).
 */
export interface TaskTimingRecord {
  /** The effective/planned estimate used for the countdown (minutes). */
  estimated_minutes: number;
  /** Real minutes actually spent, measured timer start -> stop/completion. */
  actual_minutes: number;
  /** Derived from actual vs estimate with a ±10% tolerance band. */
  timing_outcome: TimingOutcome;
  /** Epoch-ms when the timer run started (null if never ran to completion). */
  startedAt?: number | null;
  /** Epoch-ms when the task was completed. */
  completedAt: number;
}

export interface Task {
  id: string;
  name: string;
  priority: Priority;
  /** AI-generated realistic estimate (minutes) for this specific task. */
  estimated_minutes: number;
  is_completed: boolean;
  createdAt: number;
  /** User override in minutes; null means the AI estimate is untouched. */
  manual_minutes: number | null;
  /**
   * Phase C: measured actual minutes spent once the task's timer genuinely
   * finishes (or the user explicitly marks it done). Unset before completion.
   */
  actual_minutes?: number | null;
  /**
   * Phase C: "early" | "on-time" | "late" derived from actual vs estimate
   * with a ±10% tolerance band. Unset before completion.
   */
  timing_outcome?: TimingOutcome | null;
  /**
   * Phase C: the structured per-task timing record. Lives ONLY on the Task,
   * so it never bleeds into the global Sessions / Focus Time / Tasks summary.
   */
  timingRecord?: TaskTimingRecord | null;
  /**
   * Epoch-ms when the current (or most recent) timer run for this task
   * started. Used to measure real minutes at stop/completion.
   */
  lastStartedAt?: number | null;
  /**
   * Per-task exam configuration generated by the LLM when the task is
   * marked complete. Populated the first time the exam is generated.
   */
  exam?: TaskExam | null;
  /**
   * The stored result of the user's last exam attempt, once graded.
   * `null` before any submission or when the exam was dismissed.
   */
  examResult?: TaskExamResult | null;
}

/**
 * A short exam generated by the LLM for a single task (not a whole day).
 * Contains 3-5 questions, a mix of multiple-choice and short-answer.
 */
export interface TaskExam {
  taskName: string;
  questions: ExamQuestion[];
  createdAt: number;
}

/**
 * One exam question. MCQ questions carry `options`; short-answer questions
 * leave `options` undefined.
 */
export interface ExamQuestion {
  id: string;
  prompt: string;
  type: "multiple_choice" | "short_answer";
  options?: string[];
  referenceAnswer: string;
}

/**
 * The stored result of a graded task exam.
 */
export interface TaskExamResult {
  score: number; // 0-100
  passed: boolean; // score >= passing threshold
  needs_review: boolean; // score below a "careful" threshold
  message: string; // gentle AI feedback / hint to review
  gradedAt: number;
  answers: Record<string, string>;
  total: number;
  correct: number;
}

/**
 * Structured information gathered during the conversational pre-plan
 * intake flow. Passed along to roadmap generation so the produced
 * roadmap reflects the user's goals, level, time and constraints.
 */
export interface IntakeContext {
  topic: string;
  /** How much time the user can spend per day, free-text. */
  time_available?: string;
  /**
   * Phase B: the concrete minutes-per-day the user explicitly stated, as a
   * number. A roadmap is NEVER generated until this is set (no assumptions).
   */
  minutes_per_day?: number;
  /** The user's stated goal or purpose for learning this topic. */
  goal?: string;
  /** Inferred current skill level (beginner/intermediate/advanced). */
  level?: string;
  /** Any hard deadline / target date the user mentioned. */
  deadline?: string;
  /** Extra constraints the user mentioned, e.g. prerequisites or path. */
  constraints?: string;
  /** v3: how many days the user wants to spend ("N days"), free-text. */
  days_requested?: string;
  /**
   * Phase B: the exact number of days, as an integer >= 1. A roadmap is never
   * generated until this is set (the AI cannot assume it).
   */
  days_count?: number;
  /** Extracted resume/experience text when the user uploaded one. */
  resumeText?: string;
}

/** A curated learning reference attached to a roadmap day. */
export interface RoadmapReference {
  type: "docs" | "article" | "video";
  title: string;
  url: string;
  /** Channel/author name shown for videos (e.g. "Fireship"). */
  channel?: string;
}

/** A completed-task log entry (drives clickable History navigation). */
export interface CompletedItem {
  name: string;
  roadmapId?: string;
  dayNumber?: number;
}

export interface DayStats {
  date: string;
  sessions_count: number;
  focus_minutes: number;
  tasks_completed: number;
  total_tasks: number;
  productivity: number;
  /** Completed-task log for this day (History → jump-back feature). */
  completed_items?: CompletedItem[];
  /** v5: daily practice check-ins recorded that day (goal tracker). */
  check_ins?: number;
  // ---- ACTIVITY MEANING (req §15/§16) -------------------------------------
  /** Epoch ms of the user's first app visit that day (app-visit signal). */
  visitedAt?: number;
  /** Steps actually STARTED (timer started) that day — real learning. */
  steps_started?: number;
  /** Steps genuinely COMPLETED (question answered) that day. */
  steps_completed?: number;
  /** Day Assessments submitted that day (1 per day at most). */
  assessments_completed?: number;
  /** Final Exams submitted that day. */
  final_exams_completed?: number;
  /** Task names that contributed real practice time this day. */
  activity_tasks?: string[];
}

export interface TimerState {
  mode: TimerMode;
  isRunning: boolean;
  endTimestamp: number | null;
  completedWorkSessions: number;
  /** Id of the task currently being timed (null = generic work session). */
  activeTaskId: string | null;
  /** Countdown minutes for the active task (null = fall back to settings). */
  taskDurationMinutes: number | null;
  /**
   * Phase A3: when paused, the remaining ms of the countdown so a re-start
   * RESUMES from where the user left off instead of silently restarting.
   */
  pausedMs?: number | null;
  /**
   * Phase C: active (non-paused) ms of the current session, accumulated across
   * pauses. Used to measure the task's REAL minutes spent.
   */
  accruedMs?: number;
  /**
   * Epoch-ms of the current active run (null when paused/stopped). Used with
   * `accruedMs` to compute exact minutes spent for the active task.
   */
  runStartAt?: number | null;
}

export interface Settings {
  workMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  longBreakInterval: number;
  dailySessionGoal: number;
}

export interface RoadmapTask {
  name: string;
  priority: RoadmapPriority;
  estimated_minutes: number;
  /** User override in minutes; null means the AI estimate is untouched. */
  manual_minutes: number | null;
  /**
   * "Explain why" (Phase 3): a short, human-readable reason for this task's
   * placement and/or time estimate, generated inline with the roadmap so no
   * extra LLM call is needed. Optional.
   */
  reason?: string;
  /** Mirrored completion state so progress survives leaving the day. */
  is_done?: boolean;
}

export interface RoadmapDay {
  day_number: number;
  day_title: string;
  tasks: RoadmapTask[];
  is_completed: boolean;
  /**
   * "Explain why" (Phase 3): why this day is ordered after the previous one
   * (e.g. "Builds on the foundations introduced in Day 2"). Optional.
   */
  reason?: string;
  /** Curated references for THIS day's subtopics (2–4; omitted when unsure). */
  references?: RoadmapReference[];
  /**
   * Phase E: a short, specific search query / resource topic for this day
   * (e.g. "video: Django ORM basics tutorial"). The frontend turns it into a
   * YouTube search link — no real API integration needed.
   */
  search?: string;
}

export interface BadgeReward {
  title: string;
  icon: string;
}

export interface Roadmap {
  id: string;
  topic_name: string;
  badge_reward: BadgeReward;
  days: RoadmapDay[];
  status: RoadmapStatus;
  createdAt: number;
  /** §P5 confidence indicator from the LLM — display subtly as transparency. */
  confidence?: {
    level: "high" | "medium" | "low";
    reason: string;
  };
}

export interface Badge {
  id: string;
  title: string;
  icon: string;
  unlockedAt: number;
}

/**
 * One observed actual-vs-estimated sample used by adaptive time estimation
 * (Phase 2). Recorded each time a task-driven Pomodoro work session ends:
 * `estimated_minutes` is the task's planned (effective) minutes and
 * `actual_minutes` is the session that actually ran on the timer.
 */
export interface EstimationRecord {
  taskId: string;
  /** Snapshot of the task name at completion (stable even if renamed). */
  taskName: string;
  estimated_minutes: number;
  actual_minutes: number;
  /** actual / estimated — <1 means faster than estimated, >1 slower. */
  ratio: number;
  completedAt: number;
  /** (Phase 4) Measured focus quality for this sample (0-100), if tracked. */
  focus_percent?: number;
  /** Roadmap this session belonged to (History topic summaries). */
  roadmapId?: string;
  /** Day within that roadmap (per-topic focus totals). */
  dayNumber?: number;
}

/**
 * (Phase 4) Focus measurement captured for a single work session.
 * Pure client-side via the Page Visibility API; persisted to the
 * focus_sessions DynamoDB table at session end.
 */
export interface FocusSessionLog {
  taskName: string | null;
  mode: TimerMode;
  duration_minutes: number;
  distractions: number;
  distraction_seconds: number;
  focus_percent: number;
  session_id?: string;
}

/**
 * Compact calibration summary derived from the estimation log and passed to
 * the LLM prompt (roadmap generation + re-planning) so future estimates skew
 * toward the user's real pace. `ratio` is the (rolling) mean actual/estimated.
 */
export interface Calibration {
  ratio: number;
  sampleSize: number;
  recentMinutes: number;
}

export interface PomodoroAppState {
  /** The "YYYY-MM-DD" date this state currently belongs to. */
  activeDate: string;
  settings: Settings;
  timer: TimerState;
  tasks: Task[];
  history: Record<string, DayStats>;
  roadmaps: Roadmap[];
  badges: Badge[];
  /** Tracks which roadmap/day the current task list came from. */
  activeRoadmapDay: { roadmapId: string; dayNumber: number } | null;
  /** v5: multi-day practice goals with per-day check-ins. */
  practiceTasks: PracticeTask[];
  /**
   * Adaptive time-estimation samples (Phase 2): actual-vs-estimated records
   * used to calibrate future LLM time estimates. Persisted alongside the rest
   * of state (same localStorage schema).
   */
  estimationLog: EstimationRecord[];
/**
   * §13: persistent per-topic skill scores. Keyed by topic slug. Survives
   * reloads (localStorage) and is synced to the remote /api/skill-profile
   * endpoint when NEXT_PUBLIC_API_BASE_URL (deployed stack) is set — NOT a
   * new paid AWS service; uses the existing table design.
   */
  skillProfiles?: Record<string, SkillProfile>;
  /**
   * §12: results of FULL-ROADMAP mock exams (~20 MCQ), keyed by roadmap id so
   * a learner can review their last attempt per roadmap and the skill profile
   * can be recomputed from it.
   */
  roadmapExamResults?: Record<string, RoadmapExamResult>;

  /** §P3: repeated-failure tracker — records per-step wrong check-ins and
   *  per-topic mock-exam misses so the app can auto-insert prerequisite tasks. */
  failureTracker?: Record<string, number>;
}

/**
 * One ordered step of a task-owned roadmap ("Step 1 — Django Basics").
 * Steps are embedded INSIDE their parent task, so different tasks can
 * never share roadmap data by construction.
 */
/** A study/reference link attached to ONE specific roadmap step. */
export interface StepSource {
  type: "docs" | "article" | "video";
  title: string;
  url: string;
  /** Channel/author name shown for videos (e.g. "Fireship"). */
  channel?: string;
}

export interface RoadmapStep {
  id: string;
  title: string;
  /** Optional supporting note (sub-tasks, resources, reminders). */
  note?: string;
  /**
   * Which plan day (1..durationDays) this step is scheduled for. Absent
   * defaults to Day 1. A day automatically completes only when every step
   * assigned to that day is done.
   */
  dayNumber?: number;
  /**
   * The AI-generated title of the plan day this step belongs to (e.g.
   * "Django Introduction"). Used by the day-grouped roadmap UI; the first
   * step of each day supplies the group header's title.
   */
  dayTitle?: string;
  isDone: boolean;
  /**
   * User-set estimated duration in MINUTES ("2h" => 120, "45m" => 45).
   * Absent/0 = not yet estimated. Totals derive from the sum over steps.
   * Starting a step's timer requires an estimate (see the workspace UI).
   */
  estimated_minutes?: number;
  /**
   * Cumulative tackled/practiced time for this step, in SECONDS. Grows on
   * every running tick and every completed timer run; survives reloads.
   */
  practicedSeconds: number;
  /**
   * Elapsed seconds in the CURRENT run only (live count-up). Resets to 0
   * when a run finishes; merged into practicedSeconds on pause/finish.
   */
  elapsedSeconds: number;
  /** Status of this step's own timer. */
  timerStatus: "idle" | "running" | "paused" | "finished";
  /** Epoch ms when the current run started (drives live elapsed). */
  startedAt?: number;
  /** Curated study sources for THIS exact step/topic (requirement §1). */
  sources?: StepSource[];
  /**
   * Phase C: measured actual minutes spent once the step's timer genuinely
   * finishes (or the user explicitly confirms done). Set at finish time from
   * practicedSeconds; unset before a completing finish.
   */
  actual_minutes?: number;
  /** Phase C: "early" | "on-time" | "late" derived vs the estimate. */
  timing_outcome?: TimingOutcome;
  /** Phase C: structured per-step timing record (scoped strictly to this step). */
  timingRecord?: {
    estimated_minutes: number;
    actual_minutes: number;
    timing_outcome: TimingOutcome;
    completedAt: number;
  };
  /** Phase D: per-step exam questions generated from THIS step's content. */
  exam?: {
    stepName: string;
    questions: ExamQuestion[];
    createdAt: number;
  };
  /** Phase D: graded result of this step's last exam attempt. */
  examResult?: TaskExamResult;
  /**
   * Phase E: a short, specific suggested search for this step (e.g. "video:
   * Django ORM basics tutorial") turned into a YouTube search link.
   */
  search?: string;
/**
   * §10 Gating: a step is only genuinely COMPLETE when it has a completedAt
   * timestamp set by an explicit completing action (real timer finish OR an
   * explicit "Mark Done"). A bare checkbox flip must NOT set this, so the
   * day/task auto-completion cascade can never trigger from a stray click.
   */
  completedAt?: number;
  /** Whether completion came from the timer finishing ("timer") or an
   *  explicit "Mark Done" ("manual"). Drives how strictly the per-step
   *  check-in is required before progression. */
  completedBy?: "timer" | "manual";
  /**
   * §11: per-step check-in. When a step is genuinely completed the user
   * answers ONE short question specific to the step's topic before being
   * allowed to move on. Correctness is stored here and feeds the persistent
   * skill profile (lib/skills.ts) plus the roadmap-wide mock exam breakdown.
   */
  checkIn?: StepCheckIn;
  /**
   * Phase 1 (token saving): the check-in question, ONCE generated, is
   * persisted on the step so reopening the step (refresh / navigation /
   * re-render) reuses it instead of calling the LLM again.
   */
  checkInQuestion?: {
    question: string;
    options: string[];
    correctIndex: number;
    explanation?: string;
    difficulty?: "easy" | "medium" | "hard";
    source?: string;
  };
  /**
   * WORKFLOW §2/§5: STEP_QUESTION_PENDING — set when Finish is requested (the
   * step's timer has ended) but the mandatory per-step question has not been
   * answered. A step must NOT be set isDone while this is truthy; answering
   * the question (non-skipped) clears it and completes the step.
   */
  questionPending?: boolean;
  // ---- WORKFLOW AUDIT TRAIL (real-time timer monitoring, req §4) ----------
  /** Epoch ms when this step's timer was FIRST started (never overwritten). */
  firstStartedAt?: number;
  /** Epoch ms of the most recent resume (null until the first resume). */
  lastResumedAt?: number | null;
  /** Epoch ms when the timer was last paused (null when not paused). */
  lastPausedAt?: number | null;
  /** Epoch ms when the timer run FINISHED (finish press), if it ever did. */
  finishedAt?: number | null;
  /** How many times this step's timer was paused (0 = never paused). */
  pauseCount?: number;
}
/** §11: one short, per-step check-in (quick understanding gate). */
export interface StepCheckIn {
  question: string;
  /** Choices for an MCQ; absent for a short-answer prompt. */
  options?: string[];
  /** The user's submitted answer text. */
  answer: string;
  /** Whether the submitted answer was marked correct. */
  correct: boolean;
  /** Grading threshold used (higher = stricter). */
  passed: boolean;
  /** Epoch ms the check-in was answered. */
  answeredAt: number;
  /** Optional supporting explanation returned to the learner. */
  explanation?: string;
  /** §P2: difficulty label of the question asked. */
  difficulty?: "easy" | "medium" | "hard";
  /** §P5: which step/task this question was drawn from. */
  source?: string;
  /**
   * PART 2 §1: true when the learner submitted WITHOUT a valid answer
   * (provider outage / explicit unverified submit). The step still records
   * an answer timestamp, but it is explicitly flagged as unverified — never
   * silently counted as a successful completion.
   */
  skipped?: boolean;
}

/** §12: one question in the FULL-ROADMAP mock exam (~20 MCQ). Carries an
 * optional topic label so the result screen can report a per-day/per-topic
 * breakdown ("Hooks: 4/5, Routing: 2/5"). Added fields (§P2):
 *   - difficulty: "easy" | "medium" | "hard" — labelled mix per request
 *   - explanation: shown inline on a wrong answer (generated in the same call)
 *   - source: which roadmap task/day the question was drawn from (traceability). */
export interface RoadmapExamQuestion {
  id: string;
  /** "Assets React" => topic slug "react" used for the skill profile. */
  topic: string;
  day_number?: number;
  prompt: string;
  options: string[];
  referenceAnswer: string;
  /** §P2: difficulty label. */
  difficulty?: "easy" | "medium" | "hard";
  /** §P2: short explanation — shown when the learner gets this wrong. */
  explanation?: string;
  /** §P5: which task/day this question was drawn from. */
  source?: string;
}

/** §12: graded result of a full-roadmap mock exam. */
export interface RoadmapExamResult {
  score: number; // 0-20
  pct: number; // 0-100
  total: number; // == 20
  passed: boolean;
  /** Per-topic/per-day breakdown: "react" -> { correct, total }. */
  breakdown: Record<string, { correct: number; total: number }>;
  answers: Record<string, string>;
  /** §P2: map of question id -> explanation shown when that answer was wrong. */
  feedback?: Record<string, string>;
  gradedAt: number;
}

/* ============================================================
 * PART 2 — Assessments, exam locking + per-task score history
 * ============================================================ */

/** PART 2 §15: one immutable, graded assessment attempt (never overwritten). */
export interface AssessmentAttempt {
  /** Monotonic per-kind attempt number (1 = first attempt). */
  attempt: number;
  /** "day" (Day Assessment, 10-12q) or "exam" (Final Task Exam, 20-30q). */
  kind: "day" | "exam";
  /** Day number for kind="day"; undefined for the final exam. */
  day?: number;
  score: number;
  total: number;
  pct: number;
  passed: boolean;
  /** Per-question graded answers: questionId -> chosen option. */
  answers: Record<string, string>;
  /** Snapshot of the questions asked (id + prompt only, keeps docs small). */
  questions: { id: string; prompt: string }[];
  startedAt: number;
  submittedAt: number;
  /**
   * PART 2 §12/§14: per-question review record so a completed/submitted exam
   * can be reviewed later (question + the user's answer + the correct answer +
   * correctness + explanation). Persisted so refresh never loses it.
   */
  questionReview?: {
    id: string;
    prompt: string;
    selectedAnswer: string;
    correctAnswer: string;
    correct: boolean;
    explanation?: string;
  }[];
  /** PART 2 §14: map of questionId -> reference answer (correct answers). */
  correctAnswers?: Record<string, string>;
  /** PART 2 §14: map of questionId -> explanation for this question. */
  explanations?: Record<string, string>;
  /** PART 2 §14: elapsed attempt time in seconds (finish - start). */
  durationSeconds?: number;
  /** PART 2 §14: how many times the learner left Fullscreen during the exam. */
  fullscreenViolations?: number;
  /** PART 2 §14: how many times the tab lost visibility during the exam. */
  visibilityViolations?: number;
  /** PART 2 §8/§9: attempt life-cycle. "interrupted" records a terminated
   *  attempt (fullscreen/tab exit); such an attempt is NEVER graded/passed. */
  attemptState?: "completed" | "interrupted";
  /** PART 2 §8: human/machine-readable reason an attempt was interrupted. */
  interruptionReason?: string;
  /** PART 2 §8: the exam id this attempt belongs to (e.g. "day-1-<taskId>"). */
  examId?: string;
}

/** PART 2 §2/§9: durable, per-task assessment bookkeeping. Lives INSIDE the
 * task's progress document so it inherits the whole Phase 2 sync system. */
export interface TaskAssessment {
  /** Day numbers (1..durationDays) whose Day Assessment was submitted. */
  completedDays: number[];
  /** Latest attempt per assessed day: dayNumber -> result (history in attempts). */
  dayScores: Record<string, { score: number; total: number; pct: number; passed: boolean; submittedAt: number }>;
  /** Final exam summary; present only once submitted. */
  exam?: {
    score: number;
    total: number;
    pct: number;
    passed: boolean;
    submittedAt: number;
  };
  /** PART 2 §15: full attempt history — appends only, never overwritten. */
  attempts: AssessmentAttempt[];
  /** PART 2 §8: in-flight exam draft — persisted continuously so a refresh
   * restores the unfinished exam exactly where it was. Cleared on submit. */
  examDraft?: {
    examId: string;
    questions: RoadmapExamQuestion[];
    answers: Record<string, string>;
    /** 0-based index of the question the learner is on. */
    currentQuestion: number;
    startedAt: number;
    updatedAt: number;
    /** PART 2 §8: monitoring counters captured live into the draft so they
     * survive refresh and are recorded on an interrupted/terminated attempt. */
    fullscreenViolations?: number;
    visibilityViolations?: number;
  };
  /**
   * PART 2 §17 (token efficiency): the last generated question bank per Day
   * Assessment. Keyed by day number so re-opening an already-generated day
   * exam NEVER calls the LLM again. Cleared when the day is finally assessed.
   */
  dayQuestions?: Record<string, RoadmapExamQuestion[]>;
  /**
   * PART 2 §17 (token efficiency): the last generated Final Exam question
   * bank. Persisted so reopening the final exam does NOT re-call the LLM.
   */
  finalQuestions?: RoadmapExamQuestion[];
  /**
   * PART 2 §9: the nearest INTERRUPTED attempt requiring a visible retry.
   * When set, the Assessment Hub shows "Attempt Interrupted / Retry" instead
   * of pretending the exam never happened. Cleared on the next successful
   * submit of that exam.
   */
  interruptedAttempt?: {
    examId: string;
    kind: "day" | "exam";
    day?: number;
    reason: string;
    answeredCount: number;
    interruptedAt: number;
  };
}

/** PART 2 §9: one FINAL EXAM attempt (immutable once graded). */
export type ExamAttempt = AssessmentAttempt & { kind: "exam" };

/** §13: a persistent, per-topic skill score derived from check-ins + exams. */
export interface SkillProfile {
  /** Normalised topic id (lowercased, slugified), e.g. "react". */
  topic: string;
  /** Display name, e.g. "React". */
  label: string;
  /** 0-100 rolling score for this topic. */
  score: number;
  /** Number of mock-exam questions attempted in this topic. */
  questionsAttempted: number;
  /** Number answered correctly across check-ins + exams. */
  correct: number;
  /** Total counted answers (denominator for score). */
  total: number;
  /** Count of roadmap mock exams taken on this topic. */
  examsTaken: number;
  /** Epoch ms of the most recent update. */
  lastUpdated: number;
}

/**
 * v5 — a multi-day practice goal ("Learn Django in 7 days").
 * Progress = how many of the N planned days the user checked in.
 * Status is ALWAYS derived from dates in lib/practice.ts, never stored.
 */
export interface PracticeTask {
  id: string;
  name: string;
  description?: string;
  /** "YYYY-MM-DD" IST — Day 1. Defaults to creation day. */
  startDate: string;
  durationDays: number;
    /** Checked-in day numbers (1..durationDays), order = completion order. */
  checkIns: number[];
  /**
   * §5: when true the task is permanently marked Completed (all its
   * roadmap steps were finished). Persisted so it survives reloads and
   * the dashboard shows the correct completed-task count. Derived in
   * lib/practice.ts but cached here to avoid recomputation + flickering.
   */
  is_completed?: boolean;
  createdAt: number;
  /**
   * Task + Roadmap architecture: ordered roadmap steps belonging ONLY to
   * this task. Absent ([]/undefined) for tasks created before roadmaps
   * existed — normalized to [] at load time in lib/storage.ts.
   */
  roadmap?: RoadmapStep[];
  /**
   * PART 2 §2/§8/§9/§15: durable per-task assessment state — Day Assessment
   * scores, the immutable attempt history (day + final exam), and the
   * in-flight final-exam draft (refresh-safe). Synced through the SAME
   * per-task progress document as everything else (Phase 2 architecture).
   */
  assessment?: TaskAssessment;
  /**
   * Phase 2 (durable progress): server-side revision number for this task's
   * PROGRESS# document in the DynamoDB `roadmaps` table. Undefined = never
   * synced. The remote doc is authoritative when its rev is higher; writes
   * are conditional (rev must increase) so stale tabs cannot silently
   * overwrite newer progress. `syncedAt` is the last successful push time.
   */
  rev?: number;
  syncedAt?: number;
}

export const STORAGE_KEY = "pomodoro:app:v1";

export const DEFAULT_SETTINGS: Settings = {
  workMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  longBreakInterval: 4,
  dailySessionGoal: 8,
};

export const DEFAULT_TIMER: TimerState = {
  mode: "work",
  isRunning: false,
  endTimestamp: null,
  completedWorkSessions: 0,
  activeTaskId: null,
  taskDurationMinutes: null,
  pausedMs: null,
  accruedMs: 0,
  runStartAt: null,
};

export const MODE_LABELS: Record<TimerMode, string> = {
  work: "Work Session",
  shortBreak: "Short Break",
  longBreak: "Long Break",
};

export const MODE_DURATION_MINUTES: Record<TimerMode, number> = {
  work: DEFAULT_SETTINGS.workMinutes,
  shortBreak: DEFAULT_SETTINGS.shortBreakMinutes,
  longBreak: DEFAULT_SETTINGS.longBreakMinutes,
};

/**
 * Returns the effective countdown duration (ms) for a timer state.
 * Work sessions honour the active task's effective minutes when set;
 * breaks fall back to the standard short/long break settings.
 */
export function getTimerDurationMs(
  timer: Pick<TimerState, "mode" | "taskDurationMinutes">,
  settings: Settings
): number {
  if (
    timer.mode === "work" &&
    timer.taskDurationMinutes != null &&
    timer.taskDurationMinutes > 0
  ) {
    return timer.taskDurationMinutes * 60 * 1000;
  }
  return MODE_DURATION_MINUTES[timer.mode] * 60 * 1000;
}

/**
 * Returns the effective minutes for a task/estimate:
 * the manual override when present, otherwise the AI estimate.
 */
export function effectiveMinutes(
  estimatedMinutes: number | null | undefined,
  manualMinutes: number | null | undefined
): number {
  if (manualMinutes != null && manualMinutes > 0) return manualMinutes;
  return estimatedMinutes && estimatedMinutes > 0
    ? estimatedMinutes
    : DEFAULT_SETTINGS.workMinutes;
}

/**
 * Phase C: derives the timing outcome for a completed task. Anything within
 * ±10% of the estimate counts as "on-time"; meaningfully under is "early";
 * meaningfully over is "late".
 */
export function deriveTimingOutcome(
  estimatedMinutes: number,
  actualMinutes: number
): TimingOutcome {
  const est = estimatedMinutes > 0 ? estimatedMinutes : 1;
  const ratio = actualMinutes / est;
  if (ratio < 0.9) return "early";
  if (ratio > 1.1) return "late";
  return "on-time";
}

/**
 * "Estimated" = sum of the AI-provided estimates (original, untouched).
 */
export function sumEstimatedMinutes(tasks: { estimated_minutes: number }[]): number {
  return tasks.reduce((sum, t) => sum + (t.estimated_minutes || 0), 0);
}

/**
 * "Your time today" = sum of effective minutes (manual overrides win,
 * otherwise the AI estimate). This is the budget used for re-planning.
 */
export function sumEffectiveMinutes(
  tasks: { estimated_minutes: number; manual_minutes?: number | null }[]
): number {
  return tasks.reduce(
    (sum, t) => sum + effectiveMinutes(t.estimated_minutes, t.manual_minutes),
    0
  );
}

/**
 * True if the user has manually overridden the time for any task.
 */
export function hasManualOverrides(
  tasks: { manual_minutes?: number | null }[]
): boolean {
  return tasks.some((t) => t.manual_minutes != null);
}