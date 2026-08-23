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
}

export interface RoadmapResponse {
  topic_name: string;
  badge_reward: { title: string; icon: string };
  days: RoadmapDayRaw[];
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
      "tasks": [
        {
          "name": string,
          "priority": "High" | "Medium" | "Low",
          "estimated_minutes": number
        }
      ]
    }
  ]
}

Rules:
- Generate 5 to 10 days.
- Each day should have 3 to 6 concrete, actionable tasks.
- "priority" must be exactly one of: "High", "Medium", "Low".
- "estimated_minutes" must be a realistic, task-specific estimate of how many minutes that task actually takes to complete (e.g. "Read a chapter" might be 25-40 min, "Build a TODO API endpoint" might be 60-90 min). Do NOT use a fixed default for every task.
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
export function buildRoadmapUserPrompt(
  topic: string,
  context?: IntakeContext
): string {
  const parts: string[] = [`Topic: ${topic}`, ""];
  if (context?.goal) parts.push(`The learner's goal: ${context.goal}`);
  if (context?.time_available)
    parts.push(`Time available per day: ${context.time_available}`);
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
 * Calls the configured LLM provider with the user's topic (and optional
 * intake context) and returns a validated RoadmapResponse.
 */
export async function generateRoadmap(
  topic: string,
  context?: IntakeContext
): Promise<RoadmapResponse> {
  const provider = getProvider();
  const userPrompt = buildRoadmapUserPrompt(topic, context);

  if (provider === "gemini") {
    return generateWithGemini(userPrompt);
  }
  return generateWithGrok(userPrompt);
}

/**
 * Re-plans a single day's tasks with the LLM to fit a time budget.
 * `tasks` is the day's current task list; `budgetMinutes` is the
 * user's available time for the day (sum of effective minutes).
 */
export async function replanDay(
  tasks: {
    name: string;
    priority: RoadmapPriority;
    estimated_minutes?: number;
  }[],
  budgetMinutes: number
): Promise<ReplanResponse> {
  const provider = getProvider();
  const list = tasks.map((t) => ({
    name: t.name,
    priority: t.priority,
    estimated_minutes: t.estimated_minutes ?? 25,
  }));
  const userPrompt = `Total time budget: ${budgetMinutes} minutes

Current tasks:
${JSON.stringify(list, null, 2)}

Re-plan these tasks to fit the ${budgetMinutes}-minute budget.`;

  if (provider === "gemini") {
    return replanWithGemini(userPrompt);
  }
  return replanWithGrok(userPrompt);
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
  if (provider === "gemini") {
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

const EXAM_SYSTEM_PROMPT = `You create a short, task-specific quiz that verifies a learner understood the exact task they just
completed — not the whole day or the whole roadmap.

Rules:
- Build 3 to 5 questions mixing multiple-choice and short-answer.
- Every question must target THIS task's specific content and skills.
- For multiple-choice: provide exactly 4 options; "referenceAnswer" must exactly match one of those option strings.
- For short-answer: "referenceAnswer" is a concise model answer capturing the key points.

Respond with STRICT JSON ONLY — no markdown fences. The JSON must exactly match this schema:
{
  "questions": [
    {
      "id": string,
      "prompt": string,
      "type": "multiple_choice" | "short_answer",
      "options": [string, string, string, string],
      "referenceAnswer": string
    }
  ]
}
- "id" is any short unique string.
- Include "options" only for multiple_choice questions; omit it for short_answer.`;

export interface ExamGenerationRequest {
  taskName: string;
  /** Extra context: roadmap topic / day title, when available. */
  context?: string;
}

/**
 * Generates 3-5 task-specific exam questions via the LLM.
 */
export async function generateExam(
  request: ExamGenerationRequest
): Promise<ExamQuestion[]> {
  const provider = getProvider();
  const userPrompt = `Task just completed: ${request.taskName}${
    request.context ? `\nContext: ${request.context}` : ""
  }

Generate the quiz for THIS task now.`;
  const raw = await callProvider(provider, EXAM_SYSTEM_PROMPT, userPrompt);
  return parseExamQuestions(raw);
}

/**
 * Validates + normalizes an LLM exam response into ExamQuestion[].
 */
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
    const prompt = typeof item.prompt === "string" ? item.prompt.trim() : "";
    const type =
      item.type === "multiple_choice"
        ? "multiple_choice"
        : item.type === "short_answer"
        ? "short_answer"
        : null;
    if (!prompt || !type) continue;
    const referenceAnswer =
      typeof item.referenceAnswer === "string" ? item.referenceAnswer.trim() : "";
    if (type === "multiple_choice") {
      const opts = Array.isArray(item.options)
        ? item.options.map((o) => String(o))
        : [];
      if (opts.length !== 4) continue;
      questions.push({
        id: typeof item.id === "string" && item.id ? item.id : `q${counter}`,
        prompt,
        type,
        options: opts,
        referenceAnswer,
      });
    } else {
      questions.push({
        id: typeof item.id === "string" && item.id ? item.id : `q${counter}`,
        prompt,
        type,
        referenceAnswer,
      });
    }
    counter += 1;
  }
  if (questions.length < 3) {
    throw new Error("The model returned too few valid questions. Please try again.");
  }
  return questions.slice(0, 5);
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
 */
async function callGroq(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string
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

async function generateWithGrok(userPrompt: string): Promise<RoadmapResponse> {
  const apiKey = process.env.GROK_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GROK_API_KEY is not set. Add it to your environment to use the Groq provider."
    );
  }
  return parseRoadmapResponse(await callGroq(apiKey, SYSTEM_PROMPT, userPrompt));
}

async function replanWithGrok(userPrompt: string): Promise<ReplanResponse> {
  const apiKey = process.env.GROK_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GROK_API_KEY is not set. Add it to your environment to use the Groq provider."
    );
  }
  return parseReplanResponse(
    await callGroq(apiKey, REPLAN_SYSTEM_PROMPT, userPrompt)
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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
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
  return parseRoadmapResponse(
    await callGemini(apiKey, SYSTEM_PROMPT, userPrompt)
  );
}

async function replanWithGemini(userPrompt: string): Promise<ReplanResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it to your environment to use the Gemini provider."
    );
  }
  return parseReplanResponse(
    await callGemini(apiKey, REPLAN_SYSTEM_PROMPT, userPrompt)
  );
}