/**
 * POST /api/intake  (Phase 1 refactor)
 *
 * Line-for-line port of app/api/intake/route.ts + the intake section of
 * lib/llm.ts. Same validation caps (history <= 20 turns x 4000 chars,
 * known fields <= 500 chars, resume <= 8000 chars) and the same graceful
 * behavior: an unparseable model answer ends the flow instead of erroring.
 */
import { callProvider, stripMarkdownFences } from "./llm.mjs";
import { badRequest, json, parseBody, serverError } from "./respond.mjs";

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

/** Bad model output never breaks the flow — it just ends it (as in Next.js). */
function parseIntakeDecision(raw) {
  let parsed;
  try {
    parsed = JSON.parse(stripMarkdownFences(raw));
  } catch {
    return { done: true };
  }
  if (typeof parsed !== "object" || parsed === null) return { done: true };
  const o = parsed;
  if (typeof o.done !== "boolean") return { done: true };
  if (o.next_question !== null && typeof o.next_question !== "string") {
    return { done: true };
  }
  return o;
}

export const handler = async (event) => {
  let obj;
  try {
    obj = parseBody(event);
  } catch {
    return badRequest("Invalid JSON body.");
  }

  const topic = typeof obj.topic === "string" ? obj.topic.trim() : "";
  if (!topic) {
    return badRequest("Please provide a topic for the intake conversation.");
  }

  const history = Array.isArray(obj.history)
    ? obj.history
        .filter(
          (h) =>
            h &&
            typeof h.content === "string" &&
            (h.role === "user" || h.role === "assistant")
        )
        .map((h) => ({
          role: h.role,
          content: h.content.slice(0, 4000),
        }))
        .slice(-20)
    : [];

  const knownFields =
    typeof obj.knownFields === "object" && obj.knownFields !== null
      ? obj.knownFields
      : {};
  const safeKnownFields = {};
  for (const key of [
    "goal",
    "time_available",
    "level",
    "deadline",
    "constraints",
  ]) {
    const v = knownFields[key];
    if (typeof v === "string" && v.trim()) {
      safeKnownFields[key] = v.trim().slice(0, 500);
    }
  }

  const resumeText =
    typeof obj.resumeText === "string" && obj.resumeText.trim()
      ? obj.resumeText.trim().slice(0, 8000)
      : undefined;

  // ---- Prompt assembly: identical to lib/llm.ts generateIntake() --------
  const knownSummary = [
    safeKnownFields.goal ? `Goal: ${safeKnownFields.goal}` : "",
    safeKnownFields.time_available
      ? `Time available/day: ${safeKnownFields.time_available}`
      : "",
    safeKnownFields.level ? `Skill level: ${safeKnownFields.level}` : "",
    safeKnownFields.deadline ? `Deadline: ${safeKnownFields.deadline}` : "",
    safeKnownFields.constraints
      ? `Constraints: ${safeKnownFields.constraints}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const resumeNote = resumeText
    ? `\nA resume/experience text was provided (${resumeText.length} chars). Infer skill level from it and do NOT ask about level.\nLevel inferred from resume: ${safeKnownFields.level ?? "(see resume excerpt below)"}\nResume excerpt:\n${resumeText.slice(0, 3000)}`
    : "";

  const conversation = history
    .map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`)
    .join("\n");

  const userPrompt = `Topic to learn: ${topic}

Already known so far:
${knownSummary || "(none yet)"}
${resumeNote}

Conversation so far:
${conversation || "(the conversation has not started yet)"}

Continue the intake conversation. Ask your next single question, or signal that you are done.`;

  try {
    const raw = await callProvider(INTAKE_SYSTEM_PROMPT, userPrompt);
    return json(200, { decision: parseIntakeDecision(raw) });
  } catch (err) {
    console.error("intake failed:", err);
    return serverError(
      err instanceof Error ? err.message : "Failed to continue the intake flow."
    );
  }
};