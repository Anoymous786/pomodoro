import { NextRequest, NextResponse } from "next/server";
import { generateStepCheckIn } from "@/lib/ai";

/**
 * POST /api/generate-checkin
 * Body: { stepTitle: string; topic?: string }
 * Returns ONE quick multiple-choice check-in question for a completed step.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const obj = (body ?? {}) as Record<string, unknown>;
  const stepTitle =
    typeof obj.stepTitle === "string" ? obj.stepTitle.trim() : "";
  if (!stepTitle) {
    return NextResponse.json(
      { error: "Please provide a stepTitle." },
      { status: 400 },
    );
  }
  const topic =
    typeof obj.topic === "string" && obj.topic.trim()
      ? obj.topic.trim().slice(0, 200)
      : undefined;
  try {
    const checkIn = await generateStepCheckIn(stepTitle, topic);
    return NextResponse.json({ checkIn });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to generate the check-in.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
