/**
 * roadmap-worker/process-job.mjs — the async generation pipeline.
 *
 *   load job -> idempotency check -> cache-aside (llm_cache = Redis sub)
 *   -> LLM on miss -> atomic TransactWrite (document + READY) -> SNS event
 */
import { randomUUID } from "node:crypto";
import {
  doc,
  GetCommand,
  PutCommand,
  PublishCommand,
  sns,
  TransactWriteCommand,
  UpdateCommand,
} from "./aws.mjs";
import {
  cacheKeyFor,
  callProvider,
  currentProviderAndModel,
  stripMarkdownFences,
} from "./llm.mjs";
import {
  buildUserPrompt,
  parseRoadmapResponse,
  REPLAN_SYSTEM_PROMPT,
  ROADMAP_SYSTEM_PROMPT,
} from "./prompts.mjs";
import {
  dayTotalMinutes,
  ensureSearchLinks,
  minutesPerDay,
  requestedDayCount,
  validateDayCount,
} from "./plan-rules.mjs";

/**
 * Phase A1 + B + E — the full plan pipeline, mirrored 1:1 from lib/llm.ts
 * generateRoadmap() so the deployed backend enforces the same rules as local
 * development:
 *
 *   A1: server-side day-count validation. A wrong day count retries ONCE with
 *       an explicit correction note, then fails visibly (the job is marked
 *       FAILED with the reason — the roadmap is never silently shortened).
 *   B : every day whose total estimated minutes meaningfully overshoots the
 *       user's stated minutes-per-day (> +10%) is automatically re-planned
 *       through the existing replan prompt before the roadmap is committed.
 *   E : every day ends up with a "search" string the frontend renders as a
 *       YouTube search link.
 */
async function generateRoadmapPlan(topic, context) {
  const dayCount = requestedDayCount(context);
  const budget = minutesPerDay(context);

  const runOnce = (prompt) => callProvider(ROADMAP_SYSTEM_PROMPT, prompt);

  let basePrompt = buildUserPrompt(topic, context);

  // First attempt.
  let roadmap = parseRoadmapResponse(await runOnce(basePrompt));
  let dayOk = validateDayCount(roadmap, dayCount);

  if (!dayOk && dayCount !== null) {
    // Retry ONCE with an explicit correction note.
    basePrompt = `${basePrompt}\n\nCORRECTION AFTER THE PREVIOUS ATTEMPT: You returned ${roadmap.days.length} days, but the learner asked for EXACTLY ${dayCount} days. Re-generate the ENTIRE roadmap so the "days" array contains exactly ${dayCount} entries (day 1 .. day ${dayCount}). No fewer, no more.`;
    roadmap = parseRoadmapResponse(await runOnce(basePrompt));
    dayOk = validateDayCount(roadmap, dayCount);
    if (!dayOk) {
      throw new Error(
        `Roadmap day-count mismatch: requested ${dayCount} days but the model returned ${roadmap.days.length}. Please try generating again.`
      );
    }
  }

  // Phase B: re-plan any day that overshoots the per-day budget.
  if (budget !== null) {
    roadmap = await enforceDailyTimeBudget(roadmap, budget, topic);
  }

  // Phase E: guarantee a usable search query on every day.
  return ensureSearchLinks(roadmap);
}

/** Mirrors enforceDailyTimeBudget() in lib/llm.ts (±10% tolerance band). */
async function enforceDailyTimeBudget(roadmap, budget, topic) {
  const tolerance = budget * 1.1; // a day counts as over-budget only when it
  // meaningfully exceeds the user's stated per-day time.

  for (const day of roadmap.days) {
    const total = dayTotalMinutes(day);
    if (total <= tolerance || !day.tasks?.length) continue;

    const userPrompt = `Total time budget: ${budget} minutes

Day ${day.day_number} "${day.day_title}" currently has tasks totalling ${total} minutes, which overshoots the learner's daily budget.

Current tasks:
${JSON.stringify(day.tasks, null, 2)}

Re-plan these tasks to fit the ${budget}-minute budget.`;

    try {
      const replanned = JSON.parse(
        stripMarkdownFences(await callProvider(REPLAN_SYSTEM_PROMPT, userPrompt))
      );
      if (
        Array.isArray(replanned?.tasks) &&
        replanned.tasks.length > 0 &&
        replanned.tasks.every(
          (t) =>
            typeof t === "object" &&
            t !== null &&
            typeof t.name === "string" &&
            (t.priority === "High" || t.priority === "Medium" || t.priority === "Low") &&
            typeof t.estimated_minutes === "number" &&
            t.estimated_minutes > 0
        )
      ) {
        day.tasks = replanned.tasks;
      }
      // A malformed re-plan keeps the original day (best-effort rebalance).
    } catch (err) {
      console.warn(
        `Day ${day.day_number} re-plan failed; keeping original tasks.`,
        err
      );
    }
  }
  return roadmap;
}

