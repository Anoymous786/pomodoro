/**
 * GET /api/search?topic=&userId=&limit=   (Phase 5)
 *
 * The OpenSearch substitute. Two access patterns over ONE table:
 *   ?topic=... -> Scan + FilterExpression contains(topic_lower, q) across
 *                  all roadmaps (cross-user discovery)
 *   no topic   -> Query of one user's ROADMAP# items, newest first
 *
 * Honest trade-off vs OpenSearch: a filtered Scan still READS every item
 * (you pay RCU for scanned KBs) and `contains` is substring matching, not
 * relevance-ranked full-text. At demo scale that costs fractions of one
 * free-tier RCU; if it ever grew, the upgrade path is a topic_lower GSI or
 * actual OpenSearch — this endpoint's contract would not change.
 */
import { doc, QueryCommand, ScanCommand } from "./aws.mjs";
import { json, serverError } from "./respond.mjs";

// Summaries only — never ship whole roadmap documents back from a search.
const PROJECTION =
  "user_id, #sk, roadmap_id, topic_name, badge_reward, status, created_at";

export const handler = async (event) => {
  const params = event.queryStringParameters ?? {};
  const topic = typeof params.topic === "string" ? params.topic.trim() : "";
  const userId = params.userId || process.env.DEMO_USER_ID || "demo-user";
  const limit = Math.min(
    Math.max(parseInt(params.limit ?? "20", 10) || 20, 1),
    50
  );

  try {
    let items;

    if (topic) {
      const res = await doc.send(
        new ScanCommand({
          TableName: process.env.ROADMAPS_TABLE,
          FilterExpression: "#t = :roadmap AND contains(topic_lower, :q)",
          ExpressionAttributeNames: { "#t": "type", "#sk": "sk" },
          ExpressionAttributeValues: {
            ":roadmap": "roadmap",
            ":q": topic.toLowerCase(),
          },
          ProjectionExpression: PROJECTION,
          PageSize: limit,
        })
      );
      items = res.Items ?? [];
    } else {
      const res = await doc.send(
        new QueryCommand({
          TableName: process.env.ROADMAPS_TABLE,
          KeyConditionExpression: "#u = :u AND begins_with(#sk, :p)",
          ExpressionAttributeNames: { "#u": "user_id", "#sk": "sk" },
          ExpressionAttributeValues: { ":u": userId, ":p": "ROADMAP#" },
          ProjectionExpression: PROJECTION,
          ScanIndexForward: false, // newest first
          Limit: limit,
        })
      );
      items = res.Items ?? [];
    }

    const results = items.map((i) => ({
      userId: i.user_id,
      roadmapId: i.roadmap_id,
      topicName: i.topic_name,
      badgeReward: i.badge_reward,
      status: i.status,
      createdAt: i.created_at,
    }));

    return json(200, { query: topic || null, count: results.length, results });
  } catch (err) {
    console.error("roadmap-search failed:", err);
    return serverError(
      err instanceof Error ? err.message : "Failed to search roadmaps."
    );
  }
};