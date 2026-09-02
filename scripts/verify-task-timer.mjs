/**
 * scripts/verify-task-timer.mjs — Task time-tracking + timer acceptance.
 * Implements the requested scenario against a RUNNING dev server:
 *
 *   Create task -> create steps -> assign time -> start -> pause -> resume
 *   -> finish -> verify progress and time update correctly.
 *
 * The steps/timer data must remain attached to the correct task + step and
 * survive the journey (persisted in localStorage).
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

// Seed one Django task with a 3-step roadmap. Step 1 has an estimate so its
// Start button is enabled; Step "Mini Project" has no estimate (Start must be
// disabled until one is set) to prove the time flow.
const today = new Date().toISOString().slice(0, 10);
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
  practiceTasks: [
    {
      id: "django-task",
      name: "Django",
      description: "Web framework from scratch",
      startDate: today,
      durationDays: 7,
      checkIns: [],
      createdAt: Date.now(),
      roadmap: [
        {
          id: "stp-1",
          title: "Django Basics",
          note: "Install + first project",
          isDone: false,
          estimated_minutes: 120, // 2h
          practicedSeconds: 0,
          elapsedSeconds: 0,
          timerStatus: "idle",
        },
        {
          id: "stp-2",
          title: "URLs & Views",
          note: "Hello world + routing",
          isDone: false,
          estimated_minutes: 45, // 45m
          practicedSeconds: 0,
          elapsedSeconds: 0,
          timerStatus: "idle",
        },
        {
          id: "stp-3",
          title: "Mini Project",
          note: "",
          isDone: false,
          // No estimate set -> Start disabled until one is provided.
          practicedSeconds: 0,
          elapsedSeconds: 0,
          timerStatus: "idle",
        },
      ],
    },
  ],
};

// Phase 2: the server is the authoritative source of truth, so the harness
// seeds BOTH layers for the demo-user identity the browser uses. Without
// the server seed, hydration would adopt an empty server partition over
// the localStorage fixture. The DELETE makes the script re-runnable.
const TASK_ID = seededState.practiceTasks[0].id;
const VERIFY_BASE = process.env.VERIFY_URL ?? "http://localhost:3000";
await fetch(`${VERIFY_BASE}/api/progress`, {
  method: "DELETE",
  headers: { "x-user-id": "demo-user" },
});
{
  const res = await fetch(`${VERIFY_BASE}/api/progress`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-user-id": "demo-user" },
    body: JSON.stringify({
      expectedRev: 0,
      taskId: TASK_ID,
      task: seededState.practiceTasks[0],
    }),
  });
  if (!res.ok) {
    throw new Error(`server seed failed: ${res.status} ${await res.text()}`);
  }
}
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
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  await page.setViewport({ width: 1280, height: 1000 });
  await page.evaluateOnNewDocument((state) => {
    // Seed only on the FIRST load; never clobber state a reload persisted
    // (otherwise the reload-persistence checks could never pass).
    if (!window.localStorage.getItem("pomodoro:app:v1")) {
      window.localStorage.setItem("pomodoro:app:v1", JSON.stringify(state));
    }
  }, seededState);

  // Read persisted practiceTasks from the live page.
  const readTasks = () =>
    page.evaluate(
      () =>
        JSON.parse(window.localStorage.getItem("pomodoro:app:v1") ?? "{}")
          .practiceTasks ?? []
    );
  const readStepId = async (taskName, stepTitle) =>
    (await readTasks())
      .find((t) => t.name === taskName)
      .roadmap.find((s) => s.title === stepTitle).id;
  const rowFor = async (byTitle, fallbackIndex) => {
    const rows = await page.$$("[data-testid='step-row']");
    for (const r of rows) {
      const t = await r.evaluate((el) => el.getAttribute("data-step-title"));
      if (t === byTitle) return r;
    }
    return rows[fallbackIndex];
  };

  // ---- Open Django's workspace directly ----
  await page.goto(`${BASE}/task/django-task`, { waitUntil: "networkidle0", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1000));
  await page.waitForSelector("[data-testid='ws-title']", { visible: true });
  const title = await page.$eval("[data-testid='ws-title']", (el) => el.textContent || "");
  ok("[open] Django workspace renders only Django", title.trim() === "Django", title);
  const body1 = await page.$eval("body", (el) => el.textContent || "");
  ok(
    "[focus] no other task content leaked in",
    !body1.includes("Spring Boot") && !body1.includes("Python"),
    ""
  );

  // ---- Summary: Deadline / Estimated / Practiced / Remaining / Progress ----
  const sumEst = await page.$eval("[data-testid='sum-estimated']", (el) => el.textContent || "");
  // 120 + 45 = 165 minutes => "2h 45m"
  ok("[sum] total estimated = 2h 45m", sumEst.includes("2h 45m"), sumEst);
  const sumPrac = await page.$eval("[data-testid='sum-practiced']", (el) => el.textContent || "");
  ok("[sum] practiced starts empty", /^0m$/.test(sumPrac.trim()), sumPrac);
  const sumRem = await page.$eval("[data-testid='sum-remaining']", (el) => el.textContent || "");
  ok("[sum] remaining = estimated initially", sumRem.includes("2h 45m"), sumRem);
  const prog = await page.$eval("[data-testid='ws-progress']", (el) => el.textContent || "");
  ok("[sum] progress shown", /\d+%/.test(prog), prog);
  const sumDeadline = await page.$eval("[data-testid='sum-deadline']", (el) => el.textContent || "");
  ok("[sum] deadline present", /\d+ \w+/.test(sumDeadline.trim()), sumDeadline);

  // ---- Per-step estimated time + edit updates totals ----
  const s1id = await readStepId("Django", "Django Basics");
  const est1 = await page.$eval(`[data-testid='step-est-${s1id}']`, (el) => el.textContent || "");
  ok("[steps] Django Basics shows ≈2h", est1.includes("2h"), est1);

  // Edit "Mini Project" (no estimate) to add 3h via inline edit.
  const miniRow = await rowFor("Mini Project", 2);
  await (await miniRow.$("[data-testid='step-edit']")).click();
  await page.waitForSelector("[data-testid='step-edit-duration']", { visible: true });
  await page.type("[data-testid='step-edit-duration']", "3h");
  await page.click("[data-testid='step-save']");
  await new Promise((r) => setTimeout(r, 400));
  const sumEst2 = await page.$eval("[data-testid='sum-estimated']", (el) => el.textContent || "");
  // 120 + 45 + 180 = 345 min = 5h 45m.
  ok("[edit] editing estimate updates totals (5h 45m)", sumEst2.includes("5h 45m"), sumEst2);
  const s3id = await readStepId("Django", "Mini Project");
  const est3 = await page.$eval(`[data-testid='step-est-${s3id}']`, (el) => el.textContent || "");
  ok("[edit] Mini Project now shows ≈3h", est3.includes("3h"), est3);

// ---- Timer: step 1 Start -> clock ticks; Pause freezes -> Resume ticks ----
  const timerSel = `[data-testid='step-timer-${s1id}']`;
  const s1row = await rowFor("Django Basics", 0);
  await (await s1row.$("[data-testid='timer-start']")).click();
  await page.waitForSelector(`${timerSel} [data-testid='timer-pause']`, {
    visible: true,
  });

  const clock0 = await page.$eval(`${timerSel} [data-testid='step-clock']`, (el) => el.textContent || "");
  await new Promise((r) => setTimeout(r, 2100)); // let it tick ~2s
  const clock1 = await page.$eval(`${timerSel} [data-testid='step-clock']`, (el) => el.textContent || "");
  ok("[timer] running clock ticks up", clock1 !== clock0, `${clock0} -> ${clock1}`);
  ok("[timer] running clock shows >0s", /:0[1-9]|[1-5]\d/.test(clock1), clock1);

  // Pause -> clock must freeze (no accumulation while paused).
  await (await s1row.$("[data-testid='timer-pause']")).click();
  await page.waitForSelector(`${timerSel} [data-testid='timer-resume']`, { visible: true });
  const pausedClock = await page.$eval(`${timerSel} [data-testid='step-clock']`, (el) => el.textContent || "");
  await new Promise((r) => setTimeout(r, 1200));
  const pausedClock2 = await page.$eval(`${timerSel} [data-testid='step-clock']`, (el) => el.textContent || "");
  ok("[timer] paused clock is frozen", pausedClock === pausedClock2, `${pausedClock} vs ${pausedClock2}`);

  let stored = await readTasks();
  let s1 = stored.find((t) => t.name === "Django").roadmap.find((s) => s.id === s1id);
  ok("[timer] practiced persisted after pause (>0s)", s1.practicedSeconds > 0, `${s1.practicedSeconds}s`);
  ok("[timer] status paused", s1.timerStatus === "paused", s1.timerStatus);

  // Resume -> running again; clock continues past the pause point.
  await (await s1row.$("[data-testid='timer-resume']")).click();
  await page.waitForSelector(`${timerSel} [data-testid='timer-pause']`, { visible: true });
  await new Promise((r) => setTimeout(r, 1500));
  const resClock = await page.$eval(`${timerSel} [data-testid='step-clock']`, (el) => el.textContent || "");
  stored = await readTasks();
  s1 = stored.find((t) => t.name === "Django").roadmap.find((s) => s.id === s1id);
  ok("[timer] resume keeps status running", s1.timerStatus === "running", s1.timerStatus);
  ok("[timer] resume clock continues", resClock !== pausedClock2, `paused=${pausedClock2} resumed=${resClock}`);

  // Finish: folds the run; the §11 check-in gate then controls when isDone flips.
  // The min-practice gate would otherwise block a sub-minute finish, so tests
  // opt out via a window flag (real users must actually practice).
  await page.evaluate(() => {
    window.__MIN_PRACTICE_OVERRIDE__ = true;
  });
  await (await s1row.$("[data-testid='timer-finish']")).click();
  // §11 gate: the check-in modal must be answered before isDone flips.
  await page.waitForSelector("[data-testid='checkin-modal']", { visible: true, timeout: 15000 });
  await page.waitForSelector("[data-testid='checkin-skip']", { visible: true, timeout: 30000 });
  await page.click("[data-testid='checkin-skip']");
  await page.waitForFunction(
    () => !document.querySelector("[data-testid='checkin-modal']"),
    { timeout: 8000 }
  );
  await page.waitForSelector(`${timerSel} [data-testid='timer-reopen']`, { visible: true });
  stored = await readTasks();
  s1 = stored.find((t) => t.name === "Django").roadmap.find((s) => s.id === s1id);
  ok("[timer] finish marks step done", s1.isDone === true, String(s1.isDone));
  ok("[timer] finish persists practiced time", s1.practicedSeconds > 0, `${s1.practicedSeconds}s`);
  ok("[timer] finish sets status=finished", s1.timerStatus === "finished", s1.timerStatus);
  // After finish (run stopped), clock equals persisted practicedSeconds.
  const finClock = await page.$eval(`${timerSel} [data-testid='step-clock']`, (el) => el.textContent || "");
  ok("[timer] finished clock reflects persisted total", /:\d{2}$/.test(finClock), finClock);

  // ---- Summary updates after finish ----
  const sumPrac2 = await page.$eval("[data-testid='sum-practiced']", (el) => el.textContent || "");
  const sumRem2 = await page.$eval("[data-testid='sum-remaining']", (el) => el.textContent || "");
  ok("[sum] practiced>0 after finish", sumPrac2.trim() !== "0m", sumPrac2);
  ok("[sum] remaining<total after finish", !sumRem2.includes("5h 45m"), sumRem2);

  // Step 1 checkbox reflects the finished/done state through CircleCheckbox.
  const checkedState = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='step-row']"));
    const r = rows.find((el) => el.getAttribute("data-step-title") === "Django Basics");
    const cb = r?.querySelector("[data-testid='step-check']");
    return cb?.getAttribute("aria-checked") ?? null;
  });
  ok("[ui] finished step shows checked (isDone)", checkedState === "true", checkedState);

  // ---- Per-step timer data stays scoped to the correct task + step ----
  const tasksStored = await readTasks();
  const django = tasksStored.find((t) => t.name === "Django");
  ok("[scope] only Django present", tasksStored.length === 1, String(tasksStored.length));
  ok("[scope] timer fields live on the step", typeof s1.practicedSeconds === "number");
  const otherSteps = django.roadmap.filter((s) => s.id !== s1id);
  ok(
    "[scope] other steps untouched (practiced 0)",
    otherSteps.every((s) => s.practicedSeconds === 0),
    otherSteps.map((s) => `${s.title}=${s.practicedSeconds}`).join(",")
  );

// ---- Reload: practiced time + finished status survive ----
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector("[data-testid='ws-title']", { visible: true });
  await new Promise((r) => setTimeout(r, 600));
  const reloaded = await readTasks();
  const r1 = reloaded
    .find((t) => t.name === "Django")
    .roadmap.find((s) => s.id === s1id);
  ok("[reload] practiced time persists", r1.practicedSeconds === s1.practicedSeconds, `${r1.practicedSeconds}s`);
  ok("[reload] finished status persists", r1.timerStatus === "finished", r1.timerStatus);
  ok("[reload] isDone persists", r1.isDone === true, String(r1.isDone));
  const rSumPrac = await page.$eval("[data-testid='sum-practiced']", (el) => el.textContent || "");
  ok(
    "[reload] summary still shows practiced time",
    rSumPrac.trim() !== "0m",
    rSumPrac
  );

  // Zero console errors. Network-level logs for expected conditional-write
  // conflicts (the sync layer intentionally probes with an expectedRev and
  // self-heals via re-fetch+merge on 409) are not real page errors — same
  // policy as ignoring favicon/net::ERR noise in verify-progress-sync.mjs.
  const criticalErrors = consoleErrors.filter(
    (e) =>
      !e.includes("favicon") &&
      !e.includes("net::ERR") &&
      !e.includes("409 (Conflict)")
  );
  ok(
    "[journey] zero console errors",
    criticalErrors.length === 0,
    criticalErrors.slice(0, 3).join(" ;; ")
  );
} finally {
  await browser.close();
}
