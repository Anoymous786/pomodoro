/**
 * scripts/verify-progress-sync.mjs — Phase 2 durable-progress acceptance.
 *
 * Requires a RUNNING dev server (VERIFY_URL, default http://localhost:3000).
 *
 * Scenario:
 *   1. API contract: PUT create -> rev 1; stale expectedRev -> 409; valid
 *      expectedRev -> rev increments; GET returns the doc.
 *   2. Hydration: a NEWER remote doc (higher rev, extra practiced seconds,
 *      one step already done) is adopted over the local cache on load.
 *   3. Push: starting the timer and pausing a step lands the practiced
 *      seconds on the server (coalesced, conditional write).
 *   4. Completion: finishing a step (check-in "mark done anyway") marks
 *      isDone in the server doc.
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const BASE = process.env.VERIFY_URL ?? "http://localhost:3000";

function ok(name, cond, extra = "") {
  const mark = cond ? "PASS" : "FAIL";
  console.log(`${mark}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) process.exitCode = 1;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error("No Chrome/Edge found. Set CHROME_PATH.");
}

const TASK_ID = "sync-task-1";
const today = new Date().toISOString().slice(0, 10);

/** Minimal valid task payload for the progress API. */
function makeTask(overrides = {}) {
  return {
    id: TASK_ID,
    name: "Sync Task",
    startDate: today,
    durationDays: 5,
    checkIns: [],
    createdAt: Date.now(),
    roadmap: [
      {
        id: "syn-step-1",
        title: "First Step",
        isDone: false,
        estimated_minutes: 30,
        practicedSeconds: 0,
        elapsedSeconds: 0,
        timerStatus: "idle",
      },
      {
        id: "syn-step-2",
        title: "Second Step",
        isDone: false,
        estimated_minutes: 15,
        practicedSeconds: 0,
        elapsedSeconds: 0,
        timerStatus: "idle",
      },
    ],
    ...overrides,
  };
}

const seededState = {
  activeDate: today,
  settings: {
    workMinutes: 25,
    shortBreakMinutes: 5,
    longBreakMinutes: 15,
    longBreakInterval: 4,
    dailySessionGoal: 8,
  },
  timer: {
    mode: "work",
    isRunning: false,
    endTimestamp: null,
    completedWorkSessions: 0,
    activeTaskId: null,
    taskDurationMinutes: null,
  },
  tasks: [],
  history: {},
  roadmaps: [],
  badges: [],
  activeRoadmapDay: null,
  estimationLog: [],
  practiceTasks: [makeTask()],
};

