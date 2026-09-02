/**
 * POST /api/generate-exam  (Phase D refactor)
 *
 * Port of app/api/generate-exam/route.ts + generateExam()/parseExamQuestions()
 * from lib/llm.ts, including the strict Phase D validation: EXACTLY 10 valid
 * multiple-choice questions (each with 4 options and a referenceAnswer that
 * matches one option) or the caller sees a clean 500 with a retryable message.
 * One retry with an explicit correction note runs before failing - mirroring
 * generateExam() in lib/llm.ts.
 */
import { callProvider, stripMarkdownFences } from "./llm.mjs";
import { badRequest, json, parseBody, serverError } from "./respond.mjs";

const EXAM_QUESTION_COUNT = 10;

const EXAM_SYSTEM_PROMPT = `You create a 10-question multiple-choice quiz that verifies a learner understood the EXACT task they just completed - not the whole day and not the whole roadmap. Every question must target THIS task's specific content, commands, and skills.

Rules:
- Build EXACTLY 10 multiple-choice questions (no short-answer).
- Provide exactly 4 options for each question.
- "referenceAnswer" must EXACTLY match one of those option strings (case + wording).
- Make the questions specific to the task (e.g. if the task was "Install Django", ask about pip install, django-admin startproject, the dev server command, settings.py, migrations, etc. - not generic Python).

Respond with STRICT JSON ONLY - no markdown fences. The JSON must exactly match this schema:
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

/** Validates + normalizes the LLM exam response into ExamQuestion[]. */
function parseExamQuestions(raw) {
  let parsed;
  try {
    parsed = JSON.parse(stripMarkdownFences(raw));
  } catch {
    throw new Error("The model did not return valid exam JSON. Please try again.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid exam response shape.");
  }
  if (!Array.isArray(parsed.questions)) {
    throw new Error("The exam response has no questions array.");
  }
  const questions = [];
  let counter = 1;
  for (const q of parsed.questions) {
    if (typeof q !== "object" || q === null) continue;
    const prompt = typeof q.prompt === "string" ? q.prompt.trim() : "";
    if (q.type !== "multiple_choice") continue;
    if (!prompt) continue;
    const opts = Array.isArray(q.options)
      ? q.options.map((o) => String(o)).filter((o) => o.trim().length > 0)
      : [];
    if (opts.length !== 4) continue;
    const referenceAnswer =
      typeof q.referenceAnswer === "string" ? q.referenceAnswer.trim() : "";
    if (!opts.includes(referenceAnswer)) continue;
    questions.push({
      id: typeof q.id === "string" && q.id ? q.id : `q${counter}`,
      prompt,
      type: "multiple_choice",
      options: opts,
      referenceAnswer,
    });
    counter += 1;
  }
  if (questions.length !== EXAM_QUESTION_COUNT) {
    throw new Error(
      `The model returned ${questions.length} valid questions - expected exactly ${EXAM_QUESTION_COUNT}. Please try again.`
    );
  }
  return questions;
}

export const handler = async (event) => {
  let obj;
  try {
    obj = parseBody(event);
  } catch {
    return badRequest("Invalid JSON body.");
  }

  const taskName = typeof obj.taskName === "string" ? obj.taskName.trim() : "";
  if (!taskName) {
    return badRequest("Please provide a taskName to build an exam for.");
  }

  const context =
    typeof obj.context === "string" && obj.context.trim()
      ? obj.context.trim().slice(0, 2000)
      : undefined;

  // Identical prompt assembly as lib/llm.ts generateExam().
  const basePrompt = `Task just completed: ${taskName}${
    context ? `\nContext: ${context}` : ""
  }

Generate the quiz for THIS task now. It MUST contain exactly ${EXAM_QUESTION_COUNT} multiple-choice questions.`;

  try {
    const raw = await callProvider(EXAM_SYSTEM_PROMPT, basePrompt);
    return json(200, { questions: parseExamQuestions(raw) });
  } catch (firstErr) {
    // Retry ONCE with an explicit correction note (mirrors lib/llm.ts).
    const retryPrompt = `${basePrompt}

CORRECTION AFTER THE PREVIOUS ATTEMPT: Your previous response was rejected because it did not contain exactly ${EXAM_QUESTION_COUNT} valid multiple-choice questions (each with exactly 4 options and a referenceAnswer that matches one option). Re-generate the ENTIRE quiz with exactly ${EXAM_QUESTION_COUNT} multiple-choice questions about: ${taskName}.`;
    try {
      const raw = await callProvider(EXAM_SYSTEM_PROMPT, retryPrompt);
      return json(200, { questions: parseExamQuestions(raw) });
    } catch (err) {
      console.error("generate-exam failed:", err);
      return serverError(
        err instanceof Error ? err.message : "Failed to generate the exam."
      );
    }
  }
};