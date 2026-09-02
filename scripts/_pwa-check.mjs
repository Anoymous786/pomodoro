/** One-off Phase 5-7 validation: architecture page, manifest, SW, offline shell. */
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const CHROME =
  process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 3124;
const BASE = `http://localhost:${PORT}`;

function waitForServer(url, timeoutMs = 45_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (async function poll() {
      while (Date.now() - start < timeoutMs) {
        try {
          const res = await fetch(url);
          if (res.ok) return resolve();
        } catch { }
        await new Promise((r) => setTimeout(r, 500));
      }
      reject(new Error("server not ready"));
    })();
  });
}

const server = spawn("cmd", ["/c", "npx next start -p " + PORT], {
  cwd: process.cwd(),
  stdio: "ignore",
});

try {
  await waitForServer(BASE);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox"],
  });

  const results = [];
  const check = (name, ok, extra = "") =>
    results.push(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);

  // --- Page checks in a normal context ---
  let errors = [];
  const page = await browser.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));

  // 1. Architecture page renders + SVG present.
  await page.goto(`${BASE}/architecture`, { waitUntil: "networkidle0" });
  const svgNodes = await page.$$eval("svg rect", (els) => els.length);
  const archH1 = await page.$eval("h1", (el) => el.textContent.trim());
  check("architecture page", archH1 === "Architecture" && svgNodes >= 8 && errors.length === 0,
    `${svgNodes} svg rects, ${errors.length} console errors`);
  check("cost note static", (await page.content()).includes("$0/month by design"));

  // 2. Manifest served and linked.
  const manifestRes = await fetch(`${BASE}/manifest.webmanifest`);
  const manifestJson = await manifestRes.json().catch(() => null);
  check("manifest route", manifestRes.ok && !!manifestJson?.name && Array.isArray(manifestJson?.icons),
    manifestJson?.short_name ?? "");

  // 3. Service worker registers in production build.
  errors = [];
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
  const swState = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return "unsupported";
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((r) => setTimeout(() => r(null), 8000)),
    ]);
    return reg ? reg.active?.state ?? "activating" : "timeout";
  });
  check("service worker registered", swState === "activated", `state=${swState}, ${errors.length} console errors`);

  // 5. Offline reload still renders the shell from cache.
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => { });
  const offlineOk = await page.evaluate(() => document.body.innerText.length > 100);
  check("offline shell loads", offlineOk);
  await page.setOfflineMode(false);

  // 6. Insights panel inside the History modal (seeded profile).
  errors = [];
  const ctx = await browser.createBrowserContext();
  const p2 = await ctx.newPage();
  p2.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  p2.on("pageerror", (e) => errors.push(String(e)));
  const dayKey = (off) => {
    const d = new Date(Date.now() + off * 86400000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  // Seed BEFORE scripts run: two past days + one completed roadmap baseline.
  await p2.evaluateOnNewDocument(
    (k1, k2) => {
      localStorage.setItem(
        "pomodoro:app:v1",
        JSON.stringify({
          activeDate: k1,
          settings: { workMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, longBreakInterval: 4, dailySessionGoal: 8 },
          timer: { mode: "work", isRunning: false, endTimestamp: null, completedWorkSessions: 0, activeTaskId: null, taskDurationMinutes: null },
          tasks: [],
          history: {
            [k1]: { date: k1, sessions_count: 2, focus_minutes: 50, tasks_completed: 3, total_tasks: 4, productivity: 75 },
            [k2]: { date: k2, sessions_count: 1, focus_minutes: 25, tasks_completed: 1, total_tasks: 2, productivity: 50 },
          },
          roadmaps: [
            {
              id: "r-old", topic_name: "Old Topic", badge_reward: { title: "Done", icon: "🏆" }, status: "completed",
              createdAt: Date.now() - 14 * 86400000,
              days: [
                { day_number: 1, day_title: "A", is_completed: true, tasks: [{ name: "a1", priority: "High", estimated_minutes: 30, manual_minutes: null }] },
                { day_number: 2, day_title: "B", is_completed: true, tasks: [{ name: "b1", priority: "Low", estimated_minutes: 20, manual_minutes: null }] },
              ]
            },
            {
              id: "r-cur", topic_name: "Current Topic", badge_reward: { title: "Wip", icon: "🚧" }, status: "in_progress",
              createdAt: Date.now() - 7 * 86400000,
              days: [
                { day_number: 1, day_title: "C", is_completed: true, tasks: [{ name: "c1", priority: "High", estimated_minutes: 30, manual_minutes: null }] },
                { day_number: 2, day_title: "D", is_completed: true, tasks: [{ name: "d1", priority: "Medium", estimated_minutes: 45, manual_minutes: null }] },
                { day_number: 3, day_title: "E", is_completed: false, tasks: [{ name: "e1", priority: "Low", estimated_minutes: 25, manual_minutes: null }] },
              ]
            },
          ],
          badges: [], activeRoadmapDay: null, estimationLog: [],
        })
      );
    },
    dayKey(-1),
    dayKey(-8)
  );
  await p2.goto(BASE + "/", { waitUntil: "networkidle0" });
  await p2.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("View History")),
    { timeout: 8000 }
  );
  await p2.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent.includes("View History"))
      ?.click();
  });
  const appeared = await p2
    .waitForFunction(
      () => document.querySelector('[role="dialog"]') !== null,
      { timeout: 5000 }
    )
    .then(() => true)
    .catch(() => false);
  await new Promise((r) => setTimeout(r, 400));
  const insightText = appeared
    ? await p2.evaluate(() => document.body.innerText)
    : "";
  const t = insightText.toLowerCase();
  const hasInsights =
    t.includes("best focus day") &&
    t.includes("weekly focus trend") &&
    t.includes("roadmap pace");
  check("insights panel", hasInsights && errors.length === 0,
    `${errors.length} console errors${appeared ? "" : " — dialog never opened"}`);

  console.log(results.join("\n"));
  await browser.close();
} finally {
  server.kill();
}
process.exit(0);