// ---------------------------------------------------------------------
// 1. API contract (local route; the Lambda implements the same contract)
// ---------------------------------------------------------------------
const api = async (method, body, user = "verify-user") => {
  const res = await fetch(`${BASE}/api/progress`, {
    method,
    headers: { "content-type": "application/json", "x-user-id": user },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

// Start from a clean partition for this verify user (rev 0 create).
// Re-run safety: the dev store persists across runs, so reset the test
// user's docs first (dev-only reset, DELETE with a marker header).
await fetch(`${BASE}/api/progress`, {
  method: "DELETE",
  headers: { "x-user-id": "verify-user", "x-dev-reset": "1" },
});
{
  const { status, data } = await api("PUT", {
    expectedRev: 0,
    taskId: TASK_ID,
    task: makeTask(),
  });
  const good = status === 200 && data.doc && data.doc.rev === 1;
  ok("[api] PUT create (expectedRev 0) accepted, rev=1", good, `status=${status} rev=${data.doc ? data.doc.rev : "?"}`);
}
{
  const { status, data } = await api("PUT", {
    expectedRev: 0,
    taskId: TASK_ID,
    task: makeTask(),
  });
  const good = status === 409 && data.currentRev === 1;
  ok("[api] stale PUT (expectedRev 0 after rev 1) rejected 409", good, `status=${status} currentRev=${data.currentRev}`);
}
{
  const { status, data } = await api("PUT", {
    expectedRev: 1,
    taskId: TASK_ID,
    task: makeTask({ name: "Sync Task v2" }),
  });
  const good = status === 200 && data.doc && data.doc.rev === 2;
  ok("[api] valid PUT (expectedRev 1) increments rev to 2", good, `status=${status} rev=${data.doc ? data.doc.rev : "?"}`);
}
{
  const { status, data } = await api("GET");
  const doc = (data.docs ?? []).find((d) => d.taskId === TASK_ID);
  const good =
    status === 200 && doc && doc.rev === 2 && doc.task && doc.task.name === "Sync Task v2";
  ok("[api] GET returns the durable doc", good, `status=${status}`);
}

// ---------------------------------------------------------------------
// 2/3/4. Browser hydration + push behavior
// ---------------------------------------------------------------------
// The BROWSER identity is the default user (it cannot send x-user-id), so
// the newer doc is seeded there. The local cache gets an OLD copy (no rev,
// zero practice); the server doc is newer (extra practiced seconds, one
// step already done) and must win on load. Rev-safe: works on re-runs.
const BROWSER_USER = "demo-user";
const newerTask = makeTask({
  name: "Sync Task v2",
  roadmap: [
    {
      id: "syn-step-1",
      title: "First Step",
      isDone: false,
      estimated_minutes: 30,
      practicedSeconds: 600,
      elapsedSeconds: 0,
      timerStatus: "idle",
    },
    {
      id: "syn-step-2",
      title: "Second Step",
      isDone: true,
      estimated_minutes: 15,
      practicedSeconds: 900,
      elapsedSeconds: 0,
      timerStatus: "finished",
    },
  ],
});

const seededRev = await (async () => {
  const { data } = await api("GET", null, BROWSER_USER);
  const existing = (data.docs ?? []).find((d) => d.taskId === TASK_ID);
  const expectedRev = existing ? existing.rev : 0;
  const { status, data: put } = await api(
    "PUT",
    { expectedRev, taskId: TASK_ID, task: newerTask },
    BROWSER_USER
  );
  if (status !== 200 || !put.doc) {
    throw new Error(`seed failed: ${status} ${JSON.stringify(put).slice(0, 200)}`);
  }
  return put.doc.rev;
})();

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
    if (m.text().includes("[sync]")) console.log(`   browser: ${m.text()}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  await page.setViewport({ width: 1280, height: 1000 });
  await page.evaluateOnNewDocument((state) => {
    // Old local cache: no rev, zero practice. Must LOSE to the server doc.
    window.localStorage.setItem("pomodoro:app:v1", JSON.stringify(state));
  }, seededState);

  await page.goto(`${BASE}/task/sync-task-1`, {
    waitUntil: "networkidle0",
    timeout: 60000,
  });
  await page.waitForSelector("[data-testid='ws-title']", {
    visible: true,
    timeout: 30000,
  });
  await new Promise((r) => setTimeout(r, 1500)); // hydration + merge

  const readTask = () =>
    page.evaluate(
      () =>
        (JSON.parse(window.localStorage.getItem("pomodoro:app:v1") ?? "{}")
          .practiceTasks ?? []).find((t) => t.id === "sync-task-1") ?? null
    );

  // ---- 2. Hydration: the seeded remote doc must beat the local cache ----
  let t = await readTask();
  ok(
    "[hydrate] remote rev adopted",
    (t && t.rev ? t.rev : 0) >= seededRev,
    `rev=${t && t.rev ? t.rev : "?"} seededRev=${seededRev}`
  );
  ok(
    "[hydrate] server practicedSeconds won (600s)",
    t && t.roadmap && t.roadmap[0]
      ? t.roadmap[0].practicedSeconds === 600
      : false,
    `got ${t && t.roadmap && t.roadmap[0] ? t.roadmap[0].practicedSeconds : "?"}s`
  );
  ok(
    "[hydrate] server isDone won (step 2 done)",
    t && t.roadmap && t.roadmap[1] ? t.roadmap[1].isDone === true : false,
    `got ${t && t.roadmap && t.roadmap[1] ? String(t.roadmap[1].isDone) : "?"}`
  );

  // ---- 3. Push: start timer, pause; practiced time must reach the API ----
  const rows = await page.$$("[data-testid='step-row']");
  let firstRow = null;
  for (const r of rows) {
    const title = await r.evaluate((el) => el.getAttribute("data-step-title"));
    if (title === "First Step") firstRow = r;
  }
  if (!firstRow) throw new Error("First Step row not found");
  await (await firstRow.$("[data-testid='timer-start']")).click();
  await page.waitForSelector("[data-testid='timer-pause']", { visible: true });
  await new Promise((r) => setTimeout(r, 2500)); // let the clock accrue
  await (await firstRow.$("[data-testid='timer-pause']")).click();
  await new Promise((r) => setTimeout(r, 4000)); // coalesce (~1.5s) + PUT

  const { data: afterPause } = await api("GET", null, BROWSER_USER);
  const docAfterPause = (afterPause.docs ?? []).find(
    (d) => d.taskId === TASK_ID
  );
  const remoteStep1 =
    docAfterPause && docAfterPause.task && Array.isArray(docAfterPause.task.roadmap)
      ? docAfterPause.task.roadmap.find((s) => s.id === "syn-step-1")
      : null;
  ok(
    "[push] practiced time landed on the server (>600s)",
    remoteStep1 && remoteStep1.practicedSeconds > 600,
    `got ${remoteStep1 ? remoteStep1.practicedSeconds : "?"}s`
  );
  ok(
    "[push] server rev advanced beyond the seeded rev",
    docAfterPause && docAfterPause.rev > seededRev,
    `rev=${docAfterPause ? docAfterPause.rev : "?"} seededRev=${seededRev}`
  );
  t = await readTask();
  ok(
    "[push] local rev tracks the server",
    t && t.rev >= seededRev,
    `rev=${t && t.rev ? t.rev : "?"}`
  );

  // ---- 4. Completion: finish step 1 via the check-in modal ----
  await (await firstRow.$("[data-testid='timer-resume']")).click();
  await (await firstRow.$("[data-testid='timer-finish']")).click();
  await page.waitForSelector("[data-testid='checkin-modal']", {
    visible: true,
    timeout: 20000,
  });
  // Provider-free path: "Mark done anyway (unverified)".
  await page.waitForSelector("[data-testid='checkin-skip']", {
    visible: true,
    timeout: 20000,
  });
  await page.click("[data-testid='checkin-skip']");
  await new Promise((r) => setTimeout(r, 4000)); // push coalescing

  const { data: afterDone } = await api("GET", null, BROWSER_USER);
  const docAfterDone = (afterDone.docs ?? []).find(
    (d) => d.taskId === TASK_ID
  );
  const doneStep1 =
    docAfterDone && docAfterDone.task && Array.isArray(docAfterDone.task.roadmap)
      ? docAfterDone.task.roadmap.find((s) => s.id === "syn-step-1")
      : null;
  ok(
    "[finish] step isDone persisted on the server",
    doneStep1 && doneStep1.isDone === true,
    `got ${doneStep1 ? String(doneStep1.isDone) : "?"}`
  );

  const criticalErrors = consoleErrors.filter(
    (e) => !e.includes("favicon") && !e.includes("net::ERR")
  );
  ok(
    "[console] no page errors during the sync journey",
    criticalErrors.length === 0,
    criticalErrors.slice(0, 2).join(" | ")
  );
} finally {
  await browser.close();
}