export async function processJob(body) {
  const jobId = body?.jobId;
  const userId = body?.userId || process.env.DEMO_USER_ID || "demo-user";
  if (!jobId) throw new Error("Malformed message: jobId missing.");
  const table = process.env.ROADMAPS_TABLE;

  // 1. Load the job. Missing = orphaned message; discard quietly.
  const job = await doc.send(
    new GetCommand({ TableName: table, Key: { user_id: userId, sk: `JOB#${jobId}` } })
  );
  if (!job.Item) {
    console.warn(`Job ${jobId} not found for ${userId}; discarding message.`);
    return;
  }

  // 2. Idempotency for duplicate deliveries.
  if (job.Item.status === "READY") return;
  if (job.Item.status !== "PROCESSING") {
    await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { user_id: userId, sk: `JOB#${jobId}` },
        UpdateExpression: "SET #s = :processing, updated_at = :now",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":processing": "PROCESSING", ":now": Date.now() },
      })
    );
  }

  try {
    // 3. Cache-aside check — a DynamoDB TTL row IS the Redis substitute.
    const { provider, model } = await currentProviderAndModel();
    const ttlSeconds = parseInt(process.env.CACHE_TTL_SECONDS ?? "86400", 10);
    const key = cacheKeyFor(provider, model, "roadmap", {
      topic: job.Item.topic,
      context: job.Item.context,
    });

    let roadmap;
    let cacheHit = false;
    const cached = await doc.send(
      new GetCommand({ TableName: process.env.CACHE_TABLE, Key: { cache_key: key } })
    );
    if (cached.Item?.response) {
      roadmap = JSON.parse(cached.Item.response);
      cacheHit = true;
      console.log(`Cache HIT ${key}`);
      // Phase A1/B: a cached roadmap from before the strict rules must pass
      // the same validation as a fresh one — retry the plan when it doesn't.
      const dayCount = requestedDayCount(job.Item.context);
      const budget = minutesPerDay(job.Item.context);
      const dayOk = validateDayCount(roadmap, dayCount);
      const overBudget =
        dayOk &&
        budget !== null &&
        roadmap.days.some((d) => dayTotalMinutes(d) > budget * 1.1);
      if (!dayOk || overBudget) {
        console.log(`Cache HIT failed Phase A1/B validation; regenerating.`);
        cacheHit = false;
        roadmap = await generateRoadmapPlan(job.Item.topic, job.Item.context);
      }
      roadmap = ensureSearchLinks(roadmap);
    } else {
      console.log(`Cache MISS ${key}; calling LLM...`);
      roadmap = await generateRoadmapPlan(job.Item.topic, job.Item.context);
      // 4. Populate cache; expires_at makes DynamoDB garbage-collect it.
      await doc.send(
        new PutCommand({
          TableName: process.env.CACHE_TABLE,
          Item: {
            cache_key: key,
            provider,
            model,
            response: JSON.stringify(roadmap),
            created_at: Date.now(),
            expires_at: Math.floor(Date.now() / 1000) + ttlSeconds,
          },
        })
      );
    }
    await commitResult(table, userId, jobId, roadmap, cacheHit);
  } catch (err) {
    // Mark FAILED so pollers get closure; rethrow so SQS retries/DLQ work.
    await doc
      .send(
        new UpdateCommand({
          TableName: table,
          Key: { user_id: userId, sk: `JOB#${jobId}` },
          UpdateExpression: "SET #s = :failed, #e = :err, updated_at = :now",
          ExpressionAttributeNames: { "#s": "status", "#e": "error" },
          ExpressionAttributeValues: {
            ":failed": "FAILED",
            ":err": String(err instanceof Error ? err.message : err).slice(0, 500),
            ":now": Date.now(),
          },
        })
      )
      .catch((e) => console.error("Could not mark job FAILED:", e));
    throw err;
  }
}

/** Atomic commit + SNS fan-out. */
async function commitResult(table, userId, jobId, roadmap, cacheHit) {
  const roadmapId = randomUUID();
  const nowMs = Date.now();

  // One transaction => a crash can never leave READY with no document
  // (or a document nobody will ever see because status stayed PROCESSING).
  await doc.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: table,
            Item: {
              user_id: userId,
              sk: `ROADMAP#${roadmapId}`,
              type: "roadmap",
              roadmap_id: roadmapId,
              job_id: jobId,
              topic_name: roadmap.topic_name,
              topic_lower: String(roadmap.topic_name).toLowerCase(),
              badge_reward: roadmap.badge_reward,
              days: roadmap.days.map((d) => ({
                ...d,
                is_completed: false,
                tasks: d.tasks.map((t) => ({ ...t, manual_minutes: null })),
              })),
              status: "in_progress",
              created_at: nowMs,
            },
          },
        },
        {
          Update: {
            TableName: table,
            Key: { user_id: userId, sk: `JOB#${jobId}` },
            UpdateExpression:
              "SET #s = :ready, roadmap_id = :rid, updated_at = :now REMOVE #e",
            ConditionExpression: "#sk = :sk",
            ExpressionAttributeNames: { "#s": "status", "#e": "error", "#sk": "sk" },
            ExpressionAttributeValues: {
              ":ready": "READY",
              ":rid": roadmapId,
              ":now": nowMs,
              ":sk": `JOB#${jobId}`,
            },
          },
        },
      ],
    })
  );

  await sns.send(
    new PublishCommand({
      TopicArn: process.env.EVENTS_TOPIC_ARN,
      Subject: `Roadmap ready: ${roadmap.topic_name}`,
      Message: JSON.stringify({
        eventType: "ROADMAP_READY",
        userId,
        jobId,
        roadmapId,
        topicName: roadmap.topic_name,
        cacheHit,
        at: new Date().toISOString(),
      }),
    })
  );
}