/**
 * lib/progress-store-server.ts — SERVER-SIDE authoritative progress store.
 *
 * Shared by the progress route (writes) AND the chatbot route (reads) so the
 * chatbot always accesses the SAME durable persisted state used by the task
 * manager, dashboard, assessments, exams and timers (Req 16 / "chatbot data
 * source of truth"). No second database.
 *
 * Local dev: a JSON file under .next/ (mirrors deployed DynamoDB durability).
 * Deployed: the DynamoDB-backed progress Lambda; this module is the local
 * twin. Per-user isolation is enforced by the `getAllStoredDocs(userId)` API.
 */
import fs from "node:fs";
import path from "node:path";

export interface StoredDoc {
  taskId: string;
  rev: number;
  task: Record<string, unknown>;
}

const STORE_PATH = path.join(process.cwd(), ".next", "progress-dev-store.json");

/** user id -> (taskId -> doc). Keyed like the deployed table (user / sk). */
const store: Map<string, Map<string, StoredDoc>> = (() => {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as Record<
      string,
      StoredDoc[]
    >;
    const out = new Map<string, Map<string, StoredDoc>>();
    for (const [user, docs] of Object.entries(parsed)) {
      const m = new Map<string, StoredDoc>();
      for (const d of docs) m.set(d.taskId, d);
      out.set(user, m);
    }
    return out;
  } catch {
    return new Map();
  }
})();

export function persistStore(): void {
  try {
    const obj: Record<string, StoredDoc[]> = {};
    store.forEach((m, user) => {
      obj[user] = Array.from(m.values());
    });
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(obj));
  } catch {
    // Best-effort dev persistence; never fail a request over the cache.
  }
}

export function ensureUser(userId: string): Map<string, StoredDoc> {
  let m = store.get(userId);
  if (!m) {
    m = new Map();
    store.set(userId, m);
  }
  return m;
}

/**
 * Returns every stored progress doc for ONE user, as the standard
 * ProgressDoc wire shape. This is the authoritative "getUserLearningData"
 * read the chatbot (and any future server-side feature) uses — it is never
 * a stale client snapshot, and it is scoped strictly to the caller's user.
 */
export function getAllStoredDocs(
  userId: string,
): { taskId: string; rev: number; task: Record<string, unknown> }[] {
  return Array.from(ensureUser(userId).values()).map((d) => ({
    taskId: d.taskId,
    rev: d.rev,
    task: d.task,
  }));
}

/** Dev-only convenience: wipe one user's progress docs. */
export function deleteUserDocs(userId: string): void {
  ensureUser(userId).clear();
  persistStore();
}

/**
 * Single-tenant demo identity — the SAME resolution as the deployed Lambda
 * (x-user-id header override / DEMO_USER_ID / "demo-user"). Shared so the
 * progress store and the chatbot query the same per-user partition.
 */
export function resolveUserId(
  headers: { get(name: string): string | null } | Headers,
): string {
  if (typeof headers?.get === "function") {
    const h = headers.get("x-user-id")?.trim().slice(0, 128);
    if (h) return h;
  }
  return process.env.DEMO_USER_ID || "demo-user";
}