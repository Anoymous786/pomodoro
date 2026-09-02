/**
 * skill-profile Lambda — item 5: durable per-topic skill profile storage.
 *
 * POST /api/skill-profile  Body: { profiles: SkillProfile[] } -> upsert each
 * GET  /api/skill-profile                                -> { profiles }
 *
 * Deliberately stored INSIDE the EXISTING `roadmaps` table as a new item kind
 * `SKILL#<topic>` (PK user_id, SK SKILL#<topic>) — no new table, no new AWS
 * service; stays inside the PROVISIONED 2 RCU / 2 WCU always-free design. A
 * topic row is tiny (< 1KB), so a full-profile rewrite costs a fraction of a
 * WCU per save.
 *
 * Scores are computed CLIENT-side (lib/skills.ts rolling weighted average over
 * check-ins + mock-exam answers) — this Lambda is a validated durable store.
 * Every field is re-validated and clamped server-side before writing.
 */
import { doc, QueryCommand, PutCommand } from "./aws.mjs";
import {
  badRequest,
  json,
  parseBody,
  serverError,
  userIdFor,
} from "./respond.mjs";

const TABLE = process.env.ROADMAPS_TABLE || "pomodoro-dashboard-roadmaps";
const MAX_PROFILES = 50;
const MAX_TOTAL = 400;

function clampInt(value, min, max, fallback) {
  const n =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Validates + clamps one SkillProfile; null when unusable (caller skips). */
function sanitizeProfile(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const topic =
    typeof raw.topic === "string" ? raw.topic.trim().slice(0, 120) : "";
  if (!topic) return null;
  return {
    topic,
    label:
      typeof raw.label === "string" && raw.label.trim()
        ? raw.label.trim().slice(0, 120)
        : topic,
    score: clampInt(raw.score, 0, 100, 0),
    questionsAttempted: clampInt(raw.questionsAttempted, 0, MAX_TOTAL, 0),
    correct: clampInt(raw.correct, 0, MAX_TOTAL, 0),
    total: clampInt(raw.total, 0, MAX_TOTAL, 0),
    examsTaken: clampInt(raw.examsTaken, 0, MAX_TOTAL, 0),
    lastUpdated: clampInt(raw.lastUpdated, 0, 8.64e15, Date.now()),
  };
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? "GET";
  const userId = userIdFor(event);

  try {
    if (method === "GET") {
      const out = await doc.send(
        new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: "user_id = :u AND begins_with(sk, :p)",
          ExpressionAttributeValues: { ":u": userId, ":p": "SKILL#" },
        })
      );
      const profiles = (out.Items ?? []).map((it) => ({
        topic: String(it.sk ?? "").replace(/^SKILL#/, ""),
        label: it.label ?? it.topic,
        score: it.score ?? 0,
        questionsAttempted: it.questionsAttempted ?? 0,
        correct: it.correct ?? 0,
        total: it.total ?? 0,
        examsTaken: it.examsTaken ?? 0,
        lastUpdated: it.lastUpdated ?? 0,
      }));
      return json(200, { profiles });
    }

    if (method !== "POST") return badRequest("Unsupported method.");

    let obj;
    try {
      obj = parseBody(event);
    } catch {
      return badRequest("Invalid JSON body.");
    }
    const list = Array.isArray(obj.profiles) ? obj.profiles : [];
    if (list.length === 0) return badRequest("No profiles provided.");
    if (list.length > MAX_PROFILES) {
      return badRequest(`Too many profiles (max ${MAX_PROFILES}).`);
    }

    let written = 0;
    for (const raw of list) {
      const p = sanitizeProfile(raw);
      if (!p) continue;
      await doc.send(
        new PutCommand({
          TableName: TABLE,
          Item: {
            user_id: userId,
            sk: `SKILL#${p.topic}`,
            ...p,
            updated_at: new Date().toISOString(),
          },
        })
      );
      written += 1;
    }
    if (written === 0) return badRequest("No valid profiles in request.");
    return json(200, { saved: written });
  } catch (err) {
    console.error("skill-profile failed:", err);
    return serverError(
      err instanceof Error ? err.message : "Failed to save the skill profile."
    );
  }
};
