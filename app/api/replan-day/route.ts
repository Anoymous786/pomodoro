import { NextRequest, NextResponse } from "next/server";
import { replanDay } from "@/lib/llm";

/**
 * POST /api/replan-day
 *
 * Body: {
 *   tasks: { name: string; priority: "High" | "Medium" | "Low"; estimated_minutes: number }[];
 *   budget_minutes: number;
 * }
 *
 * Calls the configured LLM provider to re-prioritize / merge / trim
 * the day's tasks so they realistically fit within the user's time
 * budget, then returns the re-planned task list.
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

  const rawTasks = obj.tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    return NextResponse.json(
      { error: "Please provide a non-empty tasks array." },
      { status: 400 }
    );
  }

  // Validate + normalize each task.
  const tasks: { name: string; priority: "High" | "Medium" | "Low"; estimated_minutes: number }[] = [];
  for (const t of rawTasks) {
    const task = t as Record<string, unknown>;
    if (typeof task.name !== "string" || !task.name.trim()) {
      return NextResponse.json(
        { error: "Each task must have a name." },
        { status: 400 }
      );
    }
    const priority = task.priority;
    if (priority !== "High" && priority !== "Medium" && priority !== "Low") {
      return NextResponse.json(
        { error: "Each task must have a priority of High, Medium, or Low." },
        { status: 400 }
      );
    }
    const est =
      typeof task.estimated_minutes === "number" && task.estimated_minutes > 0
        ? task.estimated_minutes
        : 25;
    tasks.push({
      name: task.name.trim(),
      priority,
      estimated_minutes: est,
    });
  }

  const budget =
    typeof obj.budget_minutes === "number" && obj.budget_minutes > 0
      ? Math.round(obj.budget_minutes)
      : 0;

  if (budget <= 0) {
    return NextResponse.json(
      { error: "Please provide a positive budget_minutes." },
      { status: 400 }
    );
  }

  // §4.2 Optional re-plan context sent by the button — folded into the
  // LLM prompt so the re-plan knows the topic/day, what's already done,
  // how much time was logged, and which estimates are hand-tuned.
  const topic = typeof obj.topic === "string" ? obj.topic.trim().slice(0, 200) : "";
  const dayNumber =
    typeof obj.day_number === "number" && Number.isFinite(obj.day_number)
      ? Math.round(obj.day_number)
      : undefined;
  const stringList = (v: unknown): string[] | undefined =>
    Array.isArray(v)
      ? v
          .filter((s): s is string => typeof s === "string" && !!s.trim())
          .map((s) => s.trim().slice(0, 200))
          .slice(0, 20)
      : undefined;

  try {
    const replan = await replanDay(tasks, budget, {
      ...(topic ? { topic } : {}),
      ...(dayNumber != null ? { dayNumber } : {}),
      completedTasks: stringList(obj.completed_tasks),
      spentMinutes:
        typeof obj.spent_minutes === "number" &&
        Number.isFinite(obj.spent_minutes) &&
        obj.spent_minutes > 0
          ? Math.round(obj.spent_minutes)
          : undefined,
      lockedTasks: stringList(obj.locked_tasks),
      calibration:
        typeof obj.calibration === "object" && obj.calibration !== null
          ? (obj.calibration as Record<string, unknown>)
          : undefined,
    });
    return NextResponse.json({ tasks: replan.tasks });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to re-plan tasks.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}