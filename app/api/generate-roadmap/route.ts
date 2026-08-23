import { NextRequest, NextResponse } from "next/server";
import { generateRoadmap } from "@/lib/llm";
import { IntakeContext } from "@/lib/types";

/**
 * POST /api/generate-roadmap
 *
 * Body: { topic: string; context?: IntakeContext }
 *
 * Calls the configured LLM provider (Grok or Gemini, chosen via
 * LLM_PROVIDER env var) and returns a validated roadmap JSON. When the
 * optional intake context is present, the roadmap is tailored to the
 * user's goal, time budget, skill level, deadline and constraints.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const obj = (body ?? {}) as Record<string, unknown>;

  const topic: string =
    typeof obj.topic === "string" ? obj.topic.trim() : "";

  if (!topic) {
    return NextResponse.json(
      { error: "Please provide a topic." },
      { status: 400 }
    );
  }

  // Best-effort validation of the intake context (all fields optional).
  let context: IntakeContext | undefined;
  if (typeof obj.context === "object" && obj.context !== null) {
    const c = obj.context as Record<string, unknown>;
    context = { topic };
    for (const key of [
      "time_available",
      "goal",
      "level",
      "deadline",
      "constraints",
    ] as const) {
      const v = c[key];
      if (typeof v === "string" && v.trim()) {
        context[key] = v.trim().slice(0, 500);
      }
    }
    if (typeof c.resumeText === "string" && c.resumeText.trim()) {
      context.resumeText = c.resumeText.trim().slice(0, 8000);
    }
  }

  try {
    const roadmap = await generateRoadmap(topic, context);
    return NextResponse.json({ roadmap });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to generate roadmap.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
