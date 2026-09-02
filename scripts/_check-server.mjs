// Minimal dev-server health probe used by local verification runs.
const url = process.argv[2] ?? "http://localhost:3000";
const started = Date.now();
while (Date.now() - started < 45_000) {
  try {
    const res = await fetch(url, { redirect: "manual" });
    console.log(`SERVER_UP ${res.status}`);
    process.exit(0);
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
  }
}
console.log("SERVER_DOWN");
process.exit(1);
