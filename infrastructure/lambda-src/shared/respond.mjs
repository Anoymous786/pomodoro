/**
 * shared/respond.mjs — tiny HTTP response helpers for Lambda proxy v2.
 *
 * DELIBERATELY NO CORS HEADERS HERE:
 * API Gateway's cors_configuration injects Access-Control-* headers on both
 * preflight (OPTIONS) and actual responses. If Lambda also returned them the
 * browser would see DUPLICATE headers and reject the response.
 */

export const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const badRequest = (message) => json(400, { error: message });

export const notFound = (message) => json(404, { error: message });

export const serverError = (message) => json(500, { error: message });

/**
 * Parses event.body into an object (handles API Gateway base64 encoding).
 * Returns {} when the body is empty; throws on malformed JSON — callers
 * convert that into a 400 exactly like the old Next.js routes did.
 */
export function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  return JSON.parse(raw);
}

/**
 * Single-tenant demo identity: x-user-id header overrides the default.
 * Swapping this for real auth later means replacing ONLY this function.
 */
export function userIdFor(event) {
  const header =
    event.headers?.["x-user-id"] ?? event.headers?.["X-User-Id"] ?? "";
  const trimmed = typeof header === "string" ? header.trim() : "";
  if (trimmed) return trimmed.slice(0, 128);
  return process.env.DEMO_USER_ID || "demo-user";
}
