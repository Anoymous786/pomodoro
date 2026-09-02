import {
  ExamQuestion,
  IntakeContext,
  RoadmapPriority,
  TaskExamResult,
} from "./types";

/**
 * LLM provider abstraction.
 *
 * The active provider is chosen via the LLM_PROVIDER env var:
 *   - "grok"   -> uses GROK_API_KEY
 *   - "gemini" -> uses GEMINI_API_KEY
 *
 * Switching providers only requires changing LLM_PROVIDER; the
 * rest of the app calls generateRoadmap() / replanDay() which
 * delegate here.
 */

export type LlmProvider = "grok" | "gemini";

export interface RoadmapTaskRaw {
  name: string;
  priority: RoadmapPriority;
  /** Realistic AI time estimate (minutes) for this specific task. */
  estimated_minutes: number;
}

export interface RoadmapDayRaw {
  day_number: number;
  day_title: string;
  tasks: RoadmapTaskRaw[];
  /** §5.1 Curated references for this day's subtopics (0-4; omit if unsure). */
  references?: {
    /** "docs" | "article" | "video" */
    type?: string;
    title?: string;
    url?: string;
    /** YouTube channel name (videos only). */
    channel?: string;
  }[];
  /**
   * Phase E: a short, specific search query / resource topic for this day
   * (e.g. "video: Django ORM basics tutorial"). The frontend turns it into a
   * YouTube search link.
   */
  search?: string;
}

export interface RoadmapResponse {
  topic_name: string;
  badge_reward: { title: string; icon: string };
  days: RoadmapDayRaw[];
  /**
   * §P5 confidence indicator:  "high" | "medium" | "low" + one-line reason.
   * Displayed subtly near the generated roadmap purely as transparency.
   */
  confidence?: {
    level: "high" | "medium" | "low";
    reason: string;
  };
}

const SYSTEM_PROMPT = `You are a learning roadmap generator. Given a topic, produce a structured, day-by-day learning roadmap.

Respond with STRICT JSON ONLY — no markdown fences, no commentary, no trailing text. The JSON must exactly match this schema:

{
  "topic_name": string,
  "badge_reward": { "title": string, "icon": string },
  "days": [
    {
      "day_number": number,
      "day_title": string,
      "search": string,
      "tasks": [
        {
          "name": string,
          "priority": "High" | "Medium" | "Low",
          "estimated_minutes": number
        }
      ],
      "references": [
        { "type": "docs" | "article" | "video", "title": string, "url": string, "channel": string }
      ]
    }
  ],
  "confidence": { "level": "high" | "medium" | "low", "reason": string }
}

Rules:
- SUPPORTED DAY COUNTS: only 1, 3 or 7 days (req §7). If the requested count is not one of these, pick the closest supported value and generate that.
- The JSON MUST contain EXACTLY the number of "day_number" entries the user requested. If the user asked for N days, you MUST output exactly N day objects (day 1 through day N). Do not output fewer, do not output more, do not merge days. Count them before you finish.
- Each day should have 3 to 6 concrete, actionable tasks.
- DAY-SPECIFIC STEPS (req §7): every day must have its OWN specific tasks for that day's learning objective. NEVER repeat the same generic task name on multiple days. Day 1 covers fundamentals/introduction, Day 2 builds on Day 1, and so on — the tasks must visibly progress.
- "priority" must be exactly one of: "High", "Medium", "Low".
- "estimated_minutes" must be a realistic, task-specific estimate of how many minutes that task actually takes to complete for a typical INTERMEDIATE learner working at a normal pace (e.g. "Read a chapter" might be 25-40 min, "Build a TODO API endpoint" might be 60-90 min). Base each estimate on the specific subtopic — never use one flat default for every task. EVERY task MUST carry a positive estimated_minutes — a task without one is a validation error.
- When the user provides a per-day time budget ("time available per day", e.g. 60 minutes), keep each day's TOTAL estimated task minutes at or under that budget. Combine related tasks, trim low-priority ones, or split a big task across days as needed so no single day exceeds the daily time budget.
- "search": for each day provide a short, specific search query/resource topic that matches that day's focus (e.g. "video: Django ORM basics tutorial" or "how to set up Django + PostgreSQL"). The frontend turns this into a YouTube search link. Make it specific to the day, not generic.
- "references": for each day, include 2 to 4 REAL, well-known resources you are confident exist, matching the day's subtopics. Aim for: one official documentation link ("type":"docs"), one written tutorial or article ("type":"article"), and one specific YouTube video with its real video title in "title" and the channel name in "channel" ("type":"video"). Use full https:// URLs. If you are NOT confident a resource is real, OMIT it entirely — never invent URLs, never output placeholders.
- "icon" should be a short emoji (e.g. "🚀", "🏆", "🎯").
- The roadmap should be realistic and progressive (foundations first, then advanced).`;

