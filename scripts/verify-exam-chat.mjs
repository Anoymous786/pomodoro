/**
 * scripts/verify-exam-chat.mjs — e2e verification of §11/§12/§6 (exam gating +
 * assistant chat). Seeds one 2-day task with 2 steps, then checks:
 *  1. assistant launcher + panel render (grounded chat UI)
 *  2. ticking a step opens the per-step check-in gate
 *  3. answering/falling back completes the step (progress 1/2)
 *  4. completing the last step triggers the full-roadmap mock-exam modal
 *  5. roadmap shows 100% and the exam modal closes cleanly
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:3000";

function findChrome() {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error("No Chrome/Edge found");
}

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${detail}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.setViewport({ width: 1280, height: 1000 });
  await page.evaluateOnNewDocument(() => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "pomodoro:app:v1",
      JSON.stringify({
        settings: {},
        tasks: [],
        practiceTasks: [
          {
            id: "react-task",
            name: "React",
            description: "",
            durationDays: 2,
            startDate: new Date().toISOString().slice(0, 10),
            is_completed: false,
            roadmap: [
              { id: "s1", title: "JSX Basics", dayNumber: 1 },
              { id: "s2", title: "State & Props", dayNumber: 1 },
            ],
          },
        ],
      }),
    );
  });

  await page.goto(`${BASE}/task/react-task`, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  await page.waitForSelector("[data-testid='ws-title']", { timeout: 20000 });
  await sleep(800);

  // ---- 1. Assistant chat launcher + panel ----
  ok("[chat] launcher visible", !!(await page.$("[data-testid='chat-launcher']")));
  await page.click("[data-testid='chat-launcher']");
  await page.waitForSelector("[data-testid='chat-panel']", { timeout: 5000 });
  ok("[chat] panel opens", !!(await page.$("[data-testid='chat-panel']")));
  ok("[chat] input present", !!(await page.$("[data-testid='chat-input']")));
  await page.click("[data-testid='chat-panel'] [aria-label='Close assistant']");
  await sleep(300);
  ok("[chat] panel closes", !(await page.$("[data-testid='chat-panel']")));

  // ---- 2. Ticking a step opens the check-in gate ----
  const row1 = (await page.$$("[data-testid='step-row']"))[0];
  await (await row1.$("[data-testid='step-check']")).click();
  await page.waitForSelector("[data-testid='checkin-modal']", { timeout: 15000 });
  // Wait until the modal settles: either a question renders or the graceful
  // "unverified" fallback appears (LLM latency / missing key both allowed).
  const settle = async () => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (await page.$("[data-testid='checkin-option-0']")) return "question";
      const t = await page.$eval(
        "[data-testid='checkin-modal']",
        (el) => el.textContent || "",
      );
      if (t.includes("Mark done anyway")) return "fallback";
      await sleep(500);
    }
    return "timeout";
  };
  const mode = await settle();
  const hasQuestion = mode === "question";
  const hasFallback = mode === "fallback";
  ok(
    "[checkin] shows question OR unverified fallback",
    hasQuestion || hasFallback,
    `settled: ${mode}`,
  );

  // ---- 3. Answer or fall back -> step completes ----
  // The min-practice gate normally blocks a sub-minute finish; tests opt out
  // via a window flag so the check-in/completion journey can be verified.
  await page.evaluate(() => { window.__MIN_PRACTICE_OVERRIDE__ = true; });
  if (hasQuestion) {
    await page.click("[data-testid='checkin-option-0']");
    await page.click("[data-testid='checkin-submit']");
  } else {
    await page.click("[data-testid='checkin-skip']");
  }
  await page.waitForFunction(
    () =>
      (document.querySelector("[data-testid='rm-progress']")?.textContent ?? "").includes(
        "1/2",
      ),
    { timeout: 10000 },
  );
  const prog1 = await page.$eval("[data-testid='rm-progress']", (el) => el.textContent || "");
  ok("[checkin] step 1 completes (1/2)", prog1.includes("1/2"), prog1);
  ok("[checkin] modal closed", !(await page.$("[data-testid='checkin-modal']")));

  // Persisted state should show isDone + a check-in object on the step.
  const stored = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem("pomodoro:app:v1") ?? "{}"),
  );
  const step1 = stored.practiceTasks?.[0]?.roadmap?.find((s) => s.id === "s1");
  ok("[checkin] isDone persisted", step1?.isDone === true, JSON.stringify(step1 ?? {}));
  ok(
    "[checkin] check-in recorded on the step",
    typeof step1?.checkIn === "object" && step1.checkIn !== null,
    JSON.stringify(step1?.checkIn ?? null),
  );

  // ---- 4. Completing the LAST step triggers the full-roadmap mock exam ----
  const row2 = (await page.$$("[data-testid='step-row']"))[1];
  await (await row2.$("[data-testid='step-check']")).click();
  await page.waitForSelector("[data-testid='checkin-modal']", { timeout: 15000 });
  const mode2 = await settle();
  if (mode2 === "question") {
    await page.click("[data-testid='checkin-option-0']");
    await page.click("[data-testid='checkin-submit']");
  } else {
    await page.click("[data-testid='checkin-skip']");
  }
  await page.waitForSelector("[data-testid='roadmap-exam-modal']", { timeout: 20000 });
  const examText = await page.$eval(
    "[data-testid='roadmap-exam-modal']",
    (el) => el.textContent || "",
  );
  ok("[exam] mock exam modal opens after last step", examText.length > 0);
  ok(
    "[exam] mentions 20 questions or exam wording",
    /20|mock exam|question/i.test(examText),
    examText.slice(0, 80),
  );

  // ---- 5. Close the exam modal; roadmap shows complete ----
  await page.click("[data-testid='roadmap-exam-modal'] [aria-label='Close mock exam']");
  await sleep(400);
  ok("[exam] modal closes", !(await page.$("[data-testid='roadmap-exam-modal']")));
  const prog2 = await page.$eval("[data-testid='rm-progress']", (el) => el.textContent || "");
  ok("[roadmap] 100% after all steps", prog2.includes("2/2") && prog2.includes("100%"), prog2);

  ok("[suite] zero page errors", errors.length === 0, errors.join(" | "));
} catch (err) {
  fail++;
  console.error("SUITE ERROR:", err.message);
} finally {
  await browser.close();
}

console.log(`\nRESULT pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);

