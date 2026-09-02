/**
 * lib/ai.ts — new-intent LLM helpers used by the exam/skill + chatbot system.
 *
 * All of these route through lib/llm.ts `callProvider`, so they automatically
 * inherit the §14 primary->fallback provider retry on rate-limit/quota errors.
 * Responses are validated into the app's types; a bad model response retries
 * once with a stricter note before failing visibly.
 */
import { callProvider, stripMarkdownFences, getProvider } from "./llm";
import type { RoadmapExamQuestion } from "./types";

/** One per-step check-in: also returns the correct option + explanation +
 * difficulty + source so grading is client-free and no second round-trip. */
export interface CheckInResult {
  question: string;
  options: string[];
  correctIndex: number;
  explanation?: string;
  /** §P2: difficulty mix (check-in defaults to "easy"/"medium"). */
  difficulty?: "easy" | "medium" | "hard";
  /** §P5: which step/task the question was drawn from. */
  source?: string;
}

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

export function parseCheckIn(raw: string): CheckInResult {
  const cleaned = stripMarkdownFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Check-in response was not valid JSON.");
  }
  const o = parsed as Record<string, unknown>;
  const question = typeof o.question === "string" ? o.question.trim() : "";
  const options = Array.isArray(o.options)
    ? o.options.filter((x): x is string => typeof x === "string" && !!x.trim())
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
  return {
    question,
    options: options.slice(0, 4),
    correctIndex,
    explanation:
      typeof o.explanation === "string" && o.explanation.trim()
        ? o.explanation.trim()
        : undefined,
    difficulty:
      typeof o.difficulty === "string" &&
        ["easy", "medium", "hard"].includes(o.difficulty)
        ? (o.difficulty as "easy" | "medium" | "hard")
        : undefined,
    source:
      typeof o.source === "string" && o.source.trim()
        ? o.source.trim()
        : undefined,
  };
}

/** Generates ONE per-step check-in (item 3). */
export async function generateStepCheckIn(
  stepTitle: string,
  topicLabel?: string,
): Promise<CheckInResult> {
  const provider = getProvider();
  const prompt = `Step just completed: ${stepTitle}${topicLabel ? `\nRoadmap topic: ${topicLabel}` : ""
    }\n\nWrite the single quick-check question for this step.`;
  try {
    const raw = await callProvider(provider, CHECKIN_SYSTEM_PROMPT, prompt);
    return parseCheckIn(raw);
  } catch {
    const raw = await callProvider(
      provider,
      CHECKIN_SYSTEM_PROMPT,
      `${prompt}\n\nCRITICAL: return ONLY a single JSON object with the exact schema above (question, options[4], correctIndex, explanation).`,
    );
    return parseCheckIn(raw);
  }
}
export interface RoadmapExamRequest {
  topicLabel: string;
  /* Per-day topic labels, already ordered day 1..N. */
  dayTopics: { day: number; title: string }[];
  questionCount: number;
}

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

export function parseRoadmapExam(raw: string): RoadmapExamQuestion[] {
  const cleaned = stripMarkdownFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Roadmap exam response was not valid JSON.");
  }
  const qs = Array.isArray((parsed as Record<string, unknown>).questions)
    ? (parsed as { questions: unknown[] }).questions
    : [];
  const out: RoadmapExamQuestion[] = [];
  let counter = 1;
  for (const item of qs) {
    const q = item as Record<string, unknown>;
    const prompt = typeof q.prompt === "string" ? q.prompt.trim() : "";
    const topic =
      typeof q.topic === "string" && q.topic.trim()
        ? q.topic.trim().toLowerCase()
        : "general";
    const referenceAnswer =
      typeof q.referenceAnswer === "string" ? q.referenceAnswer.trim() : "";
    const options = Array.isArray(q.options)
      ? q.options
        .filter((x): x is string => typeof x === "string" && !!x.trim())
        .slice(0, 4)
      : [];
    if (!prompt || !referenceAnswer || options.length < 2) continue;
    if (!options.includes(referenceAnswer)) continue;
    out.push({
      id: typeof q.id === "string" && q.id ? q.id : `rq${counter}`,
      topic,
      day_number:
        typeof q.day_number === "number" && Number.isFinite(q.day_number)
          ? q.day_number
          : undefined,
      prompt,
      options,
      referenceAnswer,
      difficulty:
        typeof q.difficulty === "string" &&
          ["easy", "medium", "hard"].includes(q.difficulty)
          ? (q.difficulty as RoadmapExamQuestion["difficulty"])
          : undefined,
      explanation:
        typeof q.explanation === "string" && q.explanation.trim()
          ? q.explanation.trim()
          : undefined,
      source:
        typeof q.source === "string" && q.source.trim()
          ? q.source.trim()
          : undefined,
    });
    counter += 1;
  }
  return out;
}