const REPLAN_SYSTEM_PROMPT = `You are an AI task planner. You will receive a list of tasks for a single day, along with the total time budget the user has available that day (in minutes).

Your job: re-prioritize, merge, or trim the tasks so they realistically fit within the time budget.

Rules:
- Keep "High" priority tasks intact where possible — they are the highest priority.
- If the total estimated time exceeds the budget:
  - First trim or split Medium/Low priority tasks.
  - Merge related tasks into a single broader task if that saves time.
  - Only drop tasks as a last resort, preferring to drop the lowest-priority ones first.
- If the total estimated time is well under the budget, you may expand or split tasks to make better use of the time, or add one small "review / recap" task that uses the remaining budget.
- Preserve the spirit of the original task list — do not invent completely unrelated work unless you are adding a recap/review task to fill spare budget.
- Give each task a realistic "estimated_minutes" value.

Respond with STRICT JSON ONLY — no markdown fences, no commentary. The JSON must exactly match this schema:

{
  "tasks": [
    {
      "name": string,
      "priority": "High" | "Medium" | "Low",
      "estimated_minutes": number
    }
  ]
}

- "priority" must be exactly one of: "High", "Medium", "Low".
- "estimated_minutes" must be a positive number.
- Do not include commentary outside the JSON object.`;

/**
 * Returns the configured provider, defaulting to "grok".
 */
export function getProvider(): LlmProvider {
  const provider = process.env.LLM_PROVIDER?.toLowerCase();
  if (provider === "gemini") return "gemini";
  return "grok";
}
/**
 * §14 LLM provider fallback.
 *
 * Most calls try the configured "primary" provider first. If that call fails
 * with a RATE-LIMIT / QUOTA error specifically (HTTP 429, "insufficient
 * quota", "rate limit", "Resource has been exhausted"), the SAME request is
 * retried once against the other provider. Other errors (bad key, timeout,
 * malformed JSON, empty response) are NOT swallowed — they propagate as-is so
 * the caller shows a truthful message.
 *
 * Which provider actually served the request is logged server-side only;
 * it is never surfaced to the UI.
 */
export function isRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const rateLimited =
    /429|rate.?limit|insufficient_quota|quota|resource has been exhausted|1000/i.test(
      message
    );
  // Phase 1 (token overflow): an oversize/over-budget request is exactly the
  // transient condition the Gemini fallback exists for — Groq returns
  // 413 "Request too large" / "context_length_exceeded" / TPM errors with
  // varying wording, so classify them as qualifying failures too. Callers
  // must already have compacted the payload; the fallback receives the SAME
  // compact payload (never a re-sent raw one).
  const oversize =
    /413|request too large|context_length_exceeded|context length exceeded|too many tokens|tokens per min|reduce the length of (the )?(messages|prompt)|payload too large/i.test(
      message
    );
  // Never fall back for a hard configuration error (missing key).
  return (rateLimited || oversize) && !/is not set/i.test(message);
}

function logProviderUsed(provider: LlmProvider, kind: string): void {
  // Server-only diagnostic; never exposed to the client UI.
  if (typeof console !== "undefined") {
    console.log(`[llm] ${kind} served by provider=${provider}`);
  }
}

const opposite: Record<LlmProvider, LlmProvider> = {
  gemini: "grok",
  grok: "gemini",
};

/**
 * Runs `primary(p)` (using the configured provider). On a rate-limit/quota
 * error only, retries the SAME request via the other provider. Returns the
 * first successful result. Logs whichever provider actually served it.
 */
export async function runWithProviderFallback<T>(
  kind: string,
  primary: LlmProvider,
  run: (provider: LlmProvider) => Promise<T>
): Promise<T> {
  try {
    const out = await run(primary);
    logProviderUsed(primary, kind);
    return out;
  } catch (err) {
    if (!isRateLimitError(err)) throw err;
    // Rate-limited on the primary -> try the other provider once.
    const fallback = opposite[primary];
    try {
      const out = await run(fallback);
      logProviderUsed(fallback, `${kind} (after ${primary} rate-limit fallback)`);
      return out;
    } catch (fbErr) {
      // Prefer the original (rate-limit) error so the user sees "try again";
      // a nested secondary failure is secondary.
      throw err;
    }
  }
}

/**
 * Strips markdown code fences if the model wrapped the JSON in them.
 */
export function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  // Remove ```json ... ``` or ``` ... ``` wrappers.
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

/**
 * Safely parses the LLM response into a RoadmapResponse.
 * Throws an Error with a clear message if parsing/validation fails.
 */
export function parseRoadmapResponse(raw: string): RoadmapResponse {
  const cleaned = stripMarkdownFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(
      "The model did not return valid JSON. Please try again."
    );
  }

  if (!isRoadmapResponse(parsed)) {
    throw new Error(
      "The model returned JSON that does not match the expected roadmap schema. Please try again."
    );
  }

  return parsed;
}

/**
 * Type guard for the roadmap response schema.
 */
function isRoadmapResponse(value: unknown): value is RoadmapResponse {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;

  if (typeof obj.topic_name !== "string") return false;

  const badge = obj.badge_reward as Record<string, unknown> | undefined;
  if (
    typeof badge !== "object" ||
    badge === null ||
    typeof badge.title !== "string" ||
    typeof badge.icon !== "string"
  ) {
    return false;
  }

  if (!Array.isArray(obj.days) || obj.days.length === 0) return false;

  for (const day of obj.days) {
    if (typeof day !== "object" || day === null) return false;
    const d = day as Record<string, unknown>;
    if (typeof d.day_number !== "number") return false;
    if (typeof d.day_title !== "string") return false;
    if (!Array.isArray(d.tasks) || d.tasks.length === 0) return false;
    for (const task of d.tasks) {
      if (typeof task !== "object" || task === null) return false;
      const t = task as Record<string, unknown>;
      if (typeof t.name !== "string") return false;
      if (t.priority !== "High" && t.priority !== "Medium" && t.priority !== "Low") {
        return false;
      }
      if (
        typeof t.estimated_minutes !== "number" ||
        !(t.estimated_minutes > 0)
      ) {
        return false;
      }
    }
  }

  // §P5: confidence is optional and must be well-formed when present.
  if (obj.confidence !== undefined) {
    const conf = obj.confidence as Record<string, unknown> | null;
    if (typeof conf !== "object" || conf === null) return false;
    if (
      conf.level !== "high" &&
      conf.level !== "medium" &&
      conf.level !== "low"
    ) {
      return false;
    }
    if (typeof conf.reason !== "string") return false;
  }

  return true;
}

