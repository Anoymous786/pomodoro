/**
 * GET /api/roadmap-status/{jobId}  (Phase 4)
 *
 * The polling half of async generation. Reads the job item from DynamoDB;
 * when the worker marked it READY, fetches the roadmap document and returns
 * it in the SAME shape the old synchronous route produced, so the frontend
 * normalization code does not change.
 */
import { doc, GetCommand } from "./aws.mjs";
import { badRequest, json, notFound, serverError, userIdFor } from "./respond.mjs";

/** Strips storage-only fields, returning the old API contract. */
function publicRoadmap(item) {
  return {
    topic_name: item.topic_name,
    badge_reward: item.badge_reward,
    days: item.days,
  };
}

export const handler = async (event) => {
  const jobId = event.pathParameters?.jobId ?? "";
  if (!jobId) return badRequest("Missing jobId.");

  const userId = userIdFor(event);

  try {
    const job = await doc.send(
      new GetCommand({
        TableName: process.env.ROADMAPS_TABLE,
        Key: { user_id: userId, sk: `JOB#${jobId}` },
      })
    );
    if (!job.Item) return notFound("Unknown jobId.");

    const base = {
      jobId,
      status: job.Item.status,
      topic: job.Item.topic,
      createdAt: job.Item.created_at,
      updatedAt: job.Item.updated_at,
    };

    if (job.Item.status === "FAILED") {
      return json(200, { ...base, error: job.Item.error ?? "Generation failed." });
    }
    if (job.Item.status !== "READY") {
      // PENDING / PROCESSING — keep polling.
      return json(200, base);
    }

    const road = await doc.send(
      new GetCommand({
        TableName: process.env.ROADMAPS_TABLE,
        Key: { user_id: userId, sk: `ROADMAP#${job.Item.roadmap_id}` },
      })
    );
    if (!road.Item) {
      return json(200, { ...base, error: "Roadmap document is missing." });
    }
    return json(200, { ...base, roadmap: publicRoadmap(road.Item) });
  } catch (err) {
    console.error("roadmap-status failed:", err);
    return serverError(
      err instanceof Error ? err.message : "Failed to look up job status."
    );
  }
};