/**
 * POST /api/grade-exam  (Phase 1 refactor)
 *
 * Port of app/api/grade-exam/route.ts + gradeExam()/parseGradeResult() from
 * lib/llm.ts — INCLUDING the graceful fallbacks: if the model errors, the
 * learner gets a neutral score instead of a broken UI.
 */
import { callProvider, stripMarkdownFences } from "./llm.mjs";
import { badRequest, json, parseBody, serverError } from "./respond.mjs";

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

function parseGradeResult(raw) {
  let parsed;
  try {
    parsed = JSON.parse(stripMarkdownFences(raw));
  } catch {
    return {
      score: 50,
      message: "We couldn't score automatically — consider a quick review before moving on.",
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { score: 50, message: "Score unavailable — consider a quick review." };
  }
  const rawScore = typeof parsed.score === "number" ? parsed.score : 50;
  const message =
    typeof parsed.message === "string" && parsed.message.trim()
      ? parsed.message.trim()
      : "Nice work — keep it up!";
  return {
    score: Math.max(0, Math.min(100, Math.round(rawScore))),
    message,
  };
}

export const handler = async (event) => {
  let obj;
  try {
    obj = parseBody(event);
  } catch {
    return badRequest("Invalid JSON body.");
  }

  const taskName = typeof obj.taskName === "string" ? obj.taskName.trim() : "";
  if (!taskName) return badRequest("Please provide a taskName to grade.");

  if (!Array.isArray(obj.questions) || obj.questions.length === 0) {
    return badRequest("Please provide the exam questions.");
  }

  // Validate + normalize questions coming back from the client (as before).
  const questions = [];
  for (const q of obj.questions) {
    if (typeof q !== "object" || q === null) continue;
    if (typeof q.id !== "string" || typeof q.prompt !== "string") continue;
    const type =
      q.type === "multiple_choice"
        ? "multiple_choice"
        : q.type === "short_answer"
        ? "short_answer"
        : null;
    if (!type) continue;
    questions.push({
      id: q.id,
      prompt: q.prompt,
      type,
      options:
        type === "multiple_choice" && Array.isArray(q.options)
          ? q.options.map((o) => String(o))
          : undefined,
      referenceAnswer: typeof q.referenceAnswer === "string" ? q.referenceAnswer : "",
    });
  }
  if (questions.length === 0) {
    return badRequest("The exam had no valid questions to grade.");
  }

  const answers = {};
  if (typeof obj.answers === "object" && obj.answers !== null) {
    for (const [k, v] of Object.entries(obj.answers)) {
      if (typeof v === "string") answers[k] = v.slice(0, 2000);
    }
  }

  // Same grading payload/user prompt as lib/llm.ts gradeExam().
  const payload = questions.map((q) => ({
    question: q.prompt,
    type: q.type,
    reference_answer: q.referenceAnswer,
    learner_answer: answers[q.id] ?? "(no answer)",
  }));
  const userPrompt = `Task: ${taskName}

Questions and answers:
${JSON.stringify(payload, null, 2)}

Grade this attempt now.`;

  try {
    const raw = await callProvider(GRADE_SYSTEM_PROMPT, userPrompt);
    return json(200, parseGradeResult(raw));
  } catch (err) {
    console.error("grade-exam failed:", err);
    // Local fallback preserved from Next.js: never block the UI.
    return json(200, {
      score: 0,
      message:
        "We couldn't reach the grader just now — your answers were saved, but please review this task's material before moving on.",
    });
  }
};