/**
 * Safely parses the replan response into a ReplanResponse.
 */
export function parseReplanResponse(raw: string): ReplanResponse {
  const cleaned = stripMarkdownFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(
      "The model did not return valid JSON. Please try again."
    );
  }

  if (!isReplanResponse(parsed)) {
    throw new Error(
      "The model returned JSON that does not match the expected replan schema. Please try again."
    );
  }

  return parsed;
}

/**
 * Type guard for the replan response schema.
 */
function isReplanResponse(value: unknown): value is ReplanResponse {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) return false;

  for (const task of obj.tasks) {
    if (typeof task !== "object" || task === null) return false;
    const t = task as Record<string, unknown>;
    if (typeof t.name !== "string") return false;
    if (
      t.priority !== "High" &&
      t.priority !== "Medium" &&
      t.priority !== "Low"
    ) {
      return false;
    }
    if (typeof t.estimated_minutes !== "number" || !(t.estimated_minutes > 0)) {
      return false;
    }
  }

  return true;
}

export interface ReplanTaskRaw {
  name: string;
  priority: RoadmapPriority;
  estimated_minutes: number;
}

export interface ReplanResponse {
  tasks: ReplanTaskRaw[];
}

// ============================================================
// Public entry points
// ============================================================

/**
 * Builds a single user prompt for the roadmap generator from a topic
 * plus all context collected during the pre-plan intake flow.
 */
/** Parses the exact requested day count from the intake context.
 *  WORKFLOW §7: only 1, 3 and 7-day roadmaps are supported (Groq token
 *  reliability), so any other requested count snaps to the nearest option. */
export function requestedDayCount(context?: IntakeContext): number | null {
  const SUPPORTED_DAYS = [1, 3, 7];
  let raw: number | null = null;
  if (!context) return null;
  if (
    typeof context.days_count === "number" &&
    Number.isFinite(context.days_count) &&
    context.days_count >= 1
  ) {
    raw = Math.floor(context.days_count);
  } else if (context.days_requested) {
    const m = String(context.days_requested).match(/(\d+)/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 1) raw = n;
    }
  }
  if (raw === null) return null;
  if (SUPPORTED_DAYS.includes(raw)) return raw;
  // Snap to the nearest supported count (ties round up: 2 -> 3, 5 -> 7).
  return SUPPORTED_DAYS.reduce((best, d) =>
    Math.abs(d - raw!) < Math.abs(best - raw!) ? best : d,
  );
}

