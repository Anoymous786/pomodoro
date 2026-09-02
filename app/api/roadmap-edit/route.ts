import { NextRequest, NextResponse } from "next/server";
import { replayRoadmapEdit } from "@/lib/ai";

/**
 * POST /api/roadmap-edit
 * Body: { topic: string; request: string; currentSteps: { day, title }[] }
 * §P3: mid-roadmap edit — send the user's natural-language edit request plus
 * the current roadmap state to the LLM, which returns an ORDINAL list of
 * updates (insert new task before/after a given day/title, plain text).
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const obj = (body ?? {}) as Record<string, unknown>;

  const topic = typeof obj.topic === "string" ? obj.topic.trim() : "";
  const request = typeof obj.request === "string" ? obj.request.trim() : "";
  const currentSteps = Array.isArray(obj.steps)
    ? (obj.steps as unknown[]).map((s) => s as Record<string, unknown>)
    : [];

  if (!topic || !request || currentSteps.length === 0) {
    return NextResponse.json(
      { error: "Please provide topic, request, and the current steps." },
      { status: 400 },
    );
  }

  try {
    const result = await replayRoadmapEdit({
      topic,
      request,
      steps: currentSteps.map((s) => ({
        day: typeof s.day === "number" ? s.day : 1,
        title: typeof s.title === "string" ? s.title : "",
      })),
    });
    return NextResponse.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to plan the edit.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}