/**
 * roadmap-worker/prompts.mjs — roadmap system prompt + strict JSON parsing.
 * Kept separate so index.mjs reads as pure orchestration.
 */
import { stripMarkdownFences } from "./llm.mjs";
import {
  minutesPerDay,
  requestedDayCount,
} from "./plan-rules.mjs";

export const ROADMAP_SYSTEM_PROMPT = `You are a learning roadmap generator. Given a topic, produce a structured, day-by-day learning roadmap.

RESPONSE FORMAT — non-negotiable:
Return a SINGLE raw JSON object and NOTHING ELSE. No markdown code fences (\`\`\`), no \`json\` wrapper, no commentary before or after, no prose, no explanations. The FIRST character of your reply MUST be "{" and the LAST character MUST be "}". The JSON must exactly match this schema:

{
  "topic_name": string,
  "badge_reward": { "title": string, "icon": string },
  "days": [
    {
      "day_number": number,
      "day_title": string,
      "reason": string,
      "search": string,
      "references": [
        { "type": "docs" | "article" | "video", "title": string, "url": string, "channel": string }
      ],
      "tasks": [
        {
          "name": string,
          "priority": "High" | "Medium" | "Low",
          "estimated_minutes": number,
          "reason": string
        }
      ]
    }
  ]
}

Rules:
- CRITICAL — DAY COUNT: the "days" array MUST contain EXACTLY as many day entries as the user requested. If the request says 7 days, output exactly 7 entries (day_number 1..7). No fewer, no more. Never merge or drop days to save space.
- "search": for EVERY day include a short YouTube SEARCH QUERY string (not a URL) that would surface a good tutorial for that day's exact subtopics — e.g. "Django ORM basics tutorial". This is required for every day.
- Each day should have 3 to 6 concrete, actionable tasks.
- "priority" must be exactly one of: "High", "Medium", "Low".
- "estimated_minutes" must be a realistic, task-specific estimate of how many minutes that task actually takes to complete (e.g. "Read a chapter" might be 25-40 min, "Build a TODO API endpoint" might be 60-90 min). Do NOT use a fixed default for every task.
- "icon" should be a short emoji (e.g. "\u{1F680}", "\u{1F3C6}", "\u{1F3AF}").
- The roadmap should be realistic and progressive (foundations first, then advanced).
- For EVERY day, "reason" is a SHORT one-line string (under ~180 chars) explaining WHY that day is scheduled at this point in the sequence and how it builds on the earlier days (e.g. "Builds on the pathfinding foundations from Day 2").
- For EVERY task, "reason" is a SHORT one-line string (under ~180 chars) explaining WHY that task sits here and WHY its "estimated_minutes" is a realistic fit (e.g. "Reinforces the pattern from task 1; ~40 min is typical for a first implementation").
- For EVERY day, include 2 to 4 "references" SPECIFIC to that day's subtopics — never generic topic links. Mix: official documentation pages, one well-regarded written tutorial/article, and one YouTube video (with its real "title" and "channel"). Only include sources you are CONFIDENT exist; omit a reference rather than guessing a URL. Never invent links.`;

/** Same assembly the old lib/llm.ts generateRoadmap() performed. */
export function buildUserPrompt(topic, context) {
  const c = context ?? {};
  const parts = [
    `Topic: ${topic}`,
    c.goal ? `Goal: ${c.goal}` : "",
    c.time_available ? `Time available per day: ${c.time_available}` : "",
    c.level ? `Skill level: ${c.level}` : "",
    c.deadline ? `Deadline: ${c.deadline}` : "",
    c.constraints ? `Constraints: ${c.constraints}` : "",
    c.resumeText
      ? `Learner background (resume excerpt): ${c.resumeText.slice(0, 3000)}`
      : "",
  ].filter(Boolean);

  // Phase A1: hard day-count instruction, derived from the concrete number.
  const dayCount = requestedDayCount(c);
  if (dayCount !== null) {
    parts.push(
      `Day budget: the learner wants to finish in ${dayCount} days. Generate EXACTLY ${dayCount} day entries — one per day, numbered 1..${dayCount}.`
    );
  }

  // Phase B: hard per-day time budget instruction.
  const dailyBudget = minutesPerDay(c);
  if (dailyBudget !== null) {
    parts.push(
      `Time budget: the learner can spend approximately ${dailyBudget} minutes per day. Keep each day's TOTAL estimated task minutes at or under ${dailyBudget} minutes. Trim, merge, or rebalance tasks so no single day exceeds this budget.`
    );
  }

  // Adaptive time estimation (Phase 2): if we have observed data about how
  // the user's real pace compares to typical estimates, tell the model so it
  // scales task minutes accordingly. Clamped by the API gateway, so no
  // sanitisation needed here.
  if (c.calibration && c.calibration.ratio) {
    const ratio = c.calibration.ratio;
    const n = c.calibration.sampleSize || 0;
    const you = n <= 1 ? "This user" : "This user (based on recent tasks)";
    const magnitude =
      ratio >= 1.1
        ? ` When estimating task minutes for this user, scale typical estimates up by a factor of about ${ratio.toFixed(2)} (they tend to take ~${Math.round(
            (ratio - 1) * 100
          )}% longer than the average estimate).`
        : ratio <= 0.9
        ? ` When estimating task minutes for this user, scale typical estimates down by a factor of about ${ratio.toFixed(2)} (they tend to finish faster than the average estimate).`
        : "";
    parts.push(
      `Calibration: ${you} typically finishes ~${Math.round(ratio * 100)}% of the estimated time per task (${n} samples).${magnitude}`
    );
  }

  return `${parts.join("\n")}\n\nGenerate the day-by-day learning roadmap now.`;
}

