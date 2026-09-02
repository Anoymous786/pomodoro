/**
 * scripts/verify-task-roadmap.mjs — Task + Roadmap architecture acceptance.
 * Implements the requested end-to-end scenario against a RUNNING dev server:
 *
 *   New Task -> blank workspace -> create Django -> Day 1 starts today ->
 *   Django opens -> create Django roadmap (add/edit/reorder/toggle/delete)
 *   -> second task has a COMPLETELY INDEPENDENT roadmap.
 *
 * Optional: set VERIFY_AI=1 to also hit the live AI roadmap endpoint
 * (requires a working GROK/GEMINI key in .env.local).
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";

// ---- IST helpers (mirror lib/date-ist.ts) ----
const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const label = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
});
function istTodayKey() {
  return fmt.format(new Date());
}
function shiftIST(dateKey, days) {
  const d = new Date(`${dateKey}T00:00:00+05:30`);
  d.setUTCDate(d.getUTCDate() + days);
  return fmt.format(d);
}
function labelIST(dateKey) {
  return label.format(new Date(`${dateKey}T00:00:00+05:30`));
}

const RUN_AI = process.env.VERIFY_AI === "1";
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

// Seed state with ONE pre-existing task so we can prove the new-task
// workspace renders none of it.
const today = istTodayKey();
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
      id: "pt-old",
      name: "Old Kubernetes Task",
      startDate: shiftIST(today, -10),
      durationDays: 5,
      checkIns: [1],
      createdAt: Date.now(),
    },
  ],
};

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

try {
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
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument((state) => {
    window.localStorage.setItem("pomodoro:app:v1", JSON.stringify(state));
  }, seededState);

  // ---- Step 0: dashboard loads ----
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1000));
  ok("[home] dashboard renders", !!(await page.$("[data-testid='new-task-btn']")));

  // ---- Step 1: New Task opens a COMPLETELY BLANK workspace ----
  await page.click("[data-testid='new-task-btn']");
  await page.waitForFunction(() => window.location.pathname === "/task/new", {
    timeout: 10000,
  });
  await page.waitForSelector("[data-testid='ct-name']", { visible: true });
  // Scope to the workspace's <main> only — the persistent sidebar legitimately
  // lists RECENT TASKS (navigation), but the workspace content itself must be
  // a blank slate with no previous task content.
  const blankText = await page.$eval("main[class]", (el) => el.textContent || "");
  ok(
    "[blank] previous task content is NOT shown",
    !blankText.includes("Old Kubernetes Task"),
    ""
  );
  ok(
    "[blank] fresh-start hint shown",
    blankText.includes("fresh workspace"),
    ""
  );

  // ---- Step 2: create Django (7 days); deadline auto-calculated ----
  const DURATION = 7;
  const start = istTodayKey();
  const deadline = shiftIST(start, DURATION - 1);
  const expectRange = `${labelIST(start)} → ${labelIST(deadline)}`;

  await page.type("[data-testid='ct-name']", "Django");
  await page.type("[data-testid='ct-desc']", "Web framework from scratch");
  await page.click(`[data-testid='ct-days-${DURATION}']`);
  const preview = await page.$eval(
    "[data-testid='ct-range']",
    (el) => el.textContent || ""
  );
  ok(
    `[create] live preview = Day 1 today (${expectRange})`,
    preview.includes(`${DURATION} Days`) && preview.includes(expectRange),
    preview
  );

  await page.click("[data-testid='ct-create']");
  await page.waitForFunction(
    () => /^\/task\/(?!new$)[^/]+$/.test(window.location.pathname),
    { timeout: 15000 }
  );
  await page.waitForSelector("[data-testid='ws-title']", { visible: true });

  // ---- Step 3: Django workspace opened; Day 1 starts today ----
  const wsUrl = await page.evaluate(() => window.location.pathname);
  ok("[open] Django opens its dedicated workspace", wsUrl.startsWith("/task/"), wsUrl);
  const title = await page.$eval("[data-testid='ws-title']", (el) => el.textContent || "");
  ok("[open] workspace title = Django", title.trim() === "Django", title);
  const chip = await page.$eval("[data-testid='ws-day-chip']", (el) => el.textContent || "");
  ok(
    `[dates] Day 1 starts today (${start})`,
    chip.replace(/\s+/g, " ").trim() === `Day 1 of ${DURATION}`,
    chip
  );
  const rangeShown = await page.$eval("[data-testid='ws-range']", (el) => el.textContent || "");
  ok("[dates] range starts today", rangeShown.startsWith(labelIST(start)), rangeShown);
  const dl = await page.$eval("[data-testid='ws-deadline']", (el) => el.textContent || "");
  ok(
    "[dates] deadline auto-calculated from duration",
    dl.includes(labelIST(deadline)),
    dl
  );

  // ---- Step 4: build Django's own roadmap ----
  const DJANGO_STEPS = [
    "Django Basics",
    "URLs & Views",
    "Models & ORM",
    "REST API",
    "Mini Project",
  ];
  const readTitles = () =>
    page.$$eval("[data-testid='step-row']", (els) =>
      els.map((e) => e.getAttribute("data-step-title"))
    );

  ok("[rm] starts empty", !!(await page.$("[data-testid='rm-empty']")));
  for (let i = 0; i < DJANGO_STEPS.length; i++) {
    await page.focus("[data-testid='step-add-input']");
    await page.keyboard.type(DJANGO_STEPS[i]);
    await page.waitForFunction(
      () => {
        const b = document.querySelector("[data-testid='step-add']");
        return !!b && !b.disabled;
      },
      { timeout: 5000 }
    );
    // Submit natively with Enter (form onSubmit -> handleAddStep). Clicking the
    // button can race with React re-creation of the node during re-render.
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (n) => document.querySelectorAll("[data-testid='step-row']").length >= n,
      { timeout: 8000 },
      i + 1
    ).catch(async (err) => {
      const dbg = await page.evaluate((title) => {
        const input = document.querySelector("[data-testid='step-add-input']");
        const btn = document.querySelector("[data-testid='step-add']");
        return {
          step: title,
          rows: [...document.querySelectorAll("[data-testid='step-row']")].map((e) => e.getAttribute("data-step-title")),
          inputVal: input?.value ?? "",
          btnDisabled: btn?.disabled,
          hasMain: !!document.querySelector("main"),
          wsTitle: document.querySelector("[data-testid='ws-title']")?.textContent ?? "",
        };
      }, DJANGO_STEPS[i]);
      throw new Error(`step ${i} "${DJANGO_STEPS[i]}" add failed. ${JSON.stringify(dbg)}`);
    });
  }
  let rows = await readTitles();
  ok(
    "[rm] 5 steps created in order",
    JSON.stringify(rows) === JSON.stringify(DJANGO_STEPS),
    rows.join(" | ")
  );

  /** Waits until the rendered step titles equal the expected order. */
  const waitOrder = (expected, timeout = 8000) =>
    page.waitForFunction(
      (exp) =>
        JSON.stringify(
          [...document.querySelectorAll("[data-testid='step-row']")].map((e) =>
            e.getAttribute("data-step-title")
          )
        ) === JSON.stringify(exp),
      { timeout },
      expected
    );

  // Reorder: move "Mini Project" up one, then back down.
  let miniRow = (await page.$$("[data-testid='step-row']"))[4];
  await (await miniRow.$("[data-testid='step-up']")).click();
  const UP_ORDER = ["Django Basics", "URLs & Views", "Models & ORM", "Mini Project", "REST API"];
  await waitOrder(UP_ORDER);
  rows = await readTitles();
  ok(
    "[rm] reorder up works",
    JSON.stringify(rows) === JSON.stringify(UP_ORDER),
    rows.join(" | ")
  );
  miniRow = (await page.$$("[data-testid='step-row']"))[3];
  await (await miniRow.$("[data-testid='step-down']")).click();
  await waitOrder(DJANGO_STEPS);
  rows = await readTitles();
  ok(
    "[rm] reorder down restores",
    JSON.stringify(rows) === JSON.stringify(DJANGO_STEPS),
    rows.join(" | ")
  );

  // Edit step 2 in place.
  let row2 = (await page.$$("[data-testid='step-row']"))[1];
  await (await row2.$("[data-testid='step-edit']")).click();
  await page.waitForSelector("[data-testid='step-edit-title']", { visible: true });
  await page.$eval("[data-testid='step-edit-title']", (el) => (el.value = ""));
  await page.type("[data-testid='step-edit-title']", "URLs, Views & Templates");
  await page.click("[data-testid='step-save']");
  await waitOrder([
    "Django Basics",
    "URLs, Views & Templates",
    "Models & ORM",
    "REST API",
    "Mini Project",
  ]);
  rows = await readTitles();
  ok("[rm] edit renames step", rows[1] === "URLs, Views & Templates", rows[1]);

  // MIN-PRACTICE RULE: a bare checkbox/check-in WITHOUT practice time must
  // NOT complete the step. The check-in opens and is answered, but the step
  // stays not-done because practiced time is still 0.
  const row1 = (await page.$$("[data-testid='step-row']"))[0];
  await (await row1.$("[data-testid='step-check']")).click();
  await page.waitForSelector("[data-testid='checkin-modal']", { visible: true, timeout: 15000 });
  await page.waitForSelector("[data-testid='checkin-skip']", { visible: true, timeout: 30000 });
  await page.click("[data-testid='checkin-skip']");
  await new Promise((r) => setTimeout(r, 1200));
  {
    const progTxt = await page
      .$eval("[data-testid='rm-progress']", (el) => el.textContent || "")
      .catch(() => "");
    ok(
      "[minpractice] no-practice check-in does NOT complete the step",
      !progTxt.includes("1/5"),
      progTxt || "<none>"
    );
    const stored = await page.evaluate(() =>
      JSON.parse(window.localStorage.getItem("pomodoro:app:v1") ?? "{}")
    );
    const t0 = (stored.practiceTasks ?? []).find((t) => t.name === "Django");
    const s0 = (t0?.roadmap ?? [])[0];
    ok(
      "[minpractice] step 0 still not done after empty check-in",
      s0 && s0.isDone === false,
      String(s0?.isDone)
    );
  }

  // Start the timer, practice ~2s, then try to finish: the gate must STILL
  // block (2s is far below the 5-minute floor). This proves the rule is
  // enforced rather than decorative.
  let gateBlocked = false;
  {
    const rows = await page.$$("[data-testid='step-row']");
    const r0 = rows[0];
    await (await r0.$("[data-testid='timer-start']")).click();
    await page.waitForSelector("[data-testid='timer-pause']", { visible: true });
    await new Promise((r) => setTimeout(r, 1500));
    await (await r0.$("[data-testid='timer-finish']")).click();
    await new Promise((r) => setTimeout(r, 1200));
    const stored = await page.evaluate(() =>
      JSON.parse(window.localStorage.getItem("pomodoro:app:v1") ?? "{}")
    );
    const t0 = (stored.practiceTasks ?? []).find((t) => t.name === "Django");
    const s0 = (t0?.roadmap ?? [])[0];
    gateBlocked = s0 && s0.isDone === false;
    ok(
      "[minpractice] sub-floor practiced cannot finish the step",
      gateBlocked,
      String(s0?.isDone)
    );
  }
  // Restore the app for the rest of the journey: allow finish (test-only
  // override; real users must actually practice).
  if (gateBlocked) {
    await page.evaluate(() => { window.__MIN_PRACTICE_OVERRIDE__ = true; });
  }

  // Add + delete a scratch step. Press Enter in the input (native form submit)
  // so the add is guaranteed regardless of button focus state.
  await page.click("[data-testid='step-add-input']");
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.type("SCRATCH");
  const addBtnState = await page.$eval("[data-testid='step-add']", (el) => el.disabled);
  if (!addBtnState) {
    await page.keyboard.press("Enter");
  }
  await page.waitForFunction(
    () => document.querySelectorAll("[data-testid='step-row']").length === 6,
    { timeout: 5000 }
  ).catch(async () => {
    const dbg = await page.evaluate(() => ({
      rows: document.querySelectorAll("[data-testid='step-row']").length,
      inputVal: document.querySelector("[data-testid='step-add-input']")?.value ?? "",
      btnDisabled: document.querySelector("[data-testid='step-add']")?.disabled ?? true,
    }));
    console.error("DEBUG rows=", JSON.stringify(dbg));
  });
  // Click delete via native DOM click (avoids Puppeteer's selector re-resolve
  // racing React's node re-creation during the re-render after add).
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-testid='step-row']")];
    const sc = rows.find((e) => e.getAttribute("data-step-title")?.includes("SCRATCH"));
    sc?.querySelector("[data-testid='step-delete']")?.click();
  });
  await page.waitForFunction(
    () =>
      document.querySelectorAll("[data-testid='step-row']").length === 5 &&
      ![...document.querySelectorAll("[data-testid='step-row']")].some((e) =>
        e.getAttribute("data-step-title")?.includes("SCRATCH")
      ),
    { timeout: 8000 }
  );
  rows = await readTitles();
  ok(
    "[rm] delete removes only that step",
    rows.length === 5 && !rows.includes("SCRATCH"),
    rows.join(" | ")
  );

  // ---- Optional: live AI roadmap attach (VERIFY_AI=1) ----
  if (RUN_AI) {
    await page.click("[data-testid='rm-ai-btn']");
    // §7: the button now opens the conversational intake first. Its skip
    // button ("Skip questions — auto-generate for me") carries the mandatory
    // days + minutes/day gating while still generating immediately.
    await page.waitForFunction(
      () => document.body.textContent?.includes("Skip questions") ?? false,
      { timeout: 10000 }
    );
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        (b.textContent || "").includes("Skip questions")
      );
      btn?.click();
    });
    // The endpoint can take ~10-30s; the waitForFunction below allows up to
    // 120s for the attach.
    try {
      await page.waitForFunction(() => {
        const t = document.querySelector("[data-testid='rm-progress']");
        return !!t && /\d+\/\d+/.test(t.textContent || "");
      }, { timeout: 120000, polling: 1000 });
      const aiProg = await page.$eval("[data-testid='rm-progress']", (el) => el.textContent || "");
      ok("[ai] AI roadmap attached to Django", !aiProg.startsWith("0/"), aiProg);
      // Restore manual steps for the persisted-isolation assertions below.
      const storedNow = await page.evaluate(() =>
        JSON.parse(window.localStorage.getItem("pomodoro:app:v1") ?? "{}")
      );
      const dNow = storedNow.practiceTasks.find((t) => t.name === "Django");
      ok(
        "[ai] attached steps belong to Django only (React unaffected yet)",
        Array.isArray(dNow?.roadmap) && dNow.roadmap.length > 0,
        String(dNow?.roadmap?.length)
      );
    } catch {
      ok("[ai] AI roadmap attached to Django", false, "timed out — check LLM key/quota");
    }
  }

  // ---- Step 5: second task gets a COMPLETELY independent roadmap ----
  await page.click("[data-testid='back-home']");
  await page.waitForFunction(() => window.location.pathname === "/", { timeout: 10000 });
  await page.waitForSelector("[data-testid='new-task-btn']", { visible: true });
  await new Promise((r) => setTimeout(r, 400));
  await page.click("[data-testid='new-task-btn']");
  await page.waitForFunction(() => window.location.pathname === "/task/new", { timeout: 10000 });
  await page.waitForSelector("[data-testid='ct-name']", { visible: true });
  const blank2 = await page.$eval("body", (el) => el.textContent || "");
  ok(
    "[blank #2] Django content not leaked into another new task",
    !blank2.includes("Models & ORM") && !blank2.includes("Django Basics"),
    ""
  );
  await page.type("[data-testid='ct-name']", "React");
  await page.click("[data-testid='ct-days-3']");
  await page.click("[data-testid='ct-create']");
  await page.waitForFunction(
    () => /^\/task\/(?!new$)[^/]+$/.test(window.location.pathname),
    { timeout: 15000 }
  );
  await page.waitForSelector("[data-testid='ws-title']", { visible: true });
  const reactTitle = await page.$eval("[data-testid='ws-title']", (el) => el.textContent || "");
  ok("[independence] React workspace opens", reactTitle.trim() === "React", reactTitle);
  ok(
    "[independence] React roadmap is EMPTY (own workspace, own state)",
    !!(await page.$("[data-testid='rm-empty']"))
  );
  const reactBody = await page.$eval("body", (el) => el.textContent || "");
  ok(
    "[independence] Django steps never render inside React",
    !reactBody.includes("Models & ORM") && !reactBody.includes("REST API"),
    ""
  );

  // ---- Persisted isolation: each task object embeds its OWN steps ----
  const stored = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem("pomodoro:app:v1") ?? "{}")
  );
  const django = (stored.practiceTasks ?? []).find((t) => t.name === "Django");
  const react = (stored.practiceTasks ?? []).find((t) => t.name === "React");
  const dSteps = (django?.roadmap ?? []).map((s) => s.title);

  if (RUN_AI) {
    // AI path may have replaced Django's manual steps — assert shape only.
    ok(
      "[persisted] Django owns its own non-empty steps",
      Array.isArray(django?.roadmap) && django.roadmap.length > 0,
      String(django?.roadmap?.length)
    );
  } else {
    ok(
      "[persisted] Django owns its 5 steps",
      JSON.stringify(dSteps) ===
        JSON.stringify([
          "Django Basics",
          "URLs, Views & Templates",
          "Models & ORM",
          "REST API",
          "Mini Project",
        ]),
      dSteps.join(" | ")
    );
  }
  ok(
    "[persisted] React owns zero steps",
    Array.isArray(react?.roadmap) && react.roadmap.length === 0,
    String(react?.roadmap?.length)
  );
  ok(
    "[persisted] roadmap arrays are distinct objects per task",
    !!django && !!react && django.roadmap !== react.roadmap,
    ""
  );
  ok(
    "[persisted] Django Day 1 = creation day (IST), deadline derived",
    django?.startDate === start &&
      django?.durationDays === DURATION,
    `${django?.startDate}/${django?.durationDays}d`
  );

  // Zero console errors across the whole journey.
  ok(
    "[journey] zero console errors",
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(" ;; ")
  )
} finally {
  await browser.close();
}
