/**
 * progress Lambda — Phase 2 durable per-task progress documents.
 *
 *   GET /api/progress  -> { docs: [{ taskId, rev, task }] }
 *   PUT /api/progress  -> conditional write; 409 on stale rev
 *
 * Deliberately stored INSIDE the EXISTING `roadmaps` table as a new item
 * kind PROGRESS#<taskId> (PK user_id, SK PROGRESS#<taskId>) — no new
 * table, no new AWS service. One task = one item, hard-size-capped below.
 *
 * Consistency model:
 *   - `rev` starts at 1 on create and increments on every accepted write.
 *   - PUT carries expectedRev; the write happens ONLY when the stored rev
 *     equals it (DynamoDB conditional write). A stale tab gets 409 and
 *     must re-hydrate — newer progress can never be silently overwritten.
 *   - The response doc is the authoritative rev going forward.
 *
 * Least-privilege IAM via the EXISTING ddb_roadmaps_rw capability —
 * nothing new to provision.
 */
import { doc, GetCommand, PutCommand, QueryCommand } from "./aws.mjs";
import {
  badRequest,
  json,
  parseBody,
  serverError,
  userIdFor,
} from "./respond.mjs";

const TABLE = process.env.ROADMAPS_TABLE || "pomodoro-dashboard-roadmaps";
const MAX_TASKS = 500;
const MAX_STEPS = 400;
const MAX_ITEM_BYTES = 350_000; // below DynamoDB's 400KB item cap

const TIMING_OUTCOMES = ["early", "on-time", "late"];

const num = (v) =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Validates + clamps one roadmap step; null when unusable. */
function sanitizeStep(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw;
  const id = typeof s.id === "string" ? s.id.trim().slice(0, 128) : "";
  const title = typeof s.title === "string" ? s.title.trim().slice(0, 160) : "";
  if (!id || !title) return null;
  const out = {
    id,
    title,
    isDone: s.isDone === true,
    practicedSeconds: Math.max(0, Math.floor(num(s.practicedSeconds) ?? 0)),
    elapsedSeconds: Math.max(0, Math.floor(num(s.elapsedSeconds) ?? 0)),
    timerStatus: ["idle", "running", "paused", "finished"].includes(s.timerStatus)
      ? s.timerStatus
      : "idle",
  };
  if (typeof s.note === "string" && s.note.trim()) out.note = s.note.slice(0, 400);
  const day = num(s.dayNumber);
  if (day !== null && day >= 1) out.dayNumber = Math.floor(day);
  if (typeof s.dayTitle === "string" && s.dayTitle.trim()) {
    out.dayTitle = s.dayTitle.trim().slice(0, 160);
  }
  const est = num(s.estimated_minutes);
  if (est !== null && est > 0) out.estimated_minutes = Math.floor(est);
  const started = num(s.startedAt);
  if (started !== null && started > 0) out.startedAt = started;
  const actual = num(s.actual_minutes);
  if (actual !== null && actual > 0) out.actual_minutes = actual;
  if (TIMING_OUTCOMES.includes(s.timing_outcome)) {
    out.timing_outcome = s.timing_outcome;
  }
  if (s.checkIn && typeof s.checkIn === "object") {
    const c = s.checkIn;
    out.checkIn = {
      question: typeof c.question === "string" ? c.question.slice(0, 500) : "",
      answer: typeof c.answer === "string" ? c.answer.slice(0, 1000) : "",
      correct: c.correct === true,
      passed: c.passed === true,
      answeredAt: Math.floor(num(c.answeredAt) ?? Date.now()),
    };
  }
  if (Array.isArray(s.sources) && s.sources.length) {
    out.sources = s.sources.slice(0, 8);
  }
  if (typeof s.search === "string" && s.search.trim()) {
    out.search = s.search.slice(0, 200);
  }
  return out;
}

/** Validates + clamps one progress task payload; null when unusable. */
function sanitizeTaskPayload(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw;
  const id = typeof t.id === "string" ? t.id.trim().slice(0, 128) : "";
  const name = typeof t.name === "string" ? t.name.trim().slice(0, 200) : "";
  if (!id || !name) return null;
  const startDate =
    typeof t.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.startDate)
      ? t.startDate
      : "";
  if (!startDate) return null;
  const durationDays =
    typeof t.durationDays === "number" &&
    Number.isFinite(t.durationDays) &&
    t.durationDays >= 1 &&
    t.durationDays <= 365
      ? Math.floor(t.durationDays)
      : 0;
  if (!durationDays) return null;
  const out = {
    id,
    name,
    startDate,
    durationDays,
    checkIns: Array.isArray(t.checkIns)
      ? Array.from(
          new Set(
            t.checkIns
              .filter((d) => typeof d === "number" && d >= 1 && d <= durationDays)
              .map((d) => Math.floor(d))
          )
        ).sort((a, b) => a - b)
      : [],
    createdAt: num(t.createdAt) ?? Date.now(),
  };
  if (typeof t.description === "string" && t.description.trim()) {
    out.description = t.description.trim().slice(0, 1000);
  }
  if (t.is_completed === true) out.is_completed = true;
  if (Array.isArray(t.roadmap)) {
    out.roadmap = t.roadmap.map(sanitizeStep).filter(Boolean).slice(0, MAX_STEPS);
  }
  return out;
}

