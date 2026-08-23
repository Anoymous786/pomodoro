import { NextRequest, NextResponse } from "next/server";
import {
  generateIntake,
  IntakeRequest,
  IntakeTurn,
} from "@/lib/llm";

/**
 * POST /api/intake
 *
 * Body: {
 *   topic: string;
 *   history: { role: "user" | "assistant"; content: string }[];
 *   knownFields?: Partial<IntakeContext>;
 *   resumeText?: string;
 * }
 *
 * Returns the LLM's next single intake question (or a "done" signal).
 * The AI decides how many questions are needed; the client enforces an
 * internal safety cap so the flow can never loop forever.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const obj = (body ?? {}) as Record<string, unknown>;

  const topic =
    typeof obj.topic === "string" ? obj.topic.trim() : "";
  if (!topic) {
    return NextResponse.json(
      { error: "Please provide a topic for the intake conversation." },
      { status: 400 }
    );
  }

  // Validate the conversation history (best-effort; empty is allowed).
  const history: IntakeTurn[] = Array.isArray(obj.history)
    ? (obj.history as unknown[])
        .map((h) => h as Record<string, unknown>)
        .filter(
          (h) =>
            h &&
            typeof h.content === "string" &&
            (h.role === "user" || h.role === "assistant")
        )
        .map((h) => ({
          role: h.role as "user" | "assistant",
          content: (h.content as string).slice(0, 4000),
        }))
        .slice(-20) // keep the prompt bounded
    : [];

  const knownFields = (obj.knownFields ?? {}) as Record<string, unknown>;
  const safeKnownFields: IntakeRequest["knownFields"] = {};
  for (const key of [
    "goal",
    "time_available",
    "level",
    "deadline",
    "constraints",
  ] as const) {
    const v = knownFields[key];
    if (typeof v === "string" && v.trim()) {
      safeKnownFields[key] = v.trim().slice(0, 500);
    }
  }

  const resumeText =
    typeof obj.resumeText === "string" && obj.resumeText.trim()
      ? obj.resumeText.trim().slice(0, 8000)
      : undefined;

  try {
    const decision = await generateIntake({
      topic,
      history,
      knownFields: safeKnownFields,
      resumeText,
    });
    return NextResponse.json({ decision });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to continue the intake flow.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
