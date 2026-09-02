import { NextRequest, NextResponse } from "next/server";
import { generateDayAssessment } from "@/lib/ai";

/** PART 2 §2 — Day Assessment generator.
 * POST /api/generate-day-assessment
 * Body: { topicLabel, dayNumber, dayTitle, stepTitles }
 * Generates 10-12 topic-specific MCQs drawn from the day's actual steps.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const obj = (body ?? {}) as Record<string, unknown>;
  const topicLabel =
    typeof obj.topicLabel === "string" && obj.topicLabel.trim()
      ? obj.topicLabel.trim().slice(0, 200)
      : "";
  if (!topicLabel) {
    return NextResponse.json({ error: "Please provide a topicLabel." }, { status: 400 });
  }
  const dayNumber =
    typeof obj.dayNumber === "number" &&
    Number.isFinite(obj.dayNumber) &&
    obj.dayNumber >= 1
      ? Math.floor(obj.dayNumber)
      : 0;
  if (!dayNumber) {
    return NextResponse.json({ error: "Please provide a dayNumber." }, { status: 400 });
  }
  const dayTitle =
    typeof obj.dayTitle === "string" && obj.dayTitle.trim()
      ? obj.dayTitle.trim().slice(0, 200)
      : "";
  const stepTitles = Array.isArray(obj.stepTitles)
    ? obj.stepTitles
        .filter((t): t is string => typeof t === "string" && !!t.trim())
        .map((t) => t.trim().slice(0, 160))
        .slice(0, 60)
    : [];
  try {
    const questions = await generateDayAssessment({
      topicLabel,
      dayNumber,
      dayTitle,
      stepTitles,
    });
    return NextResponse.json({ questions });
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Failed to generate the day assessment.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