/** Type-guard port of isRoadmapResponse()/parseRoadmapResponse(). */
export function parseRoadmapResponse(raw) {
  const cleaned = stripMarkdownFences(raw);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("The model did not return valid JSON.");
  }
  const ok =
    typeof parsed === "object" &&
    parsed !== null &&
    typeof parsed.topic_name === "string" &&
    typeof parsed.badge_reward === "object" &&
    parsed.badge_reward !== null &&
    typeof parsed.badge_reward.title === "string" &&
    typeof parsed.badge_reward.icon === "string" &&
    Array.isArray(parsed.days) &&
    parsed.days.length > 0 &&
    parsed.days.every(
      (d) =>
        typeof d === "object" && d !== null &&
        typeof d.day_number === "number" &&
        typeof d.day_title === "string" &&
        Array.isArray(d.tasks) && d.tasks.length > 0 &&
        d.tasks.every(
          (t) =>
            typeof t === "object" && t !== null &&
            typeof t.name === "string" &&
            (t.priority === "High" || t.priority === "Medium" || t.priority === "Low") &&
            typeof t.estimated_minutes === "number" && t.estimated_minutes > 0
        )
    );
  if (!ok) {
    throw new Error("Model JSON does not match the roadmap schema.");
  }

  // Phase A1: explicitly renumber 1..N so a model that returns 4 entries for a
  // 7-day request can never present a broken day numbering downstream.
  parsed.days = parsed.days.map((d, i) => ({
    ...d,
    day_number: i + 1,
  }));

  // Phase E: never drop the suggested search — the frontend turns it into a
  // YouTube search link for that exact day/topic.
  parsed.days = parsed.days.map((d) => {
    const search =
      typeof d.search === "string" && d.search.trim()
        ? d.search.trim().slice(0, 200)
        : "";
    if (search) d.search = search;
    else delete d.search; // ensureSearchLinks() backfills a fallback later.
    return d;
  });

  // Sanitize per-day references: drop anything malformed/unconfident, cap at
  // 4, normalise the type, and remove the field entirely when nothing survives
  // (the UI hides the Resources toggle when it is absent).
  parsed.days = parsed.days.map((d) => {
    if (!Array.isArray(d.references)) return d;
    const clean = d.references
      .filter(
        (r) =>
          typeof r === "object" &&
          r !== null &&
          typeof r.title === "string" &&
          r.title.trim().length > 0 &&
          typeof r.url === "string" &&
          /^https?:\/\//i.test(r.url.trim())
      )
      .slice(0, 4)
      .map((r) => ({
        type:

          r.type === "video" || r.type === "article" ? r.type : "docs",
        title: String(r.title).trim().slice(0, 140),
        url: String(r.url).trim(),
        ...(typeof r.channel === "string" && r.channel.trim()
          ? { channel: String(r.channel).trim().slice(0, 60) }
          : {}),
      }));
    if (clean.length > 0) d.references = clean;
    else delete d.references;
    return d;
  });

  return parsed;
}

// =====================================================================
// Phase B — day re-planning (same prompt as the replan-day Lambda).
// =====================================================================

export const REPLAN_SYSTEM_PROMPT = `You are an AI task planner. You will receive a list of tasks for a single day, along with the total time budget the user has available that day (in minutes).

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
- For EVERY returned task, include a "reason": a SHORT one-line string (under ~180 chars) explaining WHY that task is kept/scheduled and what it builds on.
- Tasks listed under "Completed today" MUST stay in the plan — they are already done; never drop, merge, or resize them away.
- Tasks listed under "Locked estimates" MUST keep their EXACT "estimated_minutes" — the user hand-tuned those values.

Respond with STRICT JSON ONLY — no markdown fences, no commentary. The JSON must exactly match this schema:

{
  "tasks": [
    {
      "name": string,
      "priority": "High" | "Medium" | "Low",
      "estimated_minutes": number,
      "reason": string
    }
  ]
}

- "priority" must be exactly one of: "High", "Medium", "Low".
- "estimated_minutes" must be a positive number.
- Do not include commentary outside the JSON object.`;