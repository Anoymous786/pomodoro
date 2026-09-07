/**
 * Lambda port of app/api/generate-checkin/route.ts (POST /api/generate-checkin).
 * Body: { stepTitle: string; topic?: string }
 * Returns ONE quick multiple-choice check-in question for a completed step.
 * Same contract as the local route: { checkIn } | { error }.
 */
import { callProvider, stripMarkdownFences } from "./llm.mjs";
import { json, badRequest, serverError, parseBody } from "./respond.mjs";

const CHECKIN_SYSTEM_PROMPT = `You write ONE quick multiple-choice check question to confirm a learner understood a single step they just completed.

Rules:
- Exactly ONE question, exactly 4 options.
- "correctIndex" is the 0-based index of the correct option.
- Make it specific to the step's actual topic content, not generic.
- Give every question a difficulty label: "easy", "medium", or "hard". Vary difficulty naturally.
- ALWAYS include an "explanation" — a short 1-2 sentence explanation of the correct answer and WHY it's correct. This is shown to the learner on a wrong answer.
- Include a "source" string naming the step/task this question was drawn from (e.g. the step title).
Respond with STRICT JSON ONLY (no fences):
{
  "question": string,
  "options": [string, string, string, string],
  "correctIndex": number,
  "explanation": string,
  "difficulty": "easy" | "medium" | "hard",
  "source": string
}`;

function parseCheckIn(raw) {
  let parsed;
  try {
    parsed = JSON.parse(stripMarkdownFences(raw));
  } catch {
    throw new Error("Check-in response was not valid JSON.");
  }
  const o = parsed ?? {};
  const question = typeof o.question === "string" ? o.question.trim() : "";
  const options = Array.isArray(o.options)
    ? o.options.filter((x) => typeof x === "string" && x.trim())
    : [];
  const correctIndex =
    typeof o.correctIndex === "number" ? Math.floor(o.correctIndex) : -1;
  if (
    !question ||
    options.length < 2 ||
    correctIndex < 0 ||
    correctIndex >= options.length
  ) {
    throw new Error("Check-in response was malformed.");
  }
  const out = {
    question,
    options: options.slice(0, 4),
    correctIndex,
  };
  if (typeof o.explanation === "string" && o.explanation.trim())
    out.explanation = o.explanation.trim();
  if (
    typeof o.difficulty === "string" &&
    ["easy", "medium", "hard"].includes(o.difficulty)
  )
    out.difficulty = o.difficulty;
  if (typeof o.source === "string" && o.source.trim())
    out.source = o.source.trim();
  return out;
}

export async function handler(event) {
  let body;
  try {
    body = parseBody(event);
  } catch {
    return badRequest("Invalid JSON body.");
  }
  const stepTitle =
    typeof body?.stepTitle === "string" ? body.stepTitle.trim() : "";
  if (!stepTitle) return badRequest("Please provide a stepTitle.");
  const topic =
    typeof body?.topic === "string" && body.topic.trim()
      ? body.topic.trim().slice(0, 200)
      : undefined;

  const prompt = `Step just completed: ${stepTitle}${
    topic ? `\nRoadmap topic: ${topic}` : ""
  }\n\nWrite the single quick-check question for this step.`;

  try {
    let checkIn;
    try {
      const raw = await callProvider(CHECKIN_SYSTEM_PROMPT, prompt);
      checkIn = parseCheckIn(raw);
    } catch {
      // Same single strict-retry as lib/ai.ts generateStepCheckIn.
      const raw = await callProvider(
        CHECKIN_SYSTEM_PROMPT,
        `${prompt}\n\nCRITICAL: return ONLY a single JSON object with the exact schema above (question, options[4], correctIndex, explanation).`
      );
      checkIn = parseCheckIn(raw);
    }
    return json(200, { checkIn });
  } catch (err) {
    console.error("generate-checkin failed:", err?.message ?? err);
    return serverError(
      err instanceof Error ? err.message : "Failed to generate the check-in."
    );
  }
}