/** Parses the user's concrete minutes-per-day from the intake context. */
export function minutesPerDay(context?: IntakeContext): number | null {
  if (!context) return null;
  if (
    typeof context.minutes_per_day === "number" &&
    Number.isFinite(context.minutes_per_day) &&
    context.minutes_per_day > 0
  ) {
    return context.minutes_per_day;
  }
  if (context.time_available) {
    const m = String(context.time_available).match(
      /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b(?:\s*(\d+)\s*(?:minutes?|mins?|m)\b)?/i
    );
    if (m) {
      let mins = parseFloat(m[1]) * 60;
      if (m[2]) mins += parseInt(m[2], 10);
      if (Number.isFinite(mins) && mins > 0) return Math.round(mins);
    }
    const mins = String(context.time_available).match(
      /(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/i
    );
    if (mins) {
      const n = parseFloat(mins[1]);
      if (Number.isFinite(n) && n > 0) return Math.round(n);
    }
  }
  return null;
}

export function buildRoadmapUserPrompt(
  topic: string,
  context?: IntakeContext
): string {
  const parts: string[] = [`Topic: ${topic}`, ""];
  if (context?.goal) parts.push(`The learner's goal: ${context.goal}`);
  const dayCount = requestedDayCount(context);
  const dailyBudget = minutesPerDay(context);
  if (dayCount !== null) {
    parts.push(
      `STRICT DAY COUNT: The learner wants exactly ${dayCount} days. The JSON "days" array MUST contain exactly ${dayCount} entries (day_number 1 through ${dayCount}). No more, no fewer. Count them before responding.`
    );
  } else if (context?.days_requested) {
    parts.push(
      `Day budget: the learner wants to finish in ${context.days_requested}. Generate EXACTLY that many day entries.`
    );
  }
  if (dailyBudget !== null) {
    parts.push(
      `Time budget: the learner can spend approximately ${dailyBudget} minutes per day. Keep each day's TOTAL estimated task minutes at or under ${dailyBudget} minutes. Trim, merge, or rebalance tasks so no single day exceeds this budget.`
    );
  } else if (context?.time_available) {
    parts.push(`Time available per day: ${context.time_available}`);
  }
  if (context?.level)
    parts.push(`Current skill level: ${context.level}`);
  if (context?.deadline)
    parts.push(`Deadline / target date: ${context.deadline}`);
  if (context?.constraints)
    parts.push(`Personal constraints / preferences: ${context.constraints}`);
  if (context?.resumeText)
    parts.push(
      `The learner's resume / experience (use this to calibrate difficulty and skip what they already know):\n${context.resumeText.slice(
        0,
        6000
      )}`
    );
  parts.push("");
  parts.push(
    "Generate a detailed learning roadmap for this topic, tailored to the above context."
  );
  return parts.join("\n");
}
/**
 * §15 ROADMAP QUALITY VALIDATION (post-parse, before returning to the UI).
 * Beyond the schema checks in isRoadmapResponse, this verifies the roadmap is
 * genuinely usable:
 *   - day count exactly matches the requested 1/3/7 (when given)
 *   - every day has at least one task
 *   - every task has a positive estimated_minutes
 *   - no duplicate day titles
 *   - no duplicate / near-identical tasks across the whole roadmap (ignoring
 *     case, punctuation and leading "Step N:"/"task N:" markers)
 * Returns a list of human-readable problems (empty = roadmap is good).
 */
export function validateRoadmapIssues(
  roadmap: RoadmapResponse,
  dayCount: number | null
): string[] {
  const issues: string[] = [];

  if (!Array.isArray(roadmap.days) || roadmap.days.length === 0) {
    issues.push("The roadmap has no days.");
    return issues;
  }

  if (dayCount !== null && roadmap.days.length !== dayCount) {
    issues.push(
      `Requested exactly ${dayCount} days but got ${roadmap.days.length}.`,
    );
  }

  // day_number must be the dense sequence 1..N — the workspace UI groups
  // steps by it, so gaps/skips would render phantom "Day N" groups.
  roadmap.days.forEach((day, idx) => {
    if (day.day_number !== idx + 1) {
      issues.push(
        `Day ${idx + 1} is numbered ${day.day_number}; day_number must run 1..${roadmap.days.length} with no gaps.`,
      );
    }
  });

  const dayTitlesSeen = new Map<string, number>();
  const taskNamesSeen = new Map<string, number>();

  for (const day of roadmap.days) {
    if (!Array.isArray(day.tasks) || day.tasks.length === 0) {
      issues.push(`Day ${day.day_number} has no tasks.`);
      continue;
    }
    const dayTitleKey = day.day_title.trim().toLowerCase();
    const priorDay = dayTitlesSeen.get(dayTitleKey);
    if (priorDay !== undefined) {
      issues.push(
        `Duplicate day title "${day.day_title}" (days ${priorDay} and ${day.day_number}).`,
      );
    }
    dayTitlesSeen.set(dayTitleKey, day.day_number);

    for (const task of day.tasks) {
      if (typeof task.estimated_minutes !== "number" || task.estimated_minutes <= 0) {
        issues.push(`Task "${task.name}" on Day ${day.day_number} has no positive estimated_minutes.`);
      }
      // Normalize for near-identical detection: lowercase, strip punctuation,
      // and drop leading "Step N:" / "Task N:" / "- " markers.
      const norm = task.name
        .toLowerCase()
        .replace(/^\s*(?:step|task)\s*\d+\s*[:.\-)\]]*\s*/i, "")
        .replace(/^[\s\-•*.\d)]+/, "")
        .replace(/[^\w\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!norm) continue;
      const priorTask = taskNamesSeen.get(norm);
      if (priorTask !== undefined) {
        issues.push(`Near-duplicate task "${task.name}" (days ${priorTask} and ${day.day_number}).`);
      } else {
        taskNamesSeen.set(norm, day.day_number);
      }
    }
  }

  return issues;
}

/**
 * Calls the configured LLM provider with the user's topic (and optional
 * intake context) and returns a validated RoadmapResponse.
 *
 * Phase A1 / Phase B enforcement:
 *  - The number of days in the response is validated SERVER-SIDE against the
 *    requested day count. If the model returns the wrong number of days, we
 *    retry ONCE with an explicit correction note in the prompt. If it still
 *    mismatches, we fail visibly (never silently shorten the roadmap).
 *  - When the user gave a concrete minutes-per-day budget, any day whose
 *    total estimated minutes meaningfully overshoots the budget triggers an
 *    automatic re-plan pass (via replanDay) before the roadmap is returned.
 */
