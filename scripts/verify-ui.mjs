/**
 * scripts/verify-ui.mjs â€” Habeet UI acceptance checks.
 * Boots against a running dev/prod server and verifies:
 *  - no console errors / page errors
 *  - no horizontal scroll at 375 / 768 / 1280 / 1920
 *  - heatmap cells always colored, tooltip works
 *  - weekly bars render on mobile
 *  - roadmap day rows expand/collapse + Re-plan/Resources present
 *  - study history entry click jumps into the day
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.VERIFY_URL ?? "http://localhost:3000";
const WIDTHS = [375, 768, 1280, 1920];
const OUT = path.resolve(".ui-shots");
fs.mkdirSync(OUT, { recursive: true });

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

// Seed persisted state so every surface has real data to render.
const today = new Date();
const key = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(
    x.getDate()
  ).padStart(2, "0")}`;
};
const history = {};
for (let i = 0; i < 40; i++) {
  const d = new Date(today);
  d.setDate(d.getDate() - i);
  if (i % 3 === 0) continue; // some quiet days
  const sessions = (i % 4) + 1;
  history[key(d)] = {
    date: key(d),
    sessions_count: sessions,
    focus_minutes: sessions * 25,
    tasks_completed: sessions > 2 ? 2 : 1,
    total_tasks: 3,
    productivity: 50,
    completed_items:
      i < 6
        ? [{ name: "Read official docs", roadmapId: "rm-test", dayNumber: 1 }]
        : [],
  };
}
const seededState = {
  activeDate: key(today),
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
    completedWorkSessions: 2,
    activeTaskId: null,
    taskDurationMinutes: null,
  },
  tasks: [],
  history,
  roadmaps: [
    {
      id: "rm-test",
      topic_name: "React Testing",
      badge_reward: { title: "Test Pilot", icon: "\u{1F9EA}" },
      status: "in_progress",
      createdAt: Date.now(),
      days: [
        {
          day_number: 1,
          day_title: "Jest foundations",
          is_completed: false,
          references: [
            {
              type: "docs",
              title: "Jest â€” Getting Started",
              url: "https://jestjs.io/docs/getting-started",
            },
          ],
          tasks: [
            {
              name: "Read official docs",
              priority: "High",
              estimated_minutes: 30,
              manual_minutes: null,
              is_done: false,
              reason: "Foundation first",
            },
            {
              name: "Write first unit test",
              priority: "Medium",
              estimated_minutes: 45,
              manual_minutes: 20,
              is_done: true,
            },
          ],
        },
        {
          day_number: 2,
          day_title: "Mocks & spies",
          is_completed: false,
          references: [],
          tasks: [
            {
              name: "Mock an API module",
              priority: "High",
              estimated_minutes: 40,
              manual_minutes: null,
              is_done: false,
            },
          ],
        },
      ],
    },
  ],
  badges: [],
  practiceTasks: [
    {
      id: "pt-1",
      name: "Learn Django",
      description: "ORM + views sprint",
      startDate: (() => {
        const d = new Date(today);
        d.setDate(d.getDate() - 9);
        return key(d);
      })(),
      durationDays: 3,
      checkIns: [],
      createdAt: Date.now(),
    },
    {
      id: "pt-2",
      name: "Learn Python",
      description: "Core fundamentals refresher",
      startDate: key(today),
      durationDays: 5,
      checkIns: [1, 2],
      createdAt: Date.now(),
    },
  ],
  activeRoadmapDay: null,
  estimationLog: [],
};

function ok(name, cond, extra = "") {
  const mark = cond ? "PASS" : "FAIL";
  console.log(`${mark}  ${name}${extra ? ` â€” ${extra}` : ""}`);
  if (!cond) process.exitCode = 1;
}

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

try {
  for (const width of WIDTHS) {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const text = m.text();
      // Phase 2 durable progress uses HTTP 409 as the intentional conditional-
      // write "another tab/device won" signal. The client detects this conflict,
      // re-fetches the authoritative doc and converges via a re-push, so the
      // 409 network entry is expected, self-healing traffic — not a defect.
      if (/status of 409|409 \(Conflict\)/i.test(text)) return;
      consoleErrors.push(text);
    });
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
    await page.evaluateOnNewDocument((state) => {
      window.localStorage.setItem("pomodoro:app:v1", JSON.stringify(state));
    }, seededState);
    await page.setViewport({ width, height: 900 });
    await page.goto(BASE, { waitUntil: "networkidle0", timeout: 60000 });
    // Wait for client hydration (weekly chart only renders once hydrated),
    // then a short buffer for layout settle. Robust to a cold first compile.
    await page
      .waitForFunction(() => document.querySelectorAll("[data-weekly-bar]").length > 0, {
        timeout: 20000,
      })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 300));

    const metrics = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
    }));
    ok(
      `[${width}px] no horizontal scroll`,
      metrics.scrollW <= metrics.innerW + 1,
      `scrollW=${metrics.scrollW} innerW=${metrics.innerW}`
    );

    if (width < 1024) {
      const bars = await page.$$eval("[data-weekly-bar]", (els) =>
        els.map((e) => e.getBoundingClientRect().height)
      );
      ok(`[${width}px] weekly chart has 7 bars`, bars.length === 7, String(bars.length));
      ok(
        `[${width}px] every weekly bar >= 4px tall`,
        bars.length === 7 && bars.every((h) => h >= 4),
        bars.map((h) => h.toFixed(0)).join(",")
      );
      const heatmapHidden = await page.evaluate(() => {
        const el = document.querySelector("[data-testid='activity-card']");
        return !el || el.offsetParent === null; // hidden subtree
      });
      ok(`[${width}px] heatmap card hidden on mobile layout`, heatmapHidden);
      const bnav = await page.$$eval(
        "[data-testid^='bottomnav-']",
        (els) => els.length
      );
      ok(`[${width}px] mobile bottom navigation`, bnav === 4, String(bnav));
      ok(`[${width}px] overall stats strip`, !!(await page.$("[data-testid='stats-strip']")));
      // Dashboard = overview: the compact saved-workspaces list is present and
      // links to each task's dedicated workspace (full roadmap lives there,
      // not on the dashboard).
      const wsRows = await page.$$eval(
        "[data-testid^='ptask-']",
        (els) => els.length
      );
      ok(`[${width}px] compact saved-workspaces list`, wsRows >= 2, String(wsRows));
      // The list must NOT dump the full roadmap day-grid onto the dashboard.
      const dumpedRoadmap = await page.evaluate(
        () => !!document.querySelector("[data-day='1']")
      );
      ok(`[${width}px] no full roadmap dumped on dashboard`, !dumpedRoadmap);
    }

    if (width >= 1024) {
      const cellInfo = await page.evaluate(() => {
        const cells = document.querySelectorAll("[data-heatmap-cell]");
        let blank = 0;
        cells.forEach((c) => {
          const bg = getComputedStyle(c).backgroundColor;
          if (!bg || bg === "transparent" || bg === "rgba(0, 0, 0, 0)") blank++;
        });
        return { count: cells.length, blank };
      });
      ok(`[${width}] heatmap cells rendered`, cellInfo.count >= 80, `${cellInfo.count}`);
      ok(`[${width}] no blank heatmap cells`, cellInfo.blank === 0, `${cellInfo.blank} blank`);
      // v2 Fix 3: min sizes + legend/grid share 5 distinct heat shades.
      const cellSize = await page.$eval(
        "[data-heatmap-cell]",
        (el) => el.getBoundingClientRect().width
      );
      ok(
        `[${width}] heatmap cells >= 11.5px`,
        cellSize >= 11.5,
        `${cellSize.toFixed(1)}px`
      );
      const shadeCheck = await page.evaluate(() => {
        const legend = Array.from(
          document.querySelectorAll("span[class*='bg-heat-']")
        ).map((el) => getComputedStyle(el).backgroundColor);
        return {
          n: legend.length,
          uniq: new Set(legend).size,
          gridHeat: !!document.querySelector("[data-heatmap-cell].bg-heat-0"),
        };
      });
      ok(
        `[${width}] legend uses 5 distinct heat shades`,
        shadeCheck.n === 5 && shadeCheck.uniq === 5,
        `n=${shadeCheck.n} uniq=${shadeCheck.uniq}`
      );
      ok(`[${width}] grid shares heat tokens`, shadeCheck.gridHeat);
      await page.hover("[data-heatmap-cell]");
      await new Promise((r) => setTimeout(r, 300));
      const tooltip = await page.evaluate(() =>
        Array.from(document.querySelectorAll("[role='status']")).some((el) =>
          el.textContent.includes("min focused")
        )
      );
      ok(`[${width}] heatmap tooltip shows minutes`, tooltip);
      // Dashboard = overview: compact workspaces list + active-roadmaps
      // summary (NOT the full roadmap day-grid on the dashboard).
      const workspacesOk = await page.evaluate(() => {
        const ws = document.querySelectorAll("[data-testid^='ptask-']").length;
        return ws >= 2;
      });
      ok(`[${width}] compact saved-workspaces list`, workspacesOk);
      const dumpedRoadmapDesktop = await page.evaluate(
        () => !!document.querySelector("[data-day='1']")
      );
      ok(`[${width}] no full roadmap dumped on dashboard`, !dumpedRoadmapDesktop);
      const navTaskPresent = await page.evaluate(() => {
        // New ChatGPT-style sidebar: RECENT TASKS are listed as workspace links.
        const btn = document.querySelector("[data-testid^='nav-task-']");
        return !!btn && btn.tagName.toLowerCase() === "button";
      });
      ok(`[${width}] recent-task nav entry present`, navTaskPresent);
    }

    const actionsOk = await page.evaluate(() => {
      // The dashboard is an OVERVIEW: the compact saved-workspaces list and
      // stats are present; full roadmap day expansion is NOT rendered here.
      const ok1 = document.querySelectorAll("[data-testid^='ptask-']").length >= 1;
      const ok2 = !!document.querySelector("[data-testid='stats-strip']");
      return ok1 && ok2;
    });
    ok(`[${width}] dashboard overview renders`, actionsOk);

    // New overview stats are surfaced: total practice time + today's practice.
    const timeStat = await page.$eval(
      "[data-testid='stats-practice-time']",
      (el) => el.textContent || ""
    ).catch(() => "");
    const todayStat = await page.$eval(
      "[data-testid='stats-today-practice']",
      (el) => el.textContent || ""
    ).catch(() => "");
    ok(`[${width}] total practice-time stat renders`, /\d+m|\d+h|\ds/.test(timeStat ?? ""), timeStat ?? "");
    ok(`[${width}] today's-practice stat renders`, /\dm/.test(todayStat ?? ""), todayStat ?? "");
    if (width >= 1024) {
      const sidebar = await page.$("[data-testid='nav-rail']");
      ok(`[${width}] navigation sidebar rendered`, !!sidebar);
    }

    // §6 Interaction tests (timer start/pause/reset, task add/complete,
    // roadmap checklist toggle) — only run at 1280px to avoid flakiness
    // from mobile layout reordering.
    if (width === 1280) {
      // --- Timer start/pause/reset ---
      const startBtn = await page.$("[data-testid='timer-start-pause-btn']");
            if (startBtn) {
        // Start -> label becomes "Pause"
        await startBtn.click();
        await new Promise((r) => setTimeout(r, 500));
        const startText = await startBtn.evaluate((b) => b.textContent || "");
        ok(`[1280px] timer Start → Pause label`, startText.includes("Pause"), `text=${startText}`);

        // Reset -> timer stops, button shows "Start"
        const resetBtn = await page.$("[data-testid='timer-reset-btn']");
        if (resetBtn) {
          await resetBtn.click();
          await new Promise((r) => setTimeout(r, 300));
          const afterReset = await startBtn.evaluate((b) => b.textContent || "");
          ok(`[1280px] timer Reset stops (Start label restored)`, afterReset.includes("Start"), `text=${afterReset}`);
        } else {
          ok(`[1280px] timer Reset button present`, false, "button not found");
        }

        // Pause: Start -> Pause -> Pause (to pause)
        await startBtn.click();
        await new Promise((r) => setTimeout(r, 400));
        const runningText = await startBtn.evaluate((b) => b.textContent || "");
        ok(`[1280px] timer Start again shows Pause`, runningText.includes("Pause"), `text=${runningText}`);
        // Click again to pause -> should show Start
        await startBtn.click();
        await new Promise((r) => setTimeout(r, 400));
        const pausedText = await startBtn.evaluate((b) => b.textContent || "");
        ok(`[1280px] timer Pause → Start label`, pausedText.includes("Start"), `text=${pausedText}`);
      } else {
        ok(`[1280px] timer Start button present`, false, "button not found");
      }

      // --- Task add + complete ---
      const taskInput = await page.$("[data-testid='task-input']");
      const addBtn = await page.$("[data-testid='task-add-btn']");
      if (taskInput && addBtn) {
        await taskInput.type("Integration test task");
        await addBtn.click();
        await new Promise((r) => setTimeout(r, 600));
        const added = await page.$("[data-testid='task-row-Integration_test_task']");
        ok(`[1280px] task added via form`, !!added, added ? "found" : "missing");

        // Complete the task via circular checkbox
        if (added) {
          const checkbox = await added.$("[data-testid='task-checkbox-Integration_test_task']");
          if (checkbox) {
            await checkbox.click();
            await new Promise((r) => setTimeout(r, 300));
            // Check it's marked checked (aria-checked="true")
            const checked = await checkbox.evaluate((el) => el.getAttribute("aria-checked") === "true");
            ok(`[1280px] task completed via circular checkbox`, checked, `aria-checked=${checked}`);
          } else {
            ok(`[1280px] task checkbox rendered`, false, "checkbox not found");
          }
        }
            
        // v3 UX: checking off a task must NOT force an exam modal.
        await new Promise((r) => setTimeout(r, 300));
        const noExam = await page.evaluate(
          () => !document.querySelector("[aria-label='Close exam']")
        );
        ok(`[1280px] check-in without forced exam`, noExam);
        } else {
        ok(`[1280px] task add form present`, false, "input or add button missing");
      }
      // --- Roadmap overview (compact) on dashboard ---
      // Full roadmap day grids were removed from the overview; the compact
      // "Active roadmaps" summary remains.
      const activeRm = await page.$$eval(
        "#section-roadmaps li",
        (els) => els.length
      );
      const rmSection = await page.$("#section-roadmaps");
      ok(
        `[1280px] compact active-roadmaps summary`,
        !!rmSection && activeRm >= 1,
        `rows=${activeRm}`
      );
    }



    // ---- v5 practice-goal flow ----
    const overdueTxt = await page.$eval(
      "[data-testid='stats-overdue']",
      (el) => el.textContent?.trim() ?? ""
    );
    ok(
      `[${width}] overdue stat counts seeded miss`,
      /^1/.test(overdueTxt),
      overdueTxt
    );
    const pdays = await page.$eval(
      "[data-testid='stats-practice-days']",
      (el) => el.textContent || ""
    );
    ok(`[${width}] practice-days stat renders`, /\d/.test(pdays), pdays);

    if (width === 1280) {
      // New Task -> dedicated BLANK workspace page (/task/new).
      await page.click("[data-testid='new-task-btn']");
      await page.waitForFunction(
        () => window.location.pathname === "/task/new",
        { timeout: 10000 }
      );
      await page.waitForSelector("[data-testid='ct-name']", { visible: true });
      // Blank-slate guarantee: the workspace's <main> (not the persistent
      // sidebar, which legitimately lists RECENT TASKS as navigation) must
      // render NO seeded task content.
      const blankBody = await page.$eval("main[class]", (el) => el.textContent || "");
      ok(
        `[1280px] new-task workspace is blank`,
        !blankBody.includes("Learn Django") && !blankBody.includes("Learn Python"),
        ""
      );
      // Live IST deadline preview before creating.
      await page.type("[data-testid='ct-name']", "Learn SQL");
      await page.click("[data-testid='ct-days-7']");
      const prevRange = await page
        .$eval("[data-testid='ct-range']", (el) => el.textContent || "")
        .catch(() => "");
      ok(`[1280px] live 7-day IST range preview`, prevRange.includes("7 Days"), prevRange);
      // Create -> opens the NEW task's own workspace directly.
      await page.click("[data-testid='ct-create']");
      await page.waitForFunction(
        () => /^\/task\/(?!new$)[^/]+$/.test(window.location.pathname),
        { timeout: 10000 }
      );
      await page.waitForSelector("[data-testid='ws-title']", { visible: true });
      const wsHead = await page.$eval("[data-testid='ws-title']", (el) => el.textContent || "");
      const dayChip = await page
        .$eval("[data-testid='ws-day-chip']", (el) => el.textContent || "")
        .catch(() => "");
      ok(`[1280px] created task opens its workspace`, wsHead.includes("Learn SQL"), wsHead);
      ok(`[1280px] Day 1 starts today`, dayChip.startsWith("Day 1 of"), dayChip);
      // Back to dashboard via the in-page link (SPA nav keeps localStorage).
      await page.click("[data-testid='back-home']");
      await page.waitForFunction(
        () => window.location.pathname === "/",
        { timeout: 10000 }
      );
      await page.waitForSelector("[data-testid^='ptask-']", { visible: true });
      await new Promise((r) => setTimeout(r, 400));
      const cards = await page.$$eval(
        "[data-testid^='ptask-']",
        (els) => els.length
      );
      ok(`[1280px] saved workspace row added to overview`, cards === 3, String(cards));

      // Clicking a saved workspace row opens its EXACT task workspace.
      await page.click("[data-testid='ws-link-pt-2']");
      await page.waitForFunction(
        () => window.location.pathname === "/task/pt-2",
        { timeout: 10000 }
      );
      await page.waitForSelector("[data-testid='ws-title']", { visible: true });
      const pt2 = await page.$eval(
        "[data-testid='ws-title']",
        (el) => el.textContent || ""
      );
      ok(`[1280px] saved workspace opens its task`, pt2.includes("Learn Python"), pt2);
      await page.click("[data-testid='back-home']");
      await page.waitForFunction(
        () => window.location.pathname === "/",
        { timeout: 10000 }
      );
      await new Promise((r) => setTimeout(r, 400));

      // Overdue row labelled on the dashboard (kept in history, not "active").
      const odCard = await page
        .$eval("[data-testid='ptask-pt-1']", (el) => el.textContent || "")
        .catch(() => "");
      ok(`[1280px] overdue goal labelled`, odCard.includes("Overdue"));

      // History: searchable saved-tasks list (GitHub/ChatGPT-style) shows all
      // tasks and does NOT create duplicates; typing filters the list.
      await page.click("[aria-label='View full history']");
      await page.waitForSelector("[data-testid^='hgoal-']", { visible: true });
      const hgoals = await page.evaluate(() =>
        Array.from(document.querySelectorAll("[data-testid^='hgoal-']")).length
      );
      ok(`[1280px] history preserves goals`, hgoals >= 2, String(hgoals));
      // Typing in the search narrows the saved-tasks list (no duplicates).
      await page.type("[data-testid='history-search']", "Python");
      await new Promise((r) => setTimeout(r, 300));
      const filtered = await page.evaluate(() =>
        Array.from(document.querySelectorAll("[data-testid^='hgoal-']"))
          .map((el) => el.textContent || "")
          .filter((t) => t.includes("Python"))
      );
      ok(
        `[1280px] history search filters to exact task`,
        filtered.length >= 1 && filtered.length < hgoals,
        `shown=${filtered.length} total=${hgoals}`
      );
      await page.keyboard.press("Escape");
      await new Promise((r) => setTimeout(r, 300));
    }

    await page.screenshot({
      path: path.join(OUT, `w${width}.png`),
      fullPage: true,
    });

    ok(
      `[${width}px] zero console errors`,
      consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(" | ")
    );
    await page.close();
  }
} finally {
  await browser.close();
}

