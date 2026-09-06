/**
 * POST /api/uploads/presign + GET /api/uploads/text   (Phase 3)
 *
 * The browser never sends file bytes through API Gateway:
 *   1. POST /presign  -> returns a pre-signed S3 PUT URL (15 min) scoped to
 *      ONE key under uploads/<uuid>/<filename>. The client uploads DIRECTLY
 *      to S3 — no 6MB payload limit, no double bandwidth cost.
 *   2. GET  /text     -> the client polls this until the S3-event-triggered
 *      extractor has written extracted/<key>.json, then gets the text that
 *      feeds the intake flow.
 */
import { randomUUID } from "node:crypto";
import {
  GetObjectCommand,
  getSignedUrl,
  PutObjectCommand,
  s3,
} from "./aws.mjs";
import { badRequest, json, parseBody, serverError } from "./respond.mjs";

const ALLOWED = new Set(["txt", "md", "markdown", "csv", "pdf", "docx"]);

/** Server decides the Content-Type so the signature and the PUT agree. */
function contentTypeFor(ext) {
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "md":
    case "markdown":
      return "text/markdown";
    case "csv":
      return "text/csv";
    default:
      return "text/plain";
  }
}

/** Basename only, restricted charset, hard length cap — defense in depth. */
function sanitizeName(name) {
  const base = String(name).split(/[\\/]/).pop() ?? "resume";
  return base.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "resume";
}

async function handlePresign(obj) {
  const filename = typeof obj.filename === "string" ? obj.filename : "";
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  if (!filename || !ALLOWED.has(ext)) {
    return badRequest(
      `Unsupported file type. Allowed: ${[...ALLOWED].map((e) => "." + e).join(", ")}.`
    );
  }

  const contentType = contentTypeFor(ext);
  const key = `uploads/${randomUUID()}/${sanitizeName(filename)}`;

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: process.env.RESUME_BUCKET,
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn: 900 }
  );

  return json(200, {
    key,
    uploadUrl,
    method: "PUT",
    expiresIn: 900,
    // The client MUST send exactly this header or S3 rejects the signature.
    contentType,
    // /api/uploads/text only accepts extractor outputs (extracted/<key>.json —
    // see safeExtractedKey), so poll the EXTRACTED key, not the uploads key.
    pollTextUrl: `/api/uploads/text?key=${encodeURIComponent(`extracted/${key}.json`)}`,
  });
}

/** Blocks traversal/shapes: only extractor outputs under extracted/uploads/. */
function safeExtractedKey(raw) {
  if (typeof raw !== "string") return null;
  if (!raw.startsWith("extracted/uploads/")) return null;
  if (!raw.endsWith(".json")) return null;
  if (raw.includes("..")) return null;
  if (!/^[\w./\-]+$/.test(raw)) return null;
  return raw;
}

async function handleReadText(query) {
  const target = safeExtractedKey(query?.key);
  if (!target) return badRequest("Invalid or missing key parameter.");

  try {
    await s3.send(
      new GetObjectCommand({ Bucket: process.env.RESUME_BUCKET, Key: target })
    );
  } catch (err) {
    const name = err?.name ?? err?.Code ?? "";
    if (name === "NoSuchKey" || name === "NotFound" || err?.$metadata?.httpStatusCode === 404) {
      // Not ready yet -> client keeps polling.
      return json(200, { key: query.key, pending: true, text: null });
    }
    throw err;
  }

  const res = await s3.send(
    new GetObjectCommand({ Bucket: process.env.RESUME_BUCKET, Key: target })
  );
  // transformToByteArray() returns a BARE Uint8Array; Buffer.concat() needs an
  // ARRAY of buffers, so wrap it in [...]. Bare passing throws
  // "The list argument must be an instance of Array" on the Node 20 runtime.
  const body = JSON.parse(
    Buffer.concat([await res.Body.transformToByteArray()]).toString("utf8")
  );
  return json(200, { key: query.key, pending: false, ...body });
}

export const handler = async (event) => {
  try {
    switch (event.routeKey) {
      case "POST /api/uploads/presign": {
        let obj;
        try {
          obj = parseBody(event);
        } catch {
          return badRequest("Invalid JSON body.");
        }
        return await handlePresign(obj);
      }
      case "GET /api/uploads/text":
        return await handleReadText(event.queryStringParameters ?? {});
      default:
        return json(404, { error: `Unsupported route: ${event.routeKey}` });
    }
  } catch (err) {
    console.error("get-upload-url failed:", err);
    return serverError(
      err instanceof Error ? err.message : "Upload helper failed."
    );
  }
};