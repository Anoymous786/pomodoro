/**
 * POST /api/generate-roadmap  (Phase 1 refactor + Phase 4 async)
 *
 * Same validation as the old Next.js route, but instead of calling the LLM
 * synchronously it: (1) stores a PENDING job in DynamoDB, (2) enqueues a
 * lightweight message to SQS, (3) returns 202 with a polling URL.
 *
 * Note this function needs NO LLM keys and NO SQS/DynamoDB beyond these two
 * actions — least privilege enforced by its IAM capability list.
 */
import { randomUUID } from "node:crypto";
import { doc, PutCommand, SendMessageCommand, sqs } from "./aws.mjs";
import { badRequest, json, parseBody, serverError, userIdFor } from "./respond.mjs";

const CONTEXT_KEYS = [
  "time_available",
  "goal",
  "level",
  "deadline",
  "constraints",
  "days_requested",
];

/** Jobs self-clean from DynamoDB after a week via the table's TTL attribute. */
const JOB_TTL_SECONDS = 7 * 24 * 60 * 60;

export const handler = async (event) => {
  let obj;
  try {
    obj = parseBody(event);
  } catch {
    return badRequest("Invalid JSON body.");
  }

  const topic = typeof obj.topic === "string" ? obj.topic.trim() : "";
  if (!topic) return badRequest("Please provide a topic.");

  // Best-effort intake-context validation — identical rules to Next.js.
  let context;
  if (typeof obj.context === "object" && obj.context !== null) {
    const c = obj.context;
    context = { topic };
    for (const key of CONTEXT_KEYS) {
      const v = c[key];
      if (typeof v === "string" && v.trim()) {
        context[key] = v.trim().slice(0, 500);
      }
    }
    // Phase B concrete numbers (same as the Next.js route): the intake client
    // also sends days_count / minutes_per_day as numbers. Pass them through so
    // the worker can enforce the exact day count and the per-day time budget.
    if (typeof c.minutes_per_day === "number" && c.minutes_per_day > 0) {
      context.minutes_per_day = Math.min(960, Math.round(c.minutes_per_day));
    }
    if (typeof c.days_count === "number" && c.days_count >= 1) {
      context.days_count = Math.min(60, Math.floor(c.days_count));
    }
    if (typeof c.resumeText === "string" && c.resumeText.trim()) {
      context.resumeText = c.resumeText.trim().slice(0, 8000);
    }
    // Phase A1/B concrete numbers (parsed client-side during intake). Without
    // these the worker cannot enforce the exact day count or the per-day
    // time budget, so they are carried through verbatim (same rules as the
    // Next.js route handler).
    if (typeof c.minutes_per_day === "number" && c.minutes_per_day > 0) {
      context.minutes_per_day = Math.round(c.minutes_per_day);
    }
    if (typeof c.days_count === "number" && c.days_count >= 1) {
      context.days_count = Math.floor(c.days_count);
    }
    // Adaptive time estimation (Phase 2): carry the user's observed
    // actual-vs-estimated pace through to the worker so future estimates
    // calibrate. Stored in context => it is already part of the llm_cache
    // key, so a pace change naturally busts the cache (no new mechanism).
    if (
      typeof c.calibration === "object" &&
      c.calibration !== null &&
      typeof c.calibration.ratio === "number" &&
      Number.isFinite(c.calibration.ratio) &&
      c.calibration.ratio > 0
    ) {
      context.calibration = {
        ratio: Math.min(10, Math.max(0.1, c.calibration.ratio)),
        sampleSize:
          typeof c.calibration.sampleSize === "number"
            ? Math.min(500, Math.max(0, Math.round(c.calibration.sampleSize)))
            : 0,
        recentMinutes:
          typeof c.calibration.recentMinutes === "number" &&
          Number.isFinite(c.calibration.recentMinutes)
            ? Math.round(c.calibration.recentMinutes)
            : undefined,
      };
    }
  }

  const userId = userIdFor(event);
  const jobId = randomUUID();
  const now = Date.now();

  try {
    // Write the job FIRST: if the enqueue below fails, the status endpoint
    // still shows an honest PENDING/stale state instead of a phantom 202.
    await doc.send(
      new PutCommand({
        TableName: process.env.ROADMAPS_TABLE,
        Item: {
          user_id: userId,
          sk: `JOB#${jobId}`,
          type: "job",
          job_id: jobId,
          status: "PENDING",
          topic,
          context: context ?? null,
          created_at: now,
          updated_at: now,
          expires_at: Math.floor(now / 1000) + JOB_TTL_SECONDS,
        },
      })
    );

    // Message stays tiny (IDs only) — the worker re-reads the job item, so
    // payloads never bump into SQS size limits and jobs stay auditable.
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: process.env.JOBS_QUEUE_URL,
        MessageBody: JSON.stringify({ jobId, userId }),
      })
    );

    return json(202, {
      jobId,
      status: "PENDING",
      statusUrl: `/api/roadmap-status/${jobId}`,
      pollAfterSeconds: 2,
    });
  } catch (err) {
    console.error("generate-roadmap enqueue failed:", err);
    return serverError(
      err instanceof Error ? err.message : "Failed to enqueue roadmap generation."
    );
  }
};