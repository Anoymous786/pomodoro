/**
 * POST /api/replan-day  (Phase 1 refactor)
 *
 * Port of app/api/replan-day/route.ts + replanDay()/parseReplanResponse()
 * from lib/llm.ts. Same validation (non-empty tasks, High/Medium/Low
 * priorities, positive budget) and same response shape { tasks: [...] }.
 */
import { callProvider, stripMarkdownFences } from "./llm.mjs";
import { badRequest, json, parseBody, serverError } from "./respond.mjs";

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
- For EVERY returned task, include a "reason": a SHORT one-line string (under ~180 chars) explaining WHY that task is kept/scheduled and what it builds on, e.g. "Kept as High priority because it underpins the rest of the day".
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

function parseReplanResponse(raw) {
  const cleaned = stripMarkdownFences(raw);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("The model did not return valid JSON. Please try again.");
  }
  const valid =
    typeof parsed === "object" &&
    parsed !== null &&
    Array.isArray(parsed.tasks) &&
    parsed.tasks.length > 0 &&
    parsed.tasks.every(
      (t) =>
        typeof t === "object" &&
        t !== null &&
        typeof t.name === "string" &&
        (t.priority === "High" || t.priority === "Medium" || t.priority === "Low") &&
        typeof t.estimated_minutes === "number" &&
        t.estimated_minutes > 0
    );
  if (!valid) {
    throw new Error(
      "The model returned JSON that does not match the expected replan schema. Please try again."
    );
  }
  return parsed;
}

export const handler = async (event) => {
  let obj;
  try {
    obj = parseBody(event);
  } catch {
    return badRequest("Invalid JSON body.");
  }

  if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) {
    return badRequest("Please provide a non-empty tasks array.");
  }

  const tasks = [];
  for (const t of obj.tasks) {
    if (typeof t !== "object" || t === null || typeof t.name !== "string" || !t.name.trim()) {
      return badRequest("Each task must have a name.");
    }
    if (t.priority !== "High" && t.priority !== "Medium" && t.priority !== "Low") {
      return badRequest("Each task must have a priority of High, Medium, or Low.");
    }
    const task = {
      name: t.name.trim(),
      priority: t.priority,
      estimated_minutes:
        typeof t.estimated_minutes === "number" && t.estimated_minutes > 0
          ? t.estimated_minutes
          : 25,
    };
    // "Explain why" (Phase 3): carry the model's one-line reasoning through,
    // if present, so the frontend can show it next to the re-planned task.
    if (typeof t.reason === "string" && t.reason.trim()) {
      task.reason = t.reason.trim();
    }
    tasks.push(task);
  }

  const budget =
    typeof obj.budget_minutes === "number" && obj.budget_minutes > 0
      ? obj.budget_minutes
      : 0;
  if (budget <= 0) {
    return badRequest("Please provide a positive budget_minutes.");
  }

  // Adaptive time estimation (Phase 2): accept an optional calibration so
  // re-planned task minutes reflect the user's observed actual-vs-estimated
  // pace. Lightly validated; the model receives it only as guidance.
  let calibration = null;
  if (
    typeof obj.calibration === "object" &&
    obj.calibration !== null &&
    typeof obj.calibration.ratio === "number" &&
    Number.isFinite(obj.calibration.ratio)
  ) {
    calibration = {
      ratio: Math.min(3, Math.max(0.5, obj.calibration.ratio)),
      sampleSize:
        typeof obj.calibration.sampleSize === "number"
          ? Math.round(obj.calibration.sampleSize)
          : 0,
      recentMinutes:
        typeof obj.calibration.recentMinutes === "number"
          ? Math.round(obj.calibration.recentMinutes)
          : undefined,
    };
  }

  // Re-plan context (v2): what is already done, time already spent on this
  // day, and which estimates the user hand-tuned (locked). All optional.
  const completedTasks = Array.isArray(obj.completed_tasks)
    ? obj.completed_tasks
        .filter((n) => typeof n === "string" && n.trim())
        .slice(0, 50)
        .map((n) => n.trim().slice(0, 200))
    : [];
  const spentMinutes =
    typeof obj.spent_minutes === "number" && Number.isFinite(obj.spent_minutes)
      ? Math.min(2000, Math.max(0, Math.round(obj.spent_minutes)))
      : 0;
  const lockedTasks = Array.isArray(obj.locked_tasks)
    ? obj.locked_tasks
        .filter((n) => typeof n === "string" && n.trim())
        .slice(0, 50)
        .map((n) => n.trim().slice(0, 200))
    : [];

  // Identical prompt assembly as lib/llm.ts replanDay(), plus calibration.
  const calibrationLine = calibration
    ? `\n\nPace calibration: based on ${calibration.sampleSize || "recent"} observed tasks, this user typically completes ~${Math.round(
        calibration.ratio * 100
      )}% of a typical estimate per task (recent avg ${calibration.recentMinutes ?? "n/a"} min/session). When assigning "estimated_minutes", scale toward ${calibration.ratio.toFixed(2)}x of the average estimate so the plan fits their real pace.`
    : "";

  const contextLines = [
    completedTasks.length > 0
      ? `\nCompleted today (already done — keep them in the plan): ${completedTasks.join("; ")}`
      : "",
    spentMinutes > 0
      ? `\nTime already spent on this day: ${spentMinutes} min (fit the REMAINING work into ~${Math.max(
          0,
          budget - spentMinutes
        )} min).`
      : "",
    lockedTasks.length > 0
      ? `\nLocked estimates (keep these estimated_minutes EXACTLY — user-tuned): ${lockedTasks.join("; ")}`
      : "",
  ]
    .filter(Boolean)
    .join("");

  const userPrompt = `Total time budget: ${budget} minutes

Current tasks:
${JSON.stringify(tasks, null, 2)}
${contextLines}

Re-plan these tasks to fit the ${budget}-minute budget.${calibrationLine}`;

  try {
    const replan = parseReplanResponse(await callProvider(REPLAN_SYSTEM_PROMPT, userPrompt));
    return json(200, { tasks: replan.tasks });
  } catch (err) {
    console.error("replan-day failed:", err);
    return serverError(
      err instanceof Error ? err.message : "Failed to re-plan tasks."
    );
  }
};