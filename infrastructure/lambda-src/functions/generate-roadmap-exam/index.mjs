/**
 * Lambda port of app/api/generate-roadmap-exam/route.ts + generateRoadmapExam()
 * (lib/ai.ts).
 * Body: { topicLabel: string; dayTopics: { day: number; title: string }[]; questionCount?: number }
 * Generates the proportional ~N-question full-roadmap mock exam.
 * Same contract as the local route: 200 { questions } | 400 |500.
 */
import { callProvider, stripMarkdownFences } from "./llm.mjs";
import { json, badRequest, serverError, parseBody } from "./respond.mjs";

const ROADMAP_EXAM_SYSTEM_PROMPT = `You create a multiple-choice mock exam covering a FULL learning roadmap the learner has now completed.

Rules:
- Exactly {{N}} multiple-choice questions.

- Distribute questions proportionally across the listed days/topics.



- MIX DIFFICULTIES explicitly: for a {{N}}-question exam, aim for roughly ~40% easy, ~40% medium, ~20% hard. Tag each with "difficulty": "easy"|"medium"|"hard".



- Provide exactly 4 options per question.



- "topic" must be a short topic slug (lowercase, e.g. "react", "hooks", "routing").


- "referenceAnswer" must EXACTLY match one of the option strings.

- ALWAYS include an "explanation" — 1-2 sentences explaining the correct answer and why. Shown on wrong answer.



- Include a "source" string naming which day/task the question was drawn from (e.g. "Day 3: Django ORM queries").


Respond with STRICT JSON ONLY (no fences):




{
  "questions": [


    { "id": string, "topic": string, "day_number": number, "prompt": string, "options": [string,string,string,string], "referenceAnswer": string, "difficulty": "easy"|"medium"|"hard", "explanation": string, "source": string }


  ]
}`;

/** Port of lib/ai.ts parseRoadmapExam — shared day assessment + roadmap exam. */
function parseRoadmapExam(raw) {
  let parsed;

  try {
    parsed = JSON.parse(stripMarkdownFences(raw));
  } catch {
    throw new Error("Roadmap exam response was not valid JSON.");
  }
  const qs = Array.isArray(parsed?.questions) ? parsed.questions : [];
  const out = [];
  let counter =  1;
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
    counter +=  1;
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
  const dayTopics = Array.isArray(body?.dayTopics)
    ? body.dayTopics
        .map((d) => d ?? {})
        .filter(
          (d) =>
            typeof d.day === "number" &&
            typeof d.title === "string" &&
            !!d.title.trim()
        )
        .map((d) => ({
          day: Math.round(d.day),
          title: d.title.trim().slice(0, 200),
        }))
        .slice(0, 60)
    : [];
  if (dayTopics.length ===  0) return badRequest("Please provide dayTopics.");
  const questionCount =
    typeof body?.questionCount === "number" && body.questionCount >= 1
      ? Math.round(Math.min(body.questionCount, 25))
      : 20;

  const dayList = dayTopics.map((d) => `Day ${d.day}: ${d.title}`).join("\n");
  const prompt = `Roadmap topic: ${topicLabel}\n\nDays covered:\n${dayList}\n\nCreate a ${questionCount}-question mock exam covering this whole roadmap proportionally by day.`;

  const run = async (extra) => {
    const raw = await callProvider(
      ROADMAP_EXAM_SYSTEM_PROMPT.replace("{{N}}", String(questionCount)),
      prompt + extra
    );
    return parseRoadmapExam(raw);
  };

  try {
    const qs = await run("");
    if (qs.length ===  0) throw new Error("validate-error: no valid questions");
    return json(200, { questions: qs });
  } catch (err) {
    // Same single strict retry as lib/ai.ts generateRoadmapExam.



    if (
      err instanceof Error &&
      /validate-error|not valid JSON/i.test(err.message)
    ) {
      const stricter =
        "\n\nCRITICAL: return ONLY a single JSON object. Each question MUST have 4 options and a referenceAnswer that exactly equals one option.";
      try {
        const qs = await run(stricter);
        return json(200, { questions: qs });
      } catch (err2) {
        console.error("generate-roadmap-exam failed:", err2?.message ?? err2);
        return serverError(
          err2 instanceof Error ? err2.message : "Failed to generate the roadmap exam."
        );
      }
    }
    console.error("generate-roadmap-exam failed:", err?.message ?? err);
    return serverError(
      err instanceof Error ? err.message : "Failed to generate the roadmap exam."
    );
  }
}