export async function generateRoadmap(
  topic: string,
  context?: IntakeContext
): Promise<RoadmapResponse> {
  const provider = getProvider();
  const dayCount = requestedDayCount(context);
  const budget = minutesPerDay(context);

  const runOnce = (prompt: string) =>
    runWithProviderFallback(
      "roadmap",
      provider,
      (p) => (p === "gemini" ? generateWithGemini(prompt) : generateWithGrok(prompt))
    );

  let basePrompt = buildRoadmapUserPrompt(topic, context);

  // First attempt.
  let roadmap = await runOnce(basePrompt);
  let issues = validateRoadmapIssues(roadmap, dayCount);

  // §15: if the roadmap fails QUALITY validation (wrong day count, missing/
  // duplicate day titles or steps, no estimated_minutes), retry ONCE with a
  // corrective prompt. Never return a broken roadmap.
  if (issues.length > 0) {
    basePrompt = `${basePrompt}\n\nCORRECTION AFTER THE PREVIOUS ATTEMPT: Your previous roadmap had these problems:\n- ${issues.join("\n- ")}\nRe-generate the ENTIRE roadmap so ALL of the above are fixed. Keep exactly ${dayCount ?? "the requested"} day entries, give every task a positive "estimated_minutes" that sums to the user's daily budget where given, and never repeat the same subtopic/step across different days.`;
    roadmap = await runOnce(basePrompt);
    issues = validateRoadmapIssues(roadmap, dayCount);
    if (issues.length > 0) {
      throw new Error(
        `The roadmap did not pass validation after retrying: ${issues[0]}`,
      );
    }
  }

  // Phase B: enforce the per-day time budget with an automatic re-plan pass.
  if (budget !== null) {
    roadmap = await enforceDailyTimeBudget(roadmap, budget, topic);
  }

  // Re-validate after the re-plan pass (it can surface missing/duplicate
  // tasks); if it regressed past a small tolerance, honour the day-count
  // rule at minimum so we never hand back an unusable roadmap.
  const finalIssues = validateRoadmapIssues(roadmap, dayCount);
  if (finalIssues.length > 0 && dayCount !== null && roadmap.days.length !== dayCount) {
    throw new Error(
      `The roadmap did not pass validation after the time-budget re-plan: ${finalIssues[0]}`,
    );
  }

  return roadmap;
}

/**
 * For every day whose total estimated minutes overshoots the daily budget,
 * run replanDay (the existing LLM re-plan) and replace that day's tasks.
 * Bounded to the days that actually overshoot; never touches within-budget
 * days. Blocks each call, so 3-5 overshoot days is the typical worst case.
 */
async function enforceDailyTimeBudget(
  roadmap: RoadmapResponse,
  budget: number,
  topic: string
): Promise<RoadmapResponse> {
  const tolerance = budget * 1.1; // ±10% band — a day counts as over-budget
  // only when it meaningfully exceeds the user's stated per-day time.
  const rebalanced: RoadmapDayRaw[] = [];

  for (const day of roadmap.days) {
    const total = (day.tasks ?? []).reduce(
      (sum, t) => sum + (t.estimated_minutes || 0),
      0
    );
    if (total > tolerance && day.tasks.length > 0) {
      try {
        const replanned = await replanDay(day.tasks, budget, {
          topic,
          dayNumber: day.day_number,
          calibration: { averageRatio: 1, sampleSize: 0 },
        });
        rebalanced.push({ ...day, tasks: replanned.tasks });
        continue;
      } catch {
        // Keep the overshooting day as-is if the re-plan fails rather than
        // hard-fail the entire generation.
        rebalanced.push(day);
        continue;
      }
    }
    rebalanced.push(day);
  }

  return { ...roadmap, days: rebalanced };
}

/**
 * Re-plans a single day's tasks with the LLM to fit a time budget.
 * `tasks` is the day's current task list; `budgetMinutes` is the
 * user's available time for the day (sum of effective minutes).
 *
 * §4.2 The optional context carries everything the button sends:
 * topic, day number, tasks already completed, time already logged,
 * hand-tuned ("locked") estimates, and the user's pace calibration —
 * all folded into the prompt so the re-plan is genuinely informed.
 */
export interface ReplanContext {
  topic?: string;
  dayNumber?: number;
  completedTasks?: string[];
  spentMinutes?: number;
  lockedTasks?: string[];
  calibration?: Record<string, unknown>;
}

export async function replanDay(
  tasks: {
    name: string;
    priority: RoadmapPriority;
    estimated_minutes?: number;
  }[],
  budgetMinutes: number,
  context: ReplanContext = {}
): Promise<ReplanResponse> {
  const provider = getProvider();
  const list = tasks.map((t) => ({
    name: t.name,
    priority: t.priority,
    estimated_minutes: t.estimated_minutes ?? 25,
  }));
  const parts: string[] = [];
  if (context.topic) {
    parts.push(
      `Topic: ${context.topic}${context.dayNumber ? ` (Day ${context.dayNumber})` : ""
      }`
    );
  }
  if (context.completedTasks?.length) {
    parts.push(
      `Already completed (do NOT remove or re-assign them, work around them):\n${context.completedTasks
        .map((n) => `- ${n}`)
        .join("\n")}`
    );
  }
  if (typeof context.spentMinutes === "number" && context.spentMinutes > 0) {
    parts.push(
      `Time already logged on this day: ${context.spentMinutes} minutes (account for it when fitting the remaining budget).`
    );
  }
  if (context.lockedTasks?.length) {
    parts.push(
      `Tasks with manually tuned time estimates (keep their names; only change them if strictly necessary): ${context.lockedTasks
        .map((n) => `"${n}"`)
        .join(", ")}`
    );
  }
  const calib = context.calibration as {
    averageRatio?: number;
    sampleSize?: number;
  } | null | undefined;
  if (calib && typeof calib.averageRatio === "number" && calib.sampleSize) {
    parts.push(
      `User pace calibration: this learner actually takes ~${Math.round(
        calib.averageRatio * 100
      )}% of the estimated time on average (${calib.sampleSize} recent samples). Scale estimates accordingly.`
    );
  }

  const userPrompt = `${parts.length ? `${parts.join("\n\n")}\n\n` : ""}Total time budget: ${budgetMinutes} minutes

Current tasks:
${JSON.stringify(list, null, 2)}

Re-plan these tasks to fit the ${budgetMinutes}-minute budget.`;

  return runWithProviderFallback("replan", provider, (p) =>
    p === "gemini" ? replanWithGemini(userPrompt) : replanWithGrok(userPrompt)
  );
}

