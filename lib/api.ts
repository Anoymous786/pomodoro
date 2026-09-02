/**
 * lib/api.ts — thin client in front of BOTH deployment modes:
 *
 *  - Local dev: no env var set -> relative paths hit the existing Next.js
 *    route handlers exactly like before (zero behavior change).
 *  - Deployed: NEXT_PUBLIC_API_BASE_URL (the API Gateway URL) prefixes every
 *    call. Roadmap generation then uses the ASYNC flow (Phase 4):
 *    POST /api/generate-roadmap enqueues a job, and we poll the DynamoDB-
 *    backed status endpoint until the worker marks it READY.
 *    Resume uploads switch to direct-to-S3 pre-signed PUTs (Phase 3).
 */
import type { IntakeContext, PracticeTask } from "./types";

const RAW_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").trim();
const BASE = RAW_BASE.replace(/\/+$/, "");

/** True when the app should talk to AWS instead of Next.js route handlers. */
export function isRemoteApi(): boolean {
  return BASE.length > 0;
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${BASE}${path}`, init);
  } catch {
    throw new Error(
      "Could not reach the server. Check your connection and try again."
    );
  }
}

/** POST JSON — drop-in replacement for the old inline fetch calls. */
export async function apiPost(path: string, body: unknown): Promise<Response> {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

export async function apiGet(path: string): Promise<Response> {
  return request(path);
}

// --------------------------------------------------------------------
// Async roadmap generation (Phase 4)
// --------------------------------------------------------------------

export interface ApiRoadmapTask {
  name: string;
  priority: "High" | "Medium" | "Low";
  estimated_minutes: number;
  /** (Phase 3) AI one-line "explain why" for this task's placement/estimate. */
  reason?: string;
}

export interface ApiRoadmapDay {
  day_number: number;
  day_title: string;
  tasks: ApiRoadmapTask[];
  /** (Phase 3) AI one-line "explain why" for this day's position in the sequence. */
  reason?: string;
}

export interface ApiRoadmap {
  topic_name: string;
  badge_reward: { title: string; icon: string };
  days: ApiRoadmapDay[];
}

interface JobStatusResponse {
  jobId?: string;
  status?: "PENDING" | "PROCESSING" | "READY" | "FAILED";
  roadmap?: ApiRoadmap | null;
  error?: string;
}

/**
 * Submits generation, then polls GET /api/roadmap-status/{jobId} every
 * ~2.5s until READY/FAILED (120s budget). Returns the SAME roadmap shape
 * the old synchronous endpoint produced, so callers don't change.
 */
export async function generateRoadmapRemote(
  topic: string,
  context?: IntakeContext,
  opts?: { intervalMs?: number; timeoutMs?: number }
): Promise<ApiRoadmap> {
  const submit = await apiPost("/api/generate-roadmap", { topic, context });
  const submitted = (await submit.json()) as JobStatusResponse;
  if (!submit.ok || !submitted.jobId) {
    throw new Error(submitted.error ?? "Failed to start roadmap generation.");
  }

  const interval = opts?.intervalMs ?? 2500;
  const deadline = Date.now() + (opts?.timeoutMs ?? 120_000);

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const res = await apiGet(
      `/api/roadmap-status/${encodeURIComponent(submitted.jobId)}`
    );
    const data = (await res.json()) as JobStatusResponse;
    if (!res.ok) {
      throw new Error(data.error ?? "Lost track of your roadmap job.");
    }
    if (data.status === "READY") {
      if (!data.roadmap) {
        throw new Error("Generation finished but the roadmap is missing.");
      }
      return data.roadmap;
    }
    if (data.status === "FAILED") {
      throw new Error(data.error ?? "Roadmap generation failed.");
    }
    // PENDING / PROCESSING -> keep polling.
  }
  throw new Error(
    "The roadmap is taking unusually long. Try again shortly."
  );
}

/**
 * Asks the API for a pre-signed PUT URL, uploads the file DIRECTLY to the
 * private bucket (bytes never touch the API), then polls until the
 * S3-triggered extractor Lambda publishes the text. Resolves to the
 * extracted text (already capped at 8000 chars server-side).
 */
export async function uploadResumeToS3(file: File): Promise<string> {
  const presign = await apiPost("/api/uploads/presign", {
    filename: file.name,
  });
  const signed = (await presign.json()) as {
    key?: string;
    uploadUrl?: string;
    contentType?: string;
    pollTextUrl?: string;
    error?: string;
  };
  if (
    !presign.ok ||
    !signed.uploadUrl ||
    !signed.contentType ||
    !signed.pollTextUrl
  ) {
    throw new Error(signed.error ?? "Could not prepare the resume upload.");
  }

  // Content-Type MUST match what was signed or S3 rejects the request.
  const put = await fetch(signed.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": signed.contentType },
    body: file,
  });
  if (!put.ok) {
    throw new Error("Upload failed. Please try again.");
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200));
    const res = await apiGet(signed.pollTextUrl);
    const data = (await res.json()) as {
      pending?: boolean;
      text?: string | null;
      error?: string;
    };
    if (!res.ok) {
      throw new Error(data.error ?? "Could not read the extracted text.");
    }
    if (typeof data.text === "string") {
      if (data.text.replace(/\s+/g, "").length < 80) {
        throw new Error(
          "We couldn't read enough text from that file. Try a .txt export instead."
        );
      }
      return data.text;
    }
    if (data.pending === false) {
      // Extractor finished without text -> it recorded an error message.
      throw new Error(
        data.error ??
          "We couldn't extract text from that file. Try a different format."
      );
    }
    // Still pending -> keep polling.
  }
  throw new Error(
    "Text extraction is taking longer than expected. Try a smaller or plain-text file."
  );
}

// --------------------------------------------------------------------
// Phase 4: focus session logging
// --------------------------------------------------------------------

export interface FocusLogPayload {
  taskName?: string | null;
  mode?: string;
  durationMinutes: number;
  distractions: number;
  distractionSeconds: number;
  focusPercent: number;
  startedAt?: number;
}

/**
 * Best-effort POST to /api/focus-logs whenever a work session ends. The
 * client already has the focus measurement; this only persists it to the
 * focus_sessions DynamoDB table. Failures are swallowed (never block the
 * session-end flow or surface a toast).
 */
export async function logFocusSession(payload: FocusLogPayload): Promise<boolean> {
  try {
    const res = await apiPost("/api/focus-logs", payload);
    return res.ok;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------
// Phase 2: durable per-task progress documents (PROGRESS# item kind in
// the EXISTING roadmaps DynamoDB table). localStorage remains the
// offline/UI cache; the server doc is authoritative when its rev is
// higher, and writes are conditional so stale tabs cannot clobber newer
// progress.
// --------------------------------------------------------------------

/** One durable per-task progress document. */
export interface ProgressDoc {
  taskId: string;
  /** Server-assigned revision; increments on every accepted write. */
  rev: number;
  /** Full PracticeTask payload minus transport-only rev/syncedAt fields. */
  task: Omit<PracticeTask, "rev" | "syncedAt">;
}

/** Local-mode response shape of GET /api/progress. */
export interface ProgressListResponse {
  docs: ProgressDoc[];
  /** True when running against the local Next.js route (acknowledged data). */
  local?: boolean;
}

/**
 * Fetches every durable progress document for the current user.
 * Returns null when the endpoint is unavailable (e.g. offline) so callers
 * can distinguish "no data yet" from "could not ask".
 */
export async function fetchProgressDocs(): Promise<ProgressDoc[] | null> {
  try {
    const res = await apiGet("/api/progress");
    if (!res.ok) return null;
    const data = (await res.json()) as ProgressListResponse;
    return Array.isArray(data.docs) ? data.docs : [];
  } catch {
    return null;
  }
}

/**
 * Conditionally writes one progress document. The server only accepts the
 * write when the stored rev matches `expectedRev` (0 = create-new); a 409
 * response means another tab/device advanced the doc first and the caller
 * must re-hydrate. Returns the authoritative doc on success.
 */
export async function putProgressDoc(
  doc: ProgressDoc,
  expectedRev: number
): Promise<{ ok: boolean; conflict: boolean; doc?: ProgressDoc }> {
  try {
    const res = await request("/api/progress", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRev, ...doc }),
    });
    if (res.status === 409) return { ok: false, conflict: true };
    if (!res.ok) return { ok: false, conflict: false };
    const data = (await res.json()) as { doc?: ProgressDoc };
    return { ok: true, conflict: false, doc: data.doc };
  } catch {
    return { ok: false, conflict: false };
  }
}