/**
 * shared/llm.mjs — LLM provider abstraction, ported 1:1 from the app's
 * lib/llm.ts (Groq = OpenAI-compatible endpoint; Gemini = Google AI Studio).
 * Prompts live next to the features that use them; this file only knows how
 * to CALL a model and parse strict-JSON answers.
 */
import crypto from "node:crypto";
import { resolveSecret, resolveConfig } from "./aws.mjs";

export function stripMarkdownFences(text) {
  const trimmed = String(text ?? "").trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

/** Deterministic JSON (sorted keys) so identical requests hash identically. */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",")}}`;
}

/** sha256 hex of provider+model+kind+payload — the llm_cache partition key. */
export function cacheKeyFor(provider, model, kind, payload) {
  return crypto
    .createHash("sha256")
    .update(`${provider}|${model}|${kind}|${stableStringify(payload)}`)
    .digest("hex");
}

async function activeProvider() {
  return (
    (await resolveConfig("LLM_PROVIDER", "LLM_PROVIDER_PARAM", "grok")) ||
    "grok"
  );
}

// ---------------------------------------------------------------
// Provider HTTP calls (identical request/response shapes as Next.js)
// ---------------------------------------------------------------

async function callGroq(apiKey, systemPrompt, userPrompt) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Groq API error (${res.status}): ${text}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq API returned an empty response.");
  return content;
}

async function callGemini(apiKey, systemPrompt, userPrompt) {
  const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        { parts: [{ text: systemPrompt }, { text: userPrompt }] },
      ],
      generationConfig: {
        temperature: 0.7,
        responseMimeType: "application/json",
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini API error (${res.status}): ${text}`);
  }
  const data = await res.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error("Gemini API returned an empty response.");
  return content;
}

/**
 * §14 provider fallback (mirrors lib/llm.ts runWithProviderFallback).
 *
 * Runs `run(provider)` with the configured primary provider. If — and ONLY
 * if — it fails with a rate-limit/quota error (HTTP 429, "insufficient
 * quota", "rate limit", "Resource has been exhausted"), the SAME request is
 * retried once against the other provider. Any other error propagates
 * unchanged so callers show truthful messages. Which provider actually
 * served the request is logged to CloudWatch only; never shown to users.
 */
const OPPOSITE = { grok: "gemini", gemini: "grok" };

function isRateLimitError(err) {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /429|rate.?limit|insufficient_quota|quota|resource has been exhausted|1000/i.test(
    message
  );
}

export async function runWithProviderFallback(kind, run) {
  const primary = await activeProvider();
  try {
    const out = await run(primary);
    console.log(`[llm] ${kind} served by provider=${primary}`);
    return out;
  } catch (err) {
    if (!isRateLimitError(err)) throw err;
    const fallback = OPPOSITE[primary] ?? "gemini";
    try {
      const out = await run(fallback);
      console.log(
        `[llm] ${kind} served by provider=${fallback} (after ${primary} rate-limit fallback)`
      );
      return out;
    } catch {
      // Prefer the original (rate-limit) error so the user sees "try again".
      throw err;
    }
  }
}

/**
 * Runs any (systemPrompt, userPrompt) pair through the configured provider,
 * with automatic rate-limit fallback to the other provider (§14).
 * Throws with a clear message when a key is missing.
 */
export async function callProvider(systemPrompt, userPrompt) {
  return runWithProviderFallback("call", async (provider) => {
    if (provider === "gemini") {
      const apiKey = await resolveSecret(
        "GEMINI_API_KEY",
        "GEMINI_API_KEY_PARAM"
      );
      return callGemini(apiKey, systemPrompt, userPrompt);
    }
    const apiKey = await resolveSecret("GROQ_API_KEY", "GROQ_API_KEY_PARAM");
    return callGroq(apiKey, systemPrompt, userPrompt);
  });
}

/** Exposed for cache-key construction in the worker. */
export async function currentProviderAndModel() {
  const provider = await activeProvider();
  const model =
    provider === "gemini"
      ? process.env.GEMINI_MODEL || "gemini-1.5-flash"
      : process.env.GROQ_MODEL || "openai/gpt-oss-120b";
  return { provider, model };
}
