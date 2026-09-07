/**
 * Lambda port of app/api/generate-day-assessment/route.ts
 * (POST /api/generate-day-assessment).
 * Body: { topicLabel: string; dayNumber: number; dayTitle?: string; stepTitles?: string[] }
 * Generates 10-12 topic-specific MCQs drawn from the day's actual steps.
 * Same contract as the local route: { questions } | { error }.
 */
import { callProvider, stripMarkdownFences } from "./llm.mjs";
import { json, badRequest, serverError, parseBody } from "./respond.mjs";

const DAY_ASSESSMENT_SYSTEM_PROMPT = `You write a focused day-end assessment for a learner who just finished one day of a learning roadmap.

Rules:
- 10-12 multiple-choice questions.
- Cover the ACTUAL topics of that day (the step titles given below). Do NOT ask generic questions.
- Medium difficulty only — verify genuine understanding, do not trick or over-reward keyword matching.
- Exactly 4 options per question. "referenceAnswer" must EXACTLY equal one of the option strings.
- ALWAYS include an "explanation" — 1-2 sentences naming the correct answer and why.
- Include a "source" string naming the day/step this question is drawn from.
- "topic" is a short lowercase slug derived from the step title.
Respond with STRICT JSON ONLY (no fences):
{ "questions": [ { "id": string, "topic": string, "prompt": string, "options": [string,string,string,string], "referenceAnswer": string, "difficulty": "medium", "explanation": string, "source": string } ] }`;

/** Port of lib/ai.ts parseRoadmapExam — shared by day assessment + roadmap exam. */
function parseRoadmapExam(raw) {
  let parsed;
  try {
    parsed = JSON.parse(stripMarkdownFences(raw));
  } catch {
    throw new Error("Roadmap exam response was not valid JSON.");
  }
  const qs = Array.isArray(parsed?.questions) ? parsed.questions : [];
  const out = [];
  let counter = 1;
  for (const item of qs) {
    const q = item ?? {};
    const prompt = typeof q.prompt === "string" ? q.prompt.trim() : "";
    const topic =
      typeof q.topic === "string" && q.topic.trim()
        ? q.topic.trim().toLowerCase()
        : "general";
    const referenceAnswer =
      typeof q.referenceAnswer === "string" ? q.referenceAnswer.trim() : "";
    const options = Array.isArray(q.options)
      ? q.options.filter((x) => typeof x === "string" && x.trim()).slice(0, 4)
      : [];
    if (!prompt || !referenceAnswer || options.length < 2) continue;
    if (!options.includes(referenceAnswer)) continue;
    const mapped = {
      id: typeof q.id === "string" && q.id ? q.id : `rq${counter}`,
      topic,
      prompt,
      options,
      referenceAnswer,
    };
    if (typeof q.day_number === "number" && Number.isFinite(q.day_number))
      mapped.day_number = q.day_number;
    if (
      typeof q.difficulty === "string" &&
      ["easy", "medium", "hard"].includes(q.difficulty)
    )
      mapped.difficulty = q.difficulty;
    if (typeof q.explanation === "string" && q.explanation.trim())
      mapped.explanation = q.explanation.trim();
    if (typeof q.source === "string" && q.source.trim())
      mapped.source = q.source.trim();
    out.push(mapped);
    counter += 1;
  }
  return out;
}

export async function handler(event) {
  let body;
  try {
    body = parseBody(event);
  } catch {
    return badRequest("Invalid JSON body.");
  }
  const topicLabel =
    typeof body?.topicLabel === "string" && body.topicLabel.trim()
      ? body.topicLabel.trim().slice(0, 200)
      : "";
  if (!topicLabel) return badRequest("Please provide a topicLabel.");
  const dayNumber =
    typeof body?.dayNumber === "number" &&
    Number.isFinite(body.dayNumber) &&
    body.dayNumber >= 1
      ? Math.floor(body.dayNumber)
      : 0;
  if (!dayNumber) return badRequest("Please provide a dayNumber.");
  const dayTitle =
    typeof body?.dayTitle === "string" && body.dayTitle.trim()
      ? body.dayTitle.trim().slice(0, 200)
      : "";
  const stepTitles = Array.isArray(body?.stepTitles)
    ? body.stepTitles
        .filter((t) => typeof t === "string" && t.trim())
        .map((t) => t.trim().slice(0, 160))
        .slice(0, 60)
    : [];

  const steps = stepTitles.map((t) => `- ${t}`).join("\n");
  const prompt = `Roadmap topic: ${topicLabel}\nDay ${dayNumber}: ${dayTitle}\n\nSteps studied this day:\n${steps}\n\nWrite a 10-12 question medium-difficulty assessment covering exactly these steps, one question per major subtopic.`;

  const run = async (extra) => {
    const raw = await callProvider(DAY_ASSESSMENT_SYSTEM_PROMPT, prompt + extra);
    return parseRoadmapExam(raw);
  };

  try {
    const qs = await run("");
    if (qs.length === 0) throw new Error("validate-error: no valid questions");
    return json(200, { questions: qs.slice(0, 12) });
  } catch (err) {
    // Same single strict-retry as lib/ai.ts generateDayAssessment.
    if (
      err instanceof Error &&
      /validate-error|not valid JSON/i.test(err.message)
    ) {
      const stricter =
        "\n\nCRITICAL: return ONLY a single JSON object with a \"questions\" array. Each question MUST have 4 options and a referenceAnswer that exactly equals one option. 10-12 questions.";
      try {
        const qs = await run(stricter);
        return json(200, { questions: qs.slice(0, 12) });
      } catch (err2) {
        console.error("generate-day-assessment failed:", err2?.message ?? err2);
        return serverError(
          err2 instanceof Error
            ? err2.message
            : "Failed to generate the day assessment."
        );
      }
    }
    console.error("generate-day-assessment failed:", err?.message ?? err);
    return serverError(
      err instanceof Error ? err.message : "Failed to generate the day assessment."
    );
  }
}