// ============================================================
// Adaptive pre-plan intake
// ============================================================

export interface IntakeTurn {
  role: "user" | "assistant";
  content: string;
}

export interface IntakeRequest {
  topic: string;
  history: IntakeTurn[];
  knownFields?: Partial<IntakeContext>;
  resumeText?: string;
}

export interface IntakeDecision {
  next_question?: string;
  done: boolean;
  likely_goal?: string;
  likely_level?: string;
}

const INTAKE_SYSTEM_PROMPT = `You are the intake coordinator for a learning-roadmap assistant. You run a short,
friendly conversation (one question at a time) to gather the minimum the planner needs before generating a roadmap.

The user wants to learn: <topic>. Information the user may have already provided must be treated as answered; never re-ask.

Rules:
- Ask exactly ONE question per turn.
- You may ask about: time available per day, the user's goal/purpose for learning, current skill level, any deadline or target
date, and specific constraints (e.g. prerequisites, preferred path).
- If the user's last message already covers multiple needs in one answer, extract what was covered and ask only about what is
still missing.
- If a resume/experience text is provided, infer skill level from it and NEVER ask the level question.
- STOP as soon as you have enough to build a solid roadmap. Prefer fewer questions. If you only need one more detail, ask it.

Respond with STRICT JSON ONLY — no markdown fences, no commentary. The JSON must be exactly this schema:
{
  "next_question": string | null,
  "done": boolean,
  "likely_goal": string | null,
  "likely_level": string | null
}
- "done" is true exactly when you can generate the roadmap now; then "next_question" must be null.
- "next_question" is your single question and is non-empty exactly when "done" is false.
- "likely_goal" / "likely_level" are short inferences (or null when unknown).
- Stay conversational; don't sound like a form.`;

export function isIntakeDecision(value: unknown): value is IntakeDecision {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  if (typeof o.done !== "boolean") return false;
  if (o.next_question !== null && typeof o.next_question !== "string") return false;
  if (o.likely_goal !== null && o.likely_goal !== undefined && typeof o.likely_goal !== "string") return false;
  if (o.likely_level !== null && o.likely_level !== undefined && typeof o.likely_level !== "string") return false;
  return true;
}

export function parseIntakeDecision(raw: string): IntakeDecision {
  const cleaned = stripMarkdownFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Fall back gracefully so the flow can still finish on a bad parse.
    return { done: true };
  }
  if (!isIntakeDecision(parsed)) {
    return { done: true };
  }
  return parsed;
}
/**
 * Generic provider dispatcher so any system prompt can be run through
 * whichever LLM provider is configured (Grok/Groq or Gemini).
 */
export async function callProvider(
  provider: LlmProvider,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  return runWithProviderFallback("generic-llm", provider, (p) => {
    if (p === "gemini") {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not set.");
      }
      return callGemini(apiKey, systemPrompt, userPrompt);
    }
    const apiKey = process.env.GROK_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GROK_API_KEY is not set. Add it to your environment to use this provider."
      );
    }
    return callGroq(apiKey, systemPrompt, userPrompt);
  });
}

/**
 * Asks the LLM for the next intake question — or a "done" signal once
 * it has enough context to generate a solid roadmap.
 */
export async function generateIntake(
  request: IntakeRequest
): Promise<IntakeDecision> {
  const provider = getProvider();
  const known = request.knownFields ?? {};
  const knownSummary = [
    known.goal ? `Goal: ${known.goal}` : "",
    known.time_available ? `Time available/day: ${known.time_available}` : "",
    known.level ? `Skill level: ${known.level}` : "",
    known.deadline ? `Deadline: ${known.deadline}` : "",
    known.constraints ? `Constraints: ${known.constraints}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const resumeNote = request.resumeText
    ? `\nA resume/experience text was provided (${request.resumeText.length} chars). Infer skill level from it and do NOT ask about level.\nLevel inferred from resume: ${known.level ?? "(see resume excerpt below)"}\nResume excerpt:\n${request.resumeText.slice(0, 3000)}`
    : "";

  const conversation = request.history
    .map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`)
    .join("\n");

  const userPrompt = `Topic to learn: ${request.topic}

Already known so far:
${knownSummary || "(none yet)"}
${resumeNote}

Conversation so far:
${conversation || "(the conversation has not started yet)"}

Continue the intake conversation. Ask your next single question, or signal that you are done.`;

  const raw = await callProvider(provider, INTAKE_SYSTEM_PROMPT, userPrompt);
  return parseIntakeDecision(raw);
}
// ============================================================
// Per-task exam
// ============================================================

/**
 * Phase D: a task-specific exam is ALWAYS a 10-question multiple-choice quiz
 * drawn strictly from the single task the learner just completed (never the
 * whole day or the whole roadmap). The MCQ format is fast for the learner
 * and trivially machine-gradeable, and 10 questions give a stable accuracy
 * percentage.
 */
