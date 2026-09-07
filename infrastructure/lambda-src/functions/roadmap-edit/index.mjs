// Port of app/api/roadmap-edit/route.ts + replayRoadmapEdit/parseRoadmapEdit
// (lib/ai.ts). Pure-LLM function — no persistence. Response contract is the
// frontend's RoadmapEditResult, unchanged: { summary, insertBefore?,
// newTaskName, reason? }.
import { callProvider, stripMarkdownFences } from "./llm.mjs";
import { json, badRequest, serverError } from "./respond.mjs";

// Local shims — the shared modules expose callProvider/stripMarkdownFences/json
// (there is no callLLM/extractJSON/ok export there).
const extractJSON = (text) => JSON.parse(stripMarkdownFences(text));
const ok = (body) => json(200, body);

const ROADMAP_EDIT_SYSTEM_PROMPT = `You are a learning-roadmap planner assisting with a mid-roadmap edit.

You receive:
- "topic" — the roadmap topic.
- "request" — the user's natural-language edit (e.g. "add testing", "include more on hooks").
- "steps" — the current ordered list of { day, title } roadmap steps.

Rules:
- Your job is to plan ONE targeted edit: typically inserting a NEW prerequisite or additional task to address the request.
- Return a JSON object with:
  - "summary": a short line explaining what changed.
  - "insertBefore": the title of the step BEFORE which the new task should be inserted (exact match to an existing step title). If null, appended at the end.
  - "newTaskName": the new task title (concise).
  - "reason": a short one-line reason for this insertion, tied to which step/topic it targets.
- Do NOT rewrite the whole roadmap. Only reference ONE insert.
- If the request doesn't make sense for this roadmap, still return a sensible targeted addition.
Respond STRICT JSON ONLY (no fences):
{ "summary": string, "insertBefore": string|null, "newTaskName": string, "reason": string }`;

function parseRoadmapEdit(parsed) {
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const newTaskName =
    typeof parsed.newTaskName === "string" ? parsed.newTaskName.trim() : "";
  if (!summary || !newTaskName) {
    throw new Error("validate-error: roadmap-edit response missing fields.");
  }
  return {
    summary,
    insertBefore:
      typeof parsed.insertBefore === "string" && parsed.insertBefore.trim()
        ? parsed.insertBefore.trim()
        : undefined,
    newTaskName,
    reason:
      typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim()
        : undefined,
  };
}

export const handler = async (event) => {
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return badRequest("Invalid JSON body.");
  }

  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  const request = typeof body.request === "string" ? body.request.trim() : "";
  const steps = Array.isArray(body.steps) ? body.steps : [];

  if (!topic || !request || steps.length === 0) {
    return badRequest("Please provide topic, request, and the current steps.");
  }

  const normSteps = steps.map((s) => ({
    day: typeof s?.day === "number" ? s.day : 1,
    title: typeof s?.title === "string" ? s.title : "",
  }));

  const stepList = normSteps.map((s) => `Day ${s.day}: ${s.title}`).join("\n");
  const prompt = `Topic: ${topic}\n\nRequest: ${request}\n\nCurrent steps:\n${stepList}\n\nPlan the targeted edit.`;

  try {
    let parsed;
    try {
      parsed = extractJSON(await callProvider(ROADMAP_EDIT_SYSTEM_PROMPT, prompt));
    } catch (err) {
      // Same strict single-retry contract as the local implementation: one
      // nudge with an explicit schema reminder, then surface the failure.
      if (/validate-error|not valid JSON|malformed/i.test(err?.message || "")) {
        parsed = extractJSON(
          await callProvider(
            ROADMAP_EDIT_SYSTEM_PROMPT,
            prompt +
              '\n\nCRITICAL: return ONLY a single JSON object: {"summary": string, "insertBefore": string|null, "newTaskName": string, "reason": string}'
          )
        );
      } else {
        throw err;
      }
    }
    return ok(parseRoadmapEdit(parsed));
  } catch (err) {
    const message = err?.message || "Failed to plan the edit.";
    if (/validate-error|not valid JSON|malformed/i.test(message)) {
      return serverError(message);
    }
    return serverError("Failed to plan the edit.");
  }
};