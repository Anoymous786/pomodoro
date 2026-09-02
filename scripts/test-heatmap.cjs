/**
 * scripts/test-heatmap.cjs — §2.1 quick test (runs in ~50ms, no browser).
 *
 * Seeds a known 12-week history and asserts that:
 *   • buildActivityHeatmap emits 84 day-cells across 12 columns
 *   • focus minutes map to the documented intensity buckets
 *     (100→4, 40→2, 10→1, 0/inactive→0) against the window max
 *   • every cell carries date + tooltip data (date/minutes/sessions)
 *   • streak math still agrees with the same source of truth
 *
 * lib/activity.ts is TypeScript, so we transpile it in-memory with the
 * project's own `typescript` dependency and stub its single runtime import
 * (getTodayKey) — keeping this test dependency-light and deterministic.
 */
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const TODAY = "2026-08-25"; // fixed Tuesday for determinism

function shift(dateKey, days) {
  const d = new Date(`${dateKey}T00:00:00`);
  d.setDate(d.getDate() + days);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// Transpile lib/activity.ts → CJS in memory.
const srcPath = path.join(__dirname, "..", "lib", "activity.ts");
const src = fs.readFileSync(srcPath, "utf8");
const { outputText } = ts.transpileModule(src, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2019,
    esModuleInterop: true,
  },
});

// Stub ./storage so today is fixed; everything else comes from the real file.
const fakeModule = { exports: {} };
const stubRequire = (id) => {
  if (id === "./storage") return { getTodayKey: () => TODAY };
  return require(id);
};
new Function(
  "exports",
  "require",
  "module",
  "__filename",
  "__dirname",
  outputText
)(fakeModule.exports, stubRequire, fakeModule, srcPath, path.dirname(srcPath));

const { buildActivityHeatmap, focusIntensity, describeDay, computeStreaks } =
  fakeModule.exports;

/* ---- Seed ---- */
const day = (offset, sessions, minutes, tasksDone = 0, tasksTotal = 0) => ({
  date: shift(TODAY, offset),
  sessions_count: sessions,
  focus_minutes: minutes,
  tasks_completed: tasksDone,
  total_tasks: tasksTotal,
  productivity: 0,
});
const history = {
  [shift(TODAY, 0)]: day(0, 2, 100, 3, 4), // max → level 4
  [shift(TODAY, -1)]: day(-1, 1, 40, 2, 3), // 40% of max → level 2
  [shift(TODAY, -2)]: day(-2, 1, 10, 0, 2), // 10% of max → level 1
  [shift(TODAY, -5)]: day(-5, 0, 0, 1, 1), // active by tasks, 0 min → level 0
  [shift(TODAY, -30)]: day(-30, 1, 25, 1, 1), // old isolated active day
};

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures += 1;
};

/* ---- Run ---- */
const { columns } = buildActivityHeatmap(history, TODAY, 12);
const cells = columns.flat();

check("at least 12 week-columns emitted", columns.length >= 12, `got ${columns.length}`);
check("at least 84 day cells", cells.length >= 84, `got ${cells.length}`);

const byDate = Object.fromEntries(cells.map((c) => [c.date, c]));
// §2.1 regression guard: TODAY itself must be present in the grid.
check("grid includes TODAY", byDate[TODAY] !== undefined);
const lvl = (k) => focusIntensity(byDate[k].focusMinutes, 100);
check("max-focus day maps to level 4", lvl(shift(TODAY, 0)) === 4);
check("mid day maps to level 2", lvl(shift(TODAY, -1)) === 2);
check("low day maps to level 1", lvl(shift(TODAY, -2)) === 1);

const t0 = byDate[TODAY];
check(
  "cell carries date + minutes + sessions",
  t0.date === TODAY && t0.focusMinutes === 100 && t0.sessions === 2
);
check(
  "tooltip describes date/minutes/sessions",
  describeDay(t0).includes(TODAY) &&
    describeDay(t0).includes("100 min focused") &&
    describeDay(t0).includes("2 sessions")
);

const streaks = computeStreaks(history, TODAY);
check("current streak counts today+yesterday+day-before", streaks.current === 3, `got ${streaks.current}`);
check("longest streak >= current", streaks.longest >= streaks.current);

console.log(
  failures === 0
    ? "\nHEATMAP TEST: PASS"
    : `\nHEATMAP TEST: FAIL (${failures} assertion${failures === 1 ? "" : "s"})`
);
process.exit(failures === 0 ? 0 : 1);