const EXAM_SYSTEM_PROMPT = `You create a 10-question multiple-choice quiz that verifies a learner understood the EXACT task they just completed — not the whole day and not the whole roadmap. Every question must target THIS task's specific content, commands, and skills.

Rules:
- Build EXACTLY 10 multiple-choice questions (no short-answer).
- Provide exactly 4 options for each question.
- "referenceAnswer" must EXACTLY match one of those option strings (case + wording).
- Make the questions specific to the task (e.g. if the task was "Install Django", ask about pip install, django-admin startproject, the dev server command, settings.py, migrations, etc. — not generic Python).

Respond with STRICT JSON ONLY — no markdown fences. The JSON must exactly match this schema:
{
  "questions": [
    {
      "id": string,
      "prompt": string,
      "type": "multiple_choice",
      "options": [string, string, string, string],
      "referenceAnswer": string
    }
  ]
}
- "id" is any short unique string.
- The "questions" array MUST contain exactly 10 entries.`;

export interface ExamGenerationRequest {
  taskName: string;
  /** Extra context: roadmap topic / day title, when available. */
  context?: string;
}

/**
 * Phase D: generates EXACTLY 10 multiple-choice, task-specific questions via
 * the LLM. If the model returns anything other than 10 valid MCQs, it is
 * retried ONCE with an explicit correction note before failing visibly — so a
 * malformed model response can never silently yield a shortened quiz.
 */
export async function generateExam(
  request: ExamGenerationRequest
): Promise<ExamQuestion[]> {
  const provider = getProvider();
  const basePrompt = `Task just completed: ${request.taskName}${request.context ? `\nContext: ${request.context}` : ""
    }

Generate the quiz for THIS task now. It MUST contain exactly ${EXAM_QUESTION_COUNT} multiple-choice questions.`;

  const parse = (raw: string) => parseExamQuestions(raw);
  try {
    const raw = await callProvider(provider, EXAM_SYSTEM_PROMPT, basePrompt);
    return parse(raw);
  } catch (firstErr) {
    // Retry ONCE with an explicit correction note, mirroring Phase A1.
    const retryPrompt = `${basePrompt}

CORRECTION AFTER THE PREVIOUS ATTEMPT: Your previous response was rejected because it did not contain exactly ${EXAM_QUESTION_COUNT} valid multiple-choice questions (each with exactly 4 options and a referenceAnswer that matches one option). Re-generate the ENTIRE quiz with exactly ${EXAM_QUESTION_COUNT} multiple-choice questions about: ${request.taskName}.`;
    const raw = await callProvider(provider, EXAM_SYSTEM_PROMPT, retryPrompt);
    return parse(raw);
  }
}

/**
 * Validates + normalizes an LLM exam response into ExamQuestion[].
 * Phase D: a per-task exam is ALWAYS exactly 10 multiple-choice questions, so
 * only MCQ items are accepted and the final array MUST hold exactly 10. Any
 * non-MCQ item, or an item missing 4 distinct options / a reference answer,
 * is dropped; dropping too many makes the whole response invalid so the caller
 * can retry rather than silently show a shortened quiz.
 */
export const EXAM_QUESTION_COUNT = 10;

export function parseExamQuestions(raw: string): ExamQuestion[] {
  const cleaned = stripMarkdownFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("The model did not return valid exam JSON. Please try again.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid exam response shape.");
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.questions)) {
    throw new Error("The exam response has no questions array.");
  }
  const questions: ExamQuestion[] = [];
  let counter = 1;
  for (const q of obj.questions) {
    if (typeof q !== "object" || q === null) continue;
    const item = q as Record<string, unknown>;
    const prompt =
      typeof item.prompt === "string" ? item.prompt.trim() : "";
    // Only multiple_choice items count; short-answer is not part of Phase D.
    if (item.type !== "multiple_choice") continue;
    if (!prompt) continue;
    const opts = Array.isArray(item.options)
      ? item.options.map((o) => String(o)).filter((o) => o.trim().length > 0)
      : [];
    if (opts.length !== 4) continue;
    const referenceAnswer =
      typeof item.referenceAnswer === "string" ? item.referenceAnswer.trim() : "";
    // referenceAnswer must exactly match one of the options (case-sensitive
    // wording matters so the grader can compare deterministically).
    if (!opts.includes(referenceAnswer)) continue;
    questions.push({
      id: typeof item.id === "string" && item.id ? item.id : `q${counter}`,
      prompt,
      type: "multiple_choice",
      options: opts,
      referenceAnswer,
    });
    counter += 1;
  }
  if (questions.length !== EXAM_QUESTION_COUNT) {
    throw new Error(
      `The model returned ${questions.length} valid questions — expected exactly ${EXAM_QUESTION_COUNT}. Please try again.`
    );
  }
  return questions;
}
// ============================================================
// Per-task exam grading
// ============================================================

const GRADE_SYSTEM_PROMPT = `You grade a short quiz for a single completed learning task. You receive the task name, each
question with its reference answer, and the learner's answer.

Scoring guidance:
- Multiple-choice: correct only when the learner's chosen option matches the reference answer (case-insensitive).
- Short-answer: judge on key ideas, not wording. Partially right earns partial credit.

Respond with STRICT JSON ONLY — no markdown fences. The JSON must be exactly:
{
  "score": number,
  "message": string
}
- "score" is 0-100 (integer).
- "message" is at most two sentences. If the score is low (<60), gently suggest reviewing the material before moving on;
  otherwise keep it encouraging and brief.`;

