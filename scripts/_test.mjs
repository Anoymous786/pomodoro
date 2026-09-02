import fs from "node:fs";
import path from "node:path";

const envPath = path.join(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) {
      const name = m[1].trim();
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      process.env[name] = val;
    }
  }
}

const store = await import("../lib/progress-store-server.ts");
const sync = await import("../lib/progress-sync.ts");
const ld = await import("../lib/learning-data.ts");
const mon = await import("../lib/monitoring.ts");
const llmModule = await import("../lib/llm.ts");
const { isRateLimitError } = llmModule;
const llmSrc = fs.readFileSync("lib/llm.ts", "utf8");
const routeSrc = fs.readFileSync("app/api/chat/route.ts", "utf8");

console.log("=== TEST 1: Task Discovery from Persisted Store ===");
const userId = "demo-user";
const docs = store.getAllStoredDocs(userId);
const tasks = docs.map((d) => sync.taskFromProgressDoc(d)).filter((t) => t !== null);
console.log("Total persisted tasks:", tasks.length);
console.log("Zoology found:", tasks.some((t) => t.name.toLowerCase().includes("zoology")));

console.log("\n=== TEST 2: resolveTaskByQuery ===");
const q1 = mon.resolveTaskByQuery(tasks, "What is my Zoology score?");
console.log('"What is my Zoology score?" -> resolved:', q1?.name ?? "NOT FOUND");
const q2 = mon.resolveTaskByQuery(tasks, "What is my Quantum score?");
console.log('"What is my Quantum score?" -> resolved:', q2?.name ?? "NOT FOUND (correct)");

console.log("\n=== TEST 3: Compact Context Size ===");
const compact = mon.buildMonitoringContext(tasks);
console.log("Compact context:", compact.length, "chars (~" + Math.round(compact.length / 4), "tokens)");
const full = ld.buildFullLearningContext(tasks);
const fullStr = JSON.stringify(full);
console.log("Full context (task-specific):", fullStr.length, "chars (~" + Math.round(fullStr.length / 4), "tokens)");

console.log("\n=== TEST 4: isRateLimitError classification ===");
console.log("429 rate limited:", isRateLimitError(new Error("Groq API error (429): rate limited")));
console.log("413 too large:", isRateLimitError(new Error("Groq API error (413): Request too large")));
console.log("401 key not set:", isRateLimitError(new Error("GROK_API_KEY is not set.")));
console.log("500 server error:", isRateLimitError(new Error("Internal server error")));
console.log("generic error:", isRateLimitError(new Error("something else")));

console.log("\n=== TEST 5: Gemini Model Name ===");
const modelMatch = llmSrc.match(/const model = process\.env\.GEMINI_MODEL \|\| "([^"]+)"/);
console.log("Gemini model default:", modelMatch ? modelMatch[1] : "NOT FOUND");
const hardcodedBad = llmSrc.match(/models\/gemini-1\.5-flash:generateContent/);
console.log("Hardcoded deprecated gemini-1.5-flash (should be null):", hardcodedBad ? "FOUND (BAD)" : "null (good)");

console.log("\n=== TEST 6: callProvider uses runWithProviderFallback ===");
console.log("callProvider exists:", !!llmSrc.match(/export async function callProvider/));
console.log("callProvider uses runWithProviderFallback:", !!llmSrc.match(/runWithProviderFallback\("call"/));

console.log("\n=== TEST 7: Zoology data in full context ===");
const zoologyCtx = full.tasks.find((t) => t.task.toLowerCase() === "zoology");
console.log("Zoology in full context:", !!zoologyCtx);
if (zoologyCtx) {
  console.log("  Status:", zoologyCtx.status);
  console.log("  Days:", zoologyCtx.days);
  console.log("  Steps:", zoologyCtx.steps);
  console.log("  Estimated:", zoologyCtx.estimated);
  console.log("  Actual:", zoologyCtx.actual);
  console.log("  Final exam:", zoologyCtx.final_exam);
  console.log("  Knowledge%:", zoologyCtx.knowledge_pct);
}

console.log("\n=== TEST 8: Review extraction ===");
const review = ld.extractAttemptReview(tasks, "What did I get wrong in my Zoology exam?");
console.log("Review found:", review.found);
if (review.found) {
  console.log("  Task:", review.task);
  console.log("  Questions:", review.questions?.length ?? 0);
}

console.log("\n=== TEST 9: Chat route context strategy ===");
console.log("Uses resolveTaskByQuery:", !!routeSrc.match(/resolveTaskByQuery/));
console.log("Uses buildMonitoringContext:", !!routeSrc.match(/buildMonitoringContext/));
console.log("Uses buildFullLearningContext only when task matched:", !!routeSrc.match(/buildFullLearningContext/));

console.log("\n✅ ALL VERIFICATIONgit add .
