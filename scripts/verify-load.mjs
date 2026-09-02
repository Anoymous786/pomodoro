/**
 * scripts/verify-load.mjs
 *
 * Headless proof that the app loads with ZERO console errors:
 *   Case A: fresh browser profile (empty localStorage)
 *   Case B: realistic saved state seeded BEFORE page scripts run — tasks,
 *           roadmap cards, history, non-default timer. This is exactly the
 *           scenario that used to produce a React hydration-mismatch error
 *           on every load (the "stuck 1-error" pill).
 *
 * Also asserts functionality survived the fix: seeded roadmaps must render
 * after mount, and persistence must NOT clobber saved localStorage.
 *
 * Usage:  npm run build && node scripts/verify-load.mjs
 */
import { spawn, execSync } from "node:child_process";
import puppeteer from "puppeteer-core";

const CHROME =
  process.env.CHROME_PATH ??
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = process.env.PORT ?? 3123;
const URL_BASE = `http://localhost:${PORT}`;
const STORAGE_KEY = "pomodoro:app:v1";

function dateKey(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const task = (id, name, priority, mins) => ({
  id, name, priority, estimated_minutes: mins,
  is_completed: false, createdAt: Date.now(), manual_minutes: null,
});

/** Realistic PomodoroAppState blob matching lib/types.ts schema v1. */
const SEED = JSON.stringify({
  activeDate: dateKey(0),
  settings: { workMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, longBreakInterval: 4, dailySessionGoal: 8 },
  // Non-default timer (30 min, 2 sessions done) so pre-fix hydration diverged.
  timer: { mode: "work", isRunning: false, endTimestamp: null, completedWorkSessions: 2, activeTaskId: "t1", taskDurationMinutes: 30 },
  tasks: [task("t1", "Read VPC docs", "high", 40), task("t2", "Build demo network", "medium", 90)],
  history: {
    [dateKey(-1)]: {
      date: dateKey(-1), sessions_count: 3, focus_minutes: 75, tasks_completed: 2, total_tasks: 4, productivity: 63,
      // §5 Clickable resume log entry.
      completed_items: [{ name: "Read VPC docs", roadmapId: "r1", dayNumber: 1 }]
    },
    [dateKey(-2)]: { date: dateKey(-2), sessions_count: 2, focus_minutes: 50, tasks_completed: 1, total_tasks: 3, productivity: 47 },
    [dateKey(-3)]: { date: dateKey(-3), sessions_count: 4, focus_minutes: 100, tasks_completed: 3, total_tasks: 5, productivity: 78 },
  },
  roadmaps: [
    {
      id: "r1", topic_name: "AWS Networking",
      badge_reward: { title: "Network Ninja", icon: "🌐" },
      status: "in_progress", createdAt: Date.now(),
      days: [
        {
          day_number: 1, day_title: "VPC fundamentals", is_completed: false,
          // §3 Curated references for this day only.
          references: [
            { type: "docs", title: "Amazon VPC official docs", url: "https://docs.aws.amazon.com/vpc/" },
            { type: "video", title: "VPC Explained", url: "https://www.youtube.com/watch?v=exampleABC", channel: "Example Channel" },
            { type: "article", title: "A practical VPC walkthrough", url: "https://example.com/vpc-walkthrough" },
          ],
          tasks: [{
            name: "Read VPC docs", priority: "High", estimated_minutes: 40, manual_minutes: 42, is_done: true,
            reason: "Foundation for everything else on this day"
          }]
        },
        {
          day_number: 2, day_title: "Subnets & routing", is_completed: false,
          tasks: [{ name: "Design a two-tier VPC", priority: "Medium", estimated_minutes: 60, manual_minutes: null }]
        },
      ],
    },
  ],
  badges: [],
  // §4/§5 Real focus samples feed per-topic totals + re-plan context.
  estimationLog: [
    {
      taskId: "t1", taskName: "Read VPC docs", estimated_minutes: 40, actual_minutes: 42,
      ratio: 1.05, completedAt: Date.now(), focus_percent: 96,
      roadmapId: "r1", dayNumber: 1
    },
  ],
  activeRoadmapDay: null,
  // Task+Roadmap architecture: one task-owned workspace whose steps carry
  // PER-STEP study sources (requirement §1) plus hour-based estimates (§2).
  practiceTasks: [
    {
      id: "ws-orm",
      name: "Object Relational Model",
      description: "Master Django ORM from models to migrations",
      startDate: dateKey(0),
      durationDays: 3,
      checkIns: [],
      createdAt: Date.now(),
      roadmap: [
        {
          id: "s1",
          title: "Django ORM basics",
          note: "Models · QuerySets · Managers",
          dayNumber: 1,
          isDone: true,
          estimated_minutes: 120,
          practicedSeconds: 5400,
          elapsedSeconds: 0,
          timerStatus: "finished",
          sources: [
            { type: "docs", title: "Official Django ORM docs", url: "https://docs.djangoproject.com/en/stable/topics/db/models/" },
            { type: "article", title: "A Django ORM walkthrough", url: "https://example.com/django-orm-tutorial" },
            { type: "video", title: "Django ORM explained", url: "https://www.youtube.com/watch?v=ormExampleABC", channel: "Example Channel" },
          ],
        },
        {
          id: "s2",
          title: "Migrations & relations",
          dayNumber: 2,
          isDone: false,
          estimated_minutes: 90,
          practicedSeconds: 600,
          elapsedSeconds: 0,
          timerStatus: "idle",
          sources: [
            { type: "docs", title: "Django migrations topic", url: "https://docs.djangoproject.com/en/stable/topics/migrations/" },
          ],
        },
      ],
    },
  ],
});

async function waitForServer(url, timeoutMs = 45_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server at ${url} did not become ready.`);
}

async function collectCase(browser, label, { seed, mobile = false }) {
  const context = browser.createBrowserContext
    ? await browser.createBrowserContext()
    : await browser.createIncognitoBrowserContext();
  const page = await context.newPage();
  await page.setViewport(
    mobile
      ? { width: 390, height: 844, deviceScaleFactor: 2 }
      : { width: 1280, height: 800 }
  );

  const errors = [];
  const badResponses = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (res) => {
    if (res.status() >= 400) {
      badResponses.push(`${res.status()} ${res.url()}`);
      errors.push(`Failed to load resource: ${res.status()} ${res.url()}`);
    }
  });

  if (seed) {
    await page.evaluateOnNewDocument((blob) => {
      // NOTE: runs in PAGE context — no module scope available here.
      window.localStorage.setItem("pomodoro:app:v1", blob);
    }, SEED);
  }

  await page.goto(`${URL_BASE}/`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 1500)); // let hydration settle

  let renderedSavedData = false;
  let streakRendered = false;
  let heatmapRendered = false;
  // §1–§5 feature flags (seeded case only).
  let heatmapCells = 0;
  let istDateRendered = false;
  let wsSourcesPresent = false;
  let wsSummaryPresent = false;
  let topicsRendered = false;
  let jumpWorks = false;
  try {
    await page.waitForFunction(
      () => document.body.innerText.includes("AWS Networking"),
      { timeout: 4_000 }
    );
    renderedSavedData = true;
    // Phase 1: the streak tile + heatmap must actually render with saved
    // data. (The redesigned UI shows the streak as the "Day streak" stat
    // tile + header pill rather than a legacy "Current streak" card.)
    streakRendered = await page.evaluate(() =>
      document.body.innerText.includes("Day streak")
    );
    heatmapRendered = await page.evaluate(() =>
      document.body.innerText.includes("Activity")
    );

    if (seed) {
      // §12 IST-consistent date label in the greeting.
      istDateRendered = await page.evaluate(() =>
        document.body.innerText.includes("· IST")
      );
      // §2.1 Heatmap grid is populated (84 cells over 12 weeks).
      heatmapCells = await page.evaluate(
        () => document.querySelectorAll("[data-heatmap-cell]").length
      );
      // §5 Resume flow: open History (aria-label survived the redesign,
      // sidebar History nav also dispatches habeet:open-history) → topic
      // summary → click logged chip.
      await page.evaluate(() => {
        const btn = document.querySelector('button[aria-label="View full history"]');
        if (btn) btn.click();
      });
      await page.waitForFunction(
        () => document.body.innerText.includes("Progress by topic"),
        { timeout: 4_000 }
      );
      topicsRendered = true;
      await page.waitForFunction(() => {
        const chip = [...document.querySelectorAll("button")].find(
          (b) =>
            b.textContent.trim().startsWith("Read VPC docs") &&
            b.querySelector("svg") // jumpable chips carry the ArrowUpRight icon
        );
        return Boolean(chip);
      }, { timeout: 4_000 });
      await page.evaluate(() => {
        const chip = [...document.querySelectorAll("button")].find(
          (b) =>
            b.textContent.trim().startsWith("Read VPC docs") &&
            b.querySelector("svg")
        );
        chip?.click();
      });
      await page.waitForFunction(
        () => !document.querySelector('[role="dialog"]'),
        { timeout: 4_000 }
      );
      jumpWorks = await page.evaluate(
        () => document.querySelectorAll('[data-task-name]').length > 0
      );

      // §1/§2/§6/§11: the task WORKSPACE renders per-step study sources
      // (clickable, matching that step's topic), the time summary strip
      // (estimated/practiced/remaining), and the days/deadline chip.
      await page.goto(`${URL_BASE}/task/ws-orm`, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="ws-title"]', { timeout: 5_000 });
      const srcLinks = await page.evaluate(
        () => document.querySelectorAll('[data-testid^="step-sources-"] a[target="_blank"]').length
      );
      wsSourcesPresent =
        srcLinks >= 3 &&
        (await page.evaluate(() =>
          [...document.querySelectorAll('[data-testid^="step-sources-"]')]
            .some((box) => box.textContent.includes("Django ORM"))
        ));
      wsSummaryPresent = await page.evaluate(
        () =>
          !!document.querySelector('[data-testid="sum-estimated"]') &&
          !!document.querySelector('[data-testid="sum-practiced"]') &&
          !!document.querySelector('[data-testid="sum-remaining"]') &&
          !!document.querySelector('[data-testid="ws-deadline"]')
      );
      await page.goto(`${URL_BASE}/`, { waitUntil: "networkidle0" });
    }
  } catch { /* absence only matters in the seeded case */ }

  // §6 Responsive guard: no horizontal overflow at this viewport.
  const noHScroll = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 2
  );

  const storedRaw = await page.evaluate(
    (k) => window.localStorage.getItem(k),
    STORAGE_KEY
  );
  const persistedIntact =
    !seed || Boolean(storedRaw?.includes("AWS Networking"));

  await context.close();
  return {
    label, errors, renderedSavedData, persistedIntact,
    streakRendered, heatmapRendered,
    heatmapCells, istDateRendered, wsSourcesPresent, wsSummaryPresent,
    topicsRendered, jumpWorks, noHScroll,
  };
}

async function main() {
  console.log("Starting production server (next start)...");
  const server = spawn(
    "cmd",
    ["/c", "npx", "next", "start", "-p", String(PORT)],
    { stdio: "ignore", windowsHide: true }
  );

  try {
    await waitForServer(URL_BASE);
    const browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ["--no-sandbox"],
    });

    const results = [
      await collectCase(browser, "A: fresh profile", { seed: false }),
      await collectCase(browser, "B: seeded saved state", { seed: true }),
      await collectCase(browser, "C: seeded @390px mobile", { seed: true, mobile: true }),
    ];
    await browser.close();

    let failed = false;
    for (const r of results) {
      const seeded = r.label.startsWith("B");
      const isMobile = r.label.startsWith("C");
      const clean = r.errors.length === 0;
      console.log(`\n=== ${r.label} ===`);
      console.log(`console/page errors : ${r.errors.length} ${clean ? "(CLEAN)" : "(FAIL)"}`);
      console.log(`no horizontal scroll: ${r.noHScroll}`);
      if (seeded || isMobile) {
        console.log(`saved data rendered : ${r.renderedSavedData}`);
        console.log(`streak rendered     : ${r.streakRendered}`);
        console.log(`heatmap rendered    : ${r.heatmapRendered} (${r.heatmapCells} cells)`);
        console.log(`localStorage intact : ${r.persistedIntact}`);
      }
      if (seeded) {
        console.log(`IST date label       : ${r.istDateRendered}`);
        console.log(`ws per-step sources  : ${r.wsSourcesPresent}`);
        console.log(`ws time summary      : ${r.wsSummaryPresent}`);
        console.log(`topic summaries      : ${r.topicsRendered}`);
        console.log(`history jump-back    : ${r.jumpWorks}`);
        if (
          !(r.renderedSavedData && r.persistedIntact) ||
          !r.streakRendered ||
          !r.heatmapRendered ||
          r.heatmapCells < 80 ||
          !r.istDateRendered ||
          !r.wsSourcesPresent ||
          !r.wsSummaryPresent ||
          !r.topicsRendered ||
          !r.jumpWorks
        ) {
          failed = true;
        }
      }
      if (!r.noHScroll) failed = true;
      if (!clean) {
        failed = true;
        r.errors.slice(0, 10).forEach((e) => console.log(`  ! ${e.slice(0, 300)}`));
      }
    }

    console.log(
      failed
        ? "\nRESULT: FAIL"
        : "\nRESULT: PASS — zero console errors; heatmap populated; features verified; responsive; storage preserved"
    );
    process.exitCode = failed ? 1 : 0;
  } finally {
    try {
      execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" });
    } catch { /* already gone */ }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});