/** Fits the sanitized task into the DynamoDB item byte budget. */
function sanitizeTaskWithinBudget(raw, remainingBytes) {
  const out = sanitizeTaskPayload(raw);
  if (!out) return null;
  let size = JSON.stringify(out).length;
  if (size <= remainingBytes) return out;
  // The step array is the only unbounded part — trim from the tail.
  const steps = Array.isArray(out.roadmap) ? out.roadmap : [];
  while (steps.length && size > remainingBytes) {
    steps.pop();
    out.roadmap = steps;
    size = JSON.stringify(out).length;
  }
  return out;
}
/** Server time — the ONLY clock used for rev bookkeeping on the server. */
function serverNow() {
  return Date.now();
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? "GET";
  const userId = userIdFor(event);

  // ------------------------------------------------------------------
  // GET — one Query over the user partition, PROGRESS# prefix.
  // ------------------------------------------------------------------
  if (method === "GET") {
    try {
      const out = await doc.send(
        new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: "user_id = :u AND begins_with(sk, :p)",
          ExpressionAttributeValues: { ":u": userId, ":p": "PROGRESS#" },
          ProjectionExpression: "sk, rev, synced_at, #t",
          ExpressionAttributeNames: { "#t": "task" },
        })
      );
      const docs = (out.Items ?? []).map((it) => ({
        taskId: String(it.sk ?? "").replace(/^PROGRESS#/, ""),
        rev: it.rev ?? 0,
        task: it.task ?? null,
        synced_at: it.synced_at ?? null,
      }));
      return json(200, { docs });
    } catch (err) {
      console.error("progress GET failed:", err);
      return serverError(
        err instanceof Error ? err.message : "Failed to load progress."
      );
    }
  }

  if (method !== "PUT") return badRequest("Unsupported method.");

  // ------------------------------------------------------------------
  // PUT — conditional write guarded by expectedRev.
  // ------------------------------------------------------------------
  let obj;
  try {
    obj = parseBody(event);
  } catch {
    return badRequest("Invalid JSON body.");
  }
  const expectedRev = num(obj.expectedRev);
  if (expectedRev === null || expectedRev < 0 || !Number.isInteger(expectedRev)) {
    return badRequest("expectedRev must be a non-negative integer.");
  }
  const task = sanitizeTaskWithinBudget(obj.task, MAX_ITEM_BYTES - 512);
  if (!task) {
    return badRequest(
      "Invalid progress payload (id/name/startDate/durationDays required)."
    );
  }
  const taskId = task.id;
  const sk = `PROGRESS#${taskId}`;

  try {
    const existing = await doc.send(
      new GetCommand({
        TableName: TABLE,
        Key: { user_id: userId, sk },
      })
    );
    const currentRev = existing.Item?.rev ?? 0;

    // Cheap rev pre-check for a precise 409 handling (the conditional
    // write below is the real guard against races).
    if (expectedRev !== currentRev) {
      return json(409, {
        error: "Revision conflict — re-hydrate before writing.",
        currentRev,
      });
    }

    // Per-user cap on NEW docs only (creating a new partition entry).
    if (currentRev === 0) {
      const count = await doc.send(
        new QueryCommand({
          Select: "COUNT",
          TableName: TABLE,
          KeyConditionExpression: "user_id = :u AND begins_with(sk, :p)",
          ExpressionAttributeValues: { ":u": userId, ":p": "PROGRESS#" },
        })
      );
      if ((count.Count ?? 0) >= MAX_TASKS) {
        return json(413, { error: "Too many tasks." });
      }
    }

    const item = {
      user_id: userId,
      sk,
      type: "progress_doc",
      rev: currentRev + 1,
      task,
      synced_at: new Date(serverNow()).toISOString(),
    };

    // CONDITIONAL write — the authoritative race guard. Succeeds only
    // when the stored rev still equals expectedRev (or the item is new).
    // A raced write loses with ConditionalCheckFailedException -> 409,
    // so newer progress can never be silently overwritten.
    await doc.send(
      new PutCommand({
        TableName: TABLE,
        Item: item,
        ConditionExpression: "attribute_not_exists(sk) OR #r = :expected",
        ExpressionAttributeNames: { "#r": "rev" },
        ExpressionAttributeValues: { ":expected": expectedRev },
      })
    );

    return json(200, {
      doc: {
        taskId,
        rev: item.rev,
        task: item.task,
        synced_at: item.synced_at,
      },
    });
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") {
      return json(409, {
        error: "Revision conflict — re-hydrate before writing.",
      });
    }
    console.error("progress PUT failed:", err);
    return serverError(
      err instanceof Error ? err.message : "Failed to save progress."
    );
  }
};