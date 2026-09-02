import { NextRequest, NextResponse } from "next/server";
import { generateExam } from "@/lib/llm";

/**
 * POST /api/generate-exam
 *
 * Body: { taskName: string; context?: string }
 *
 * Phase D: Generates EXACTLY 10 multiple-choice questions for ONE specific
 * task — not the whole day. The questions are drawn strictly from the task's
 * own content (e.g. "Install Django" -> Django install/setup specifics).
 * Returns validated exam questions.
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
      { error: "Please provide a taskName to build an exam for." },
      { status: 400 }
    );
  }

  const context =
    typeof obj.context === "string" && obj.context.trim()
      ? obj.context.trim().slice(0, 2000)
      : undefined;

  try {
    const questions = await generateExam({ taskName, context });
    return NextResponse.json({ questions });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to generate the exam.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
