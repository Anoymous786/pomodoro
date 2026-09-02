/**
 * POST /api/focus-logs  (Phase 4)
 *
 * Persists a focus measurement captured client-side during a work session
 * (Page Visibility API) to the focus_sessions DynamoDB table. The detection
 * itself is purely client-side; this endpoint only stores the result so the
 * session record has a durable, queryable focus score.
 *
 * Body: { taskName?, mode?, durationMinutes, distractions,
 *         distractionSeconds, focusPercent, startedAt? }
 *
 * Writer-only, least-privilege IAM: dynamodb:PutItem on focus_sessions only.
 */
import { doc, PutCommand } from "./aws.mjs";
import { badRequest, json, parseBody, serverError, userIdFor } from "./respond.mjs";

const FOCUS_TABLE = () => process.env.FOCUS_TABLE;

export const handler = async (event) => {
  let obj;
  try {
    obj = parseBody(event);
  } catch {
    return badRequest("Invalid JSON body.");
  }

  // Validate the numbers that drive the score; everything else is optional.
  const durationMinutes =
    typeof obj.durationMinutes === "number" && obj.durationMinutes > 0
      ? obj.durationMinutes
      : 0;
  const distractions =
    typeof obj.distractions === "number" && Number.isFinite(obj.distractions)
      ? Math.max(0, Math.floor(obj.distractions))
      : 0;
  const distractionSeconds =
    typeof obj.distractionSeconds === "number" &&
    Number.isFinite(obj.distractionSeconds)
      ? Math.max(0, Math.floor(obj.distractionSeconds))
      : 0;
  const focusPercent =
    typeof obj.focusPercent === "number" && Number.isFinite(obj.focusPercent)
      ? Math.min(100, Math.max(0, Math.round(obj.focusPercent)))
      : 100;

  if (durationMinutes <= 0 && distractionSeconds === 0) {
    return badRequest("A session with no duration is not a valid focus log.");
  }

  if (!FOCUS_TABLE()) {
    return serverError("FOCUS_TABLE is not configured.");
  }

  const user = userFor(event);
  const sessionId = crypto.randomUUID();
  const now = Date.now();

  try {
    await doc.send(
      new PutCommand({
        TableName: FOCUS_TABLE(),
        Item: {
          user_id: user,
          sk: `SESSION#${now}`,
          type: "focus_session",
          session_id: sessionId,
          task_name:
            typeof obj.taskName === "string" && obj.taskName.trim()
              ? obj.taskName.trim().slice(0, 200)
              : null,
          mode:
            typeof obj.mode === "string" && obj.mode.trim()
              ? obj.mode.trim().slice(0, 32)
              : "work",
          duration_minutes: durationMinutes,
          distractions,
          distraction_seconds: distractionSeconds,
          focus_percent: focusPercent,
          created_at: now,
        },
      })
    );
    return json(201, { ok: true, sessionId });
  } catch (err) {
    console.error("focus-logs failed:", err);
    return serverError(err instanceof Error ? err.message : "Failed to log focus.");
  }
};