export interface DayAssessmentRequest {
  topicLabel: string;
  dayNumber: number;
  dayTitle: string;
  stepTitles: string[];
}

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

/**
 * PART 2 §2 — generates ONE Day Assessment (10-12 topic-specific MCQs)
 * from the day's ACTUAL step titles. Medium difficulty. Reuses the
 * same JSON parser as the full roadmap exam.
 */
export async function generateDayAssessment(
  req: DayAssessmentRequest,
): Promise<RoadmapExamQuestion[]> {
  const provider = getProvider();
  const steps = (req.stepTitles || []).map((t) => `- ${t}`).join("\n");
  const prompt =
    `Roadmap topic: ${req.topicLabel}\nDay ${req.dayNumber}: ${req.dayTitle}\n\nSteps studied this day:\n${steps}\n\nWrite a 10-12 question medium-difficulty assessment covering exactly these steps, one question per major subtopic.`;
  const run = async (extra: string) => {
    const raw = await callProvider(
      provider,
      DAY_ASSESSMENT_SYSTEM_PROMPT,
      prompt + extra,
    );
    return parseRoadmapExam(raw);
  };
  try {
    const qs = await run("");
    if (qs.length === 0) throw new Error("validate-error: no valid questions");
    return qs.slice(0, 12);
  } catch (err) {
    const stricter =
      "\n\nCRITICAL: return ONLY a single JSON object with a \"questions\" array. Each question MUST have 4 options and a referenceAnswer that exactly equals one option. 10-12 questions.";
    if (
      err instanceof Error &&
      /validate-error|not valid JSON/i.test(err.message)
    ) {
      return (await run(stricter)).slice(0, 12);
    }
    throw err;
  }
}

/** Generates the full-roadmap mock exam (~N MCQs) (item 4). */
export async function generateRoadmapExam({
  topicLabel,
  dayTopics,
  questionCount,
}: RoadmapExamRequest): Promise<RoadmapExamQuestion[]> {
  const provider = getProvider();
  const dayList = dayTopics.map((d) => `Day ${d.day}: ${d.title}`).join("\n");
  const prompt = `Roadmap topic: ${topicLabel}\n\nDays covered:\n${dayList}\n\nCreate a ${questionCount}-question mock exam covering this whole roadmap proportionally by day.`;

  const run = async (extra: string) => {
    const raw = await callProvider(
      provider,
      ROADMAP_EXAM_SYSTEM_PROMPT.replace("{{N}}", String(questionCount)),
      prompt + extra,
    );
    const qs = parseRoadmapExam(raw);
    if (qs.length === 0) throw new Error("validate-error: no valid questions");
    return qs;
  };

  try {
    return await run("");
  } catch (err) {
    const stricter =
      "\n\nCRITICAL: return ONLY a single JSON object. Each question MUST have 4 options and a referenceAnswer that exactly equals one option.";
    if (
      err instanceof Error &&
      /validate-error|not valid JSON/i.test(err.message)
    ) {
      return await run(stricter);
    }
    throw err;
  }
}
/**
 * Grounded chat reply (item 6). `contextText` is a compact summary of the
 * user's real tracked data (skill profiles, completed roadmaps, exam results).
 * The model is instructed to answer ONLY from that context and to say when it
 * has no data for a topic rather than guessing.
 */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

const CHAT_SYSTEM_PROMPT = `You are a grounded study assistant inside a Pomodoro learning app. You help the user review their progress and prep for interviews.

You receive a JSON block of the user's REAL, PERSISTED learning data (rebuilt from the
authoritative store on every message, so it includes tasks created moments ago):
- "summary": global rollup — tasks, completed_tasks, assessments_taken, exams_taken,
  days "done/total", steps "done/total", estimated, actual practice time.
- "tasks": one entry PER task the user has created (ANY name — discovery is automatic):
  task (name), id, description, created, start_date, deadline, status, current_day,
  total_days_planned, locked_days, days "done/total", steps "done/total", verified,
  remaining_steps, estimated, actual, practice_seconds, assessments ("day:pct%" list),
  day_average_pct, final_exam (pct% or "not_completed"), completion_pct, knowledge_pct
  (null = not enough assessment evidence — say "Not enough assessment data yet"),
  day_assessment_attempts, final_exam_attempts, interrupted_attempts,
  day_rows (per-day est/act minutes + assessed pct), step_rows (per-step est/act
  minutes, done, verified, started/finished dates).
- "recent_activity": dated real events (step_started, step_completed,
  day_assessment_completed, final_exam_completed, interrupted attempts).
- "review_context" (present ONLY when the user asks about questions/answers): the real
  per-question rows — question, your_answer, correct_answer, correct, explanation.

Rules:
- Answer ONLY from this data. NEVER invent scores, times, percentages, days, steps,
  questions, or exam marks. If a value is absent/null/"not_completed", say it is not
  completed / no data — never guess.
- The user may ask about ANY topic in ANY wording. Match by task name (case/partial ok).
  Intent categories to route from the data: what tasks exist; progress/completion/
  remaining; scores/marks; assessments taken; exam results; what was answered wrong;
  time spent (per step/day/task/overall); estimated vs actual; strongest/weakest;
  best/worst; comparisons between two or more tasks; what was studied today/yesterday
  (use recent_activity dates); which task completed most recently (compare dates).
- For "what tasks do I have?" list the names in "tasks".
- For comparisons, pull BOTH tasks' real numbers from "tasks" and compare.
- If the topic is not in "tasks", say you have no tracked data for it.
- Be concise, specific, and encouraging. Reference concrete numbers when you have them.
- Never expose internal provider details.

Respond STRICT JSON ONLY (no fences):
{ "reply": string }`;

export async function generateChatReply(
  conversation: ChatTurn[],
  contextText: string,
): Promise<string> {
  const provider = getProvider();

  // Phase 1 (token overflow): compact BEFORE the first provider call so an
  // oversized payload can never reach Groq, and the Gemini fallback receives
  // the SAME compact payload (never a re-sent raw one). The learning context
  // is built compact server-side already; these caps are hard guards.
  const CONTEXT_BUDGET_CHARS = 12000;
  const compactContext =
    contextText.length <= CONTEXT_BUDGET_CHARS
      ? contextText
      : contextText.slice(0, CONTEXT_BUDGET_CHARS);
  const compactConversation = conversation.slice(-12).map((t) => ({
    ...t,
    content: t.content.slice(0, 1500),
  }));

  const userPrompt = `Tracked user data (grounding):\n${compactContext || "(no tracked data yet)"}\n\nConversation:\n${compactConversation
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n")}`;

  const run = async (extra: string) => {
    const raw = await callProvider(
      provider,
      CHAT_SYSTEM_PROMPT,
      userPrompt + extra,
    );
    const result = parseChatReply(raw);
    if (!result) throw new Error("validate-error: chat reply missing");
    return result;
  };
  try {
    return await run("");
  } catch (err) {
    if (
      err instanceof Error &&
      /validate-error|chat reply missing|not valid JSON/i.test(err.message)
    ) {
      return await run(
        '\n\nCRITICAL: return ONLY a single JSON object: {"reply": string}',
      );
    }
    throw err;
  }
}