export interface GradeExamRequest {
  taskName: string;
  questions: ExamQuestion[];
  answers: Record<string, string>;
}

export interface GradeResult {
  score: number;
  message: string;
}

/**
 * Grades a submitted task exam via the LLM. Falls back to a neutral,
 * honest local score if the model misbehaves so the UI never breaks.
 */
export async function gradeExam(
  request: GradeExamRequest
): Promise<GradeResult> {
  const provider = getProvider();
  const payload = request.questions.map((q) => ({
    question: q.prompt,
    type: q.type,
    reference_answer: q.referenceAnswer,
    learner_answer: request.answers[q.id] ?? "(no answer)",
  }));
  const userPrompt = `Task: ${request.taskName}

Questions and answers:
${JSON.stringify(payload, null, 2)}

Grade this attempt now.`;

  try {
    const raw = await callProvider(provider, GRADE_SYSTEM_PROMPT, userPrompt);
    return parseGradeResult(raw);
  } catch {
    // Local fallback: never block the UI because grading failed.
    return {
      score: 0,
      message:
        "We couldn't reach the grader just now — your answers were saved, but please review this task's material before moving on.",
    };
  }
}

export function parseGradeResult(raw: string): GradeResult {
  const cleaned = stripMarkdownFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      score: 50,
      message:
        "We couldn't score automatically — consider a quick review before moving on.",
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { score: 50, message: "Score unavailable — consider a quick review." };
  }
  const o = parsed as Record<string, unknown>;
  const rawScore = typeof o.score === "number" ? o.score : 50;
  const message =
    typeof o.message === "string" && o.message.trim()
      ? o.message.trim()
      : "Nice work — keep it up!";
  return { score: Math.max(0, Math.min(100, Math.round(rawScore))), message };
}

// ============================================================
// Groq provider (OpenAI-compatible endpoint)
// ============================================================

/**
 * Calls the Groq API with a raw system prompt + user prompt and
 * returns the model text content.
 *
 * v2 Fix 4: `response_format: json_object` puts the model in strict
 * JSON mode so roadmap/replan responses are parseable by construction
 * instead of hoping for clean JSON from a plain prompt.
 */
async function callGroq(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  opts: { jsonMode?: boolean } = {}
): Promise<string> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Groq API error (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Groq API returned an empty response.");
  }
  return content;
}

// ============================================================
// v2 Fix 4: strict-JSON retry helper.
// First attempt runs in native JSON mode; if parsing/schema
// validation STILL fails, we automatically retry ONCE with a
// stricter instruction before surfacing an error to the user.
// ============================================================

const STRICT_RETRY_SUFFIX =
  "\n\nCRITICAL: Return ONLY a single valid JSON object matching the schema above. No prose, no explanations, no markdown fences, nothing outside the JSON.";

function isJsonParseError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : "";
  return /valid JSON|schema/i.test(message);
}

async function callWithJsonRetry<T>(
  run: (prompt: string) => Promise<string>,
  parse: (raw: string) => T,
  userPrompt: string
): Promise<T> {
  try {
    return parse(await run(userPrompt));
  } catch (err) {
    if (!isJsonParseError(err)) throw err;
    // Automatic one-shot stricter retry — never a dead-end on first parse.
    return parse(await run(`${userPrompt}${STRICT_RETRY_SUFFIX}`));
  }
}

async function generateWithGrok(userPrompt: string): Promise<RoadmapResponse> {
  const apiKey = process.env.GROK_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GROK_API_KEY is not set. Add it to your environment to use the Groq provider."
    );
  }
  return callWithJsonRetry(
    (p) => callGroq(apiKey, SYSTEM_PROMPT, p, { jsonMode: true }),
    parseRoadmapResponse,
    userPrompt
  );
}

async function replanWithGrok(userPrompt: string): Promise<ReplanResponse> {
  const apiKey = process.env.GROK_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GROK_API_KEY is not set. Add it to your environment to use the Groq provider."
    );
  }
  return callWithJsonRetry(
    (p) => callGroq(apiKey, REPLAN_SYSTEM_PROMPT, p, { jsonMode: true }),
    parseReplanResponse,
    userPrompt
  );
}

// ============================================================
// Gemini provider (Google AI Studio)
// ============================================================

/**
 * Calls the Gemini API with a raw system prompt + user prompt and
 * returns the model text content.
 */
async function callGemini(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: systemPrompt },
            { text: userPrompt },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.7,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini API error (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) {
    throw new Error("Gemini API returned an empty response.");
  }
  return content;
}

async function generateWithGemini(userPrompt: string): Promise<RoadmapResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it to your environment to use the Gemini provider."
    );
  }
  // Gemini already enforces responseMimeType "application/json" in callGemini;
  // wrap in the same retry for parity (§ v2 Fix 4).
  return callWithJsonRetry(
    (p) => callGemini(apiKey, SYSTEM_PROMPT, p),
    parseRoadmapResponse,
    userPrompt
  );
}

async function replanWithGemini(userPrompt: string): Promise<ReplanResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it to your environment to use the Gemini provider."
    );
  }
  return callWithJsonRetry(
    (p) => callGemini(apiKey, REPLAN_SYSTEM_PROMPT, p),
    parseReplanResponse,
    userPrompt
  );
}