import { NextRequest, NextResponse } from "next/server";
import { gradeExam } from "@/lib/llm";
import { ExamQuestion } from "@/lib/types";

/**
 * POST /api/grade-exam
 *
 * Body: {
 *   taskName: string;
 *   questions: ExamQuestion[];
 *   answers: Record<string, string>;
 * }
 *
 * Scores the attempt (0-100) and returns a gentle AI message. When the
 * score is low the message nudges the learner to review before moving on
 * (progress is never hard-blocked here).
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const obj = (body ?? {}) as Record<string, unknown>;

  const taskName =
    typeof obj.taskName === "string" ? obj.taskName.trim() : "";
  if (!taskName) {
    return NextResponse.json(
      { error: "Please provide a taskName to grade." },
      { status: 400 }
    );
  }

  const rawQuestions = obj.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return NextResponse.json(
      { error: "Please provide the exam questions." },
      { status: 400 }
    );
  }

  // Validate + normalize questions coming back from the client.
  const questions: ExamQuestion[] = [];
  for (const q of rawQuestions) {
    if (typeof q !== "object" || q === null) continue;
    const item = q as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.prompt !== "string") continue;
    const type =
      item.type === "multiple_choice"
        ? "multiple_choice"
        : item.type === "short_answer"
        ? "short_answer"
        : null;
    if (!type) continue;
    questions.push({
      id: item.id,
      prompt: item.prompt,
      type,
      options:
        type === "multiple_choice" && Array.isArray(item.options)
          ? item.options.map((o) => String(o))
          : undefined,
      referenceAnswer:
        typeof item.referenceAnswer === "string" ? item.referenceAnswer : "",
    });
  }

  if (questions.length === 0) {
    return NextResponse.json(
      { error: "The exam had no valid questions to grade." },
      { status: 400 }
    );
  }

  const answers: Record<string, string> = {};
  if (typeof obj.answers === "object" && obj.answers !== null) {
    for (const [k, v] of Object.entries(obj.answers as Record<string, unknown>)) {
      if (typeof v === "string") answers[k] = v.slice(0, 2000);
    }
  }

  try {
    const result = await gradeExam({ taskName, questions, answers });
    return NextResponse.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to grade the exam.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