export function parseChatReply(raw: string): string | null {
  const cleaned = stripMarkdownFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  const reply = (parsed as Record<string, unknown>).reply;
  return typeof reply === "string" && reply.trim() ? reply.trim() : null;
}
/** §P3: result of a mid-roadmap edit — the AI's suggested action. */
export interface RoadmapEditResult {
  /** Human-readable summary of what changed. */
  summary: string;
  /** Insert a new task before the given step title (undefined = at the end). */
  insertBefore?: string;
  /** The new task name to insert. */
  newTaskName?: string;
  /** Optional reason for the new task (short). */
  reason?: string;
}

const ROADMAP_EDIT_SYSTEM_PROMPT = `You are a learning-roadmap planner assisting with a mid-roadmap edit.

You receive:
- "topic" — the roadmap topic.
- "request" — the user's natural-language edit (e.g. "add testing", "include more on hooks").
- "steps" — the current ordered list of { day, title } roadmap steps.

Rules:
- Your job is to plan ONE targeted edit: typically inserting a NEW prerequisite or additional task to address the request.
- Return a JSON object with:
  - "summary": a short line explaining what changed.
  - "insertBefore": the title of the step BEFORE which the new task should be inserted (exact match to an existing step title). If null, append at the end.
  - "newTaskName": the new task title (concise).
  - "reason": a short one-line reason for this insertion, tied to which step/topic it targets.
- Do NOT rewrite the whole roadmap. Only reference ONE insert.
- If the request doesn't make sense for this roadmap, still return a sensible targeted addition.
Respond STRICT JSON ONLY (no fences):
{ "summary": string, "insertBefore": string|null, "newTaskName": string, "reason": string }`;

/** §P3: call the LLM to plan a mid-roadmap edit. */
export async function replayRoadmapEdit(input: {
  topic: string;
  request: string;
  steps: { day: number; title: string }[];
}): Promise<RoadmapEditResult> {
  const provider = getProvider();
  const stepList = input.steps
    .map((s) => `Day ${s.day}: ${s.title}`)
    .join("\n");
  const prompt = `Topic: ${input.topic}\n\nRequest: ${input.request}\n\nCurrent steps:\n${stepList}\n\nPlan the targeted edit.`;

  const run = async (extra: string) => {
    const raw = await callProvider(provider, ROADMAP_EDIT_SYSTEM_PROMPT, prompt + extra);
    return parseRoadmapEdit(raw);
  };

  try {
    return await run("");
  } catch (err) {
    if (
      err instanceof Error &&
      /validate-error|not valid JSON|malformed/i.test(err.message)
    ) {
      return await run(
        '\n\nCRITICAL: return ONLY a single JSON object: {"summary": string, "insertBefore": string|null, "newTaskName": string, "reason": string}',
      );
    }
    throw err;
  }
}

export function parseRoadmapEdit(raw: string): RoadmapEditResult {
  const cleaned = stripMarkdownFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("validate-error: roadmap-edit response was not valid JSON.");
  }
  const o = parsed as Record<string, unknown>;
  const summary = typeof o.summary === "string" ? o.summary.trim() : "";
  const newTaskName =
    typeof o.newTaskName === "string" ? o.newTaskName.trim() : "";
  if (!summary || !newTaskName) {
    throw new Error("validate-error: roadmap-edit response missing fields.");
  }
  return {
    summary,
    insertBefore:
      typeof o.insertBefore === "string" && o.insertBefore.trim()
        ? o.insertBefore.trim()
        : undefined,
    newTaskName,
    reason:
      typeof o.reason === "string" && o.reason.trim()
        ? o.reason.trim()
        : undefined,
  };
}
