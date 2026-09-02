// Fix the Gemini model name and indentation in lib/llm.ts
import fs from "node:fs";

const p = "lib/llm.ts";
let src = fs.readFileSync(p, "utf8");

// Fix the line — replace any mangled version with the correct, properly-indented one
const fixed = src.replace(
  /.*const model = process\.env\.GEMINI_MODEL \|\| "gemini-3\.6-flash";.*\n\s*const url = `https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/\$\{model\}:generateContent\?key=\$\{apiKey\}`;/,
  '  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";\n  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;'
);

fs.writeFileSync(p, fixed);
console.log("Done. Checking result:");
const lines = fixed.split("\n");
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("gemini-3.6-flash")) {
    console.log(`Line ${i+1}: ${lines[i]}`);
    if (i+1 < lines.length && lines[i+1].includes("generativelanguage")) {
      console.log(`Line ${i+2}: ${lines[i+1]}`);
    }
  }
}