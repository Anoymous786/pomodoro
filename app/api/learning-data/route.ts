import { NextRequest, NextResponse } from "next/server";
import { getAllStoredDocs, resolveUserId } from "@/lib/progress-store-server";
import { taskFromProgressDoc } from "@/lib/progress-sync";
import {
  buildFullLearningContext,
  extractAttemptReview,
} from "@/lib/learning-data";
import type { PracticeTask } from "@/lib/types";

/**
 * GET /api/learning-data — the chatbot's generic learning-data access layer.
 *
 * Reads the AUTHORITATIVE per-user progress store (same durable state used
 * by the task manager / dashboard / exams) and returns the COMPACT
 * structured context over EVERY task the user has created — including one
 * created seconds ago. Query params:
 *   ?review=1[&q=<user question>]  — also attach on-demand question review.
 */
export async function GET(req: NextRequest) {
  const userId = resolveUserId(req.headers);
  const docs = getAllStoredDocs(userId);
  const tasks = (docs ?? [])
    .map((d) => taskFromProgressDoc(d as never))
    .filter((t): t is PracticeTask => t !== null);

  const url = new URL(req.url);
  const wantsReview = url.searchParams.get("review") === "1";
  const q = url.searchParams.get("q") ?? "";

  const review =
    wantsReview && q ? extractAttemptReview(tasks, q) : undefined;
  const context = buildFullLearningContext(tasks, review);
  return NextResponse.json({ context });
}