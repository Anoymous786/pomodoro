/**
 * chat — POST /api/chat (Lambda port of app/api/chat/route.ts).
 *
 * The chatbot NEVER trusts a client-side task snapshot. The learning context
 * is rebuilt here, server-side, from the authoritative per-user progress
 * docs in the roadmaps table on EVERY message. The client's optional
 * `context` string is only a last-resort fallback when the server store
 * yields nothing (new user / offline) — the server-derived block wins.
 *
 * Response contract (unchanged): { reply: string } | { error } (400/500).
 */
import { callProvider } from "./llm.mjs";
import { json, badRequest, serverError, parseBody, userIdFor } from "./respond.mjs";
import { doc, QueryCommand } from "./aws.mjs";

// Keeps the prompt compact: drop bulky internals, cap long strings.
function compactDoc(d) {
  const pick = (v, max = 600) => {
    if (typeof v === "string") return v.slice(0, max);
    if (Array.isArray(v)) return v.slice(0, 30).map((x) => pick(x, 200));
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).slice(0, 30)) out[k] = pick(v[k], 200);
      return out;
    }
    return v;
  };
  const out = {};
  for (const [k, v] of Object.entries(d ?? {})) {
    if (k === "user_id" || k === "sk") continue;
    out[k] = pick(v);
  }
  return out;
}

/** All authoritative progress docs for the user (PROGRESS# items). */
async function getAllProgressDocs(userId) {
  const res = await doc.send(
    new QueryCommand({
      TableName: process.env.ROADMAPS_TABLE,
      KeyConditionExpression: "#u = :u AND begins_with(#sk, :p)",
      ExpressionAttributeNames: { "#u": "user_id", "#sk": "sk" },
      ExpressionAttributeValues: { ":u": userId, ":p": "PROGRESS#" },
      ConsistentRead: true,
    })
  );
  return (res.Items ?? []).map(compactDoc);
}

const SYSTEM_PROMPT = `You are the Pomodoro Dashboard study assistant.
You ground EVERY answer in the user's ACTUAL tracked learning data, which is
provided as JSON in a CONTEXT block (tasks, roadmap steps, focus sessions,
exam/question results, skill profile). Rules:
- Base statements on that data; never invent tasks, scores, or progress.
- If the data shows nothing for a topic, say so plainly.
- Be concise (<= 180 words unless asked for a plan), concrete, encouraging.
- When relevant, reference the current/paused task and the next suggested step.
Return plain prose (no JSON envelope).`;

export async function handler(event) {
  let obj;
  try {
    obj = parseBody(event);
  } catch {
    return badRequest("Invalid JSON body.");
  }

  const messages = Array.isArray(obj.messages)
    ? obj.messages
        .filter(
          (m) =>
            m &&
            typeof m.content === "string" &&
            (m.role === "user" || m.role === "assistant")
        )
        .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
        .slice(-20)
    : [];
  if (messages.length === 0) {
    return badRequest("Please provide at least one message.");
  }

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const userQuestion = lastUser?.content ?? "";

  // ---- Authoritative learning data (server-side, per user) ----
  let contextText = "";
  try {
    const userId = userIdFor(event);
    const docs = await getAllProgressDocs(userId);
    if (docs.length > 0) {
      // Attach full context; the compactDoc projection keeps the payload small.
      contextText = JSON.stringify({ tasks: docs });
    }
  } catch (err) {
    console.error("[chat] progress store unavailable:", err?.message);
  }
  if (!contextText) {
    // Last-resort fallback exactly like the Next.js route.
    contextText = typeof obj.context === "string" ? obj.context.slice(0, 6000) : "";
  }

  const transcript = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");

  try {
    const reply = await callProvider(
      SYSTEM_PROMPT,
      `CONTEXT (authoritative server-side learning data for this user):\n${contextText || "(no tracked data yet)"}\n\nCONVERSATION SO FAR:\n${transcript}\n\nAnswer the user's latest message. Question asked: "${userQuestion.slice(0, 500)}"`
    );
    return json(200, { reply });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "The assistant is unavailable right now.";
    console.error("[chat] LLM failure:", message);
    return serverError(message);
  }
}