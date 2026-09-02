import { NextRequest, NextResponse } from "next/server";
import { generateChatReply, type ChatTurn } from "@/lib/ai";
import { getAllStoredDocs, resolveUserId } from "@/lib/progress-store-server";
import { taskFromProgressDoc } from "@/lib/progress-sync";
import {
  buildFullLearningContext,
  extractAttemptReview,
} from "@/lib/learning-data";
import { buildMonitoringContext, resolveTaskByQuery } from "@/lib/monitoring";
import type { PracticeTask } from "@/lib/types";

/**
 * POST /api/chat
 *
 * The chatbot NEVER trusts a client-side task snapshot (Req 8/9/14). The
 * learning context is rebuilt HERE, server-side, from the authoritative
 * per-user progress store on EVERY message:
 *   - every persisted task is discoverable (no hard-coded names, Req 2);
 *   - a task created seconds ago (e.g. "Zoology") is included immediately;
 *   - the latest scores/revs are used (no stale cache);
 *   - per-user isolation via resolveUserId (Req 15);
 *   - the context is COMPACT (summaries + capped step rows), and detailed
 *     question review is attached ON DEMAND when the user asks about
 *     wrong answers / exams (Req 5/13).
 * The optional client `context` string is kept only as a LAST-RESORT
 * fallback when the server store is unreachable (offline dev) — the
 * server-derived block always wins when present.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const obj = (body ?? {}) as Record<string, unknown>;
  const messages = Array.isArray(obj.messages)
    ? (obj.messages as unknown[])
        .map((m) => m as Record<string, unknown>)
        .filter(
          (m) =>
            typeof m.content === "string" &&
            (m.role === "user" || m.role === "assistant"),
        )
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: (m.content as string).slice(0, 4000),
        }))
        .slice(-20)
    : [];
  if (messages.length === 0) {
    return NextResponse.json(
      { error: "Please provide at least one message." },
      { status: 400 },
    );
  }

  // Newest user message drives on-demand review selection.
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const userQuestion = lastUser?.content ?? "";

    // ---- Authoritative learning data (server-side, per user) ----
  // Uses a COMPACT summary by default (global rollup + per-task compact
  // summaries). Detailed per-step/day rows + question review are attached
  // ONLY when the user's question is task-specific or review-related, so a
  // simple "how am I doing?" never bloats the request (Phase 1 token cap).
  let contextText = "";
  try {
    const userId = resolveUserId(req.headers);
    const docs = getAllStoredDocs(userId);
    const tasks = (docs ?? [])
      .map((d) => taskFromProgressDoc(d as never))
      .filter((t): t is PracticeTask => t !== null);
    if (tasks.length > 0) {
      // Compact per-task summaries (summary + day_rows + step_rows) only when
      // the question references a specific task; otherwise just the rollup.
      const taskMatch = resolveTaskByQuery(tasks, userQuestion);
      if (taskMatch) {
        const review = extractAttemptReview(tasks, userQuestion);
        const full = buildFullLearningContext(tasks, review.found ? review : undefined);
        contextText = JSON.stringify(full);
      } else {
        contextText = buildMonitoringContext(tasks);
      }
    } else {
      contextText = buildMonitoringContext(tasks);
    }
  } catch {
    // Store unavailable (e.g. offline dev) — fall back to the client block.
    contextText =
      typeof obj.context === "string" ? obj.context.slice(0, 6000) : "";
  }

  try {
    const reply = await generateChatReply(messages as ChatTurn[], contextText);
    return NextResponse.json({ reply });
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "The assistant is unavailable right now.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
