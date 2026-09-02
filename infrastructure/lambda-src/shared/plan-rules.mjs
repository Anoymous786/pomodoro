/**
 * shared/plan-rules.mjs — Phase A1/B/E roadmap rules shared by the Lambda
 * backend, mirrored 1:1 from lib/llm.ts so LOCAL and DEPLOYED behave
 * identically:
 *
 *   A1: the day count returned by the model is validated server-side against
 *       the requested total days; on mismatch we retry ONCE with an explicit
 *       correction note before failing visibly (never silently shortened).
 *   B : when the user stated a concrete minutes-per-day budget, any day that
 *       meaningfully overshoots it (> +10%) triggers an automatic re-plan
 *       pass before the roadmap is returned.
 *   E : every day carries a "search" string the frontend turns into a
 *       YouTube search link.
 */

/** "7 days", "7", "about a week" (7), "two weeks" (14), "a month" (30). */
export function parseCountFromText(s, max = 60) {
  if (s === null || s === undefined) return null;
  const str = String(s).toLowerCase().trim();
  if (!str) return null;
  const wordMap = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14,
    fifteen: 15, twenty: 20, thirty: 30,
  };
  for (const [word, value] of Object.entries(wordMap)) {
    const re = new RegExp(`\\b${word}\\s+(?:days?|weeks?)\\b`);
    if (re.test(str)) {
      const weeks = /\bweeks?\b/.test(str);
      return Math.max(1, Math.min(max, weeks ? value * 7 : value));
    }
  }
  if (/\b(?:a|one)\s+week\b/.test(str)) return 7;
  if (/\b(?:a|one)\s+month\b/.test(str)) return 30;
  const match = str.match(/\d{1,3}/);
  if (match) {
    const n = parseInt(match[0], 10);
    if (Number.isFinite(n) && n >= 1) return Math.min(max, n);
  }
  return null;
}

/** The hard day-count requirement for a roadmap, or null when not stated. */
export function requestedDayCount(context) {
  if (!context) return null;
  if (
    typeof context.days_count === "number" &&
    Number.isFinite(context.days_count) &&
    context.days_count >= 1
  ) {
    return Math.floor(context.days_count);
  }
  if (context.days_requested) {
    const parsed = parseCountFromText(context.days_requested);
    if (parsed !== null) return parsed;
  }
  // NOTE: deliberately NO fallback that parses context.time_available here.
  // time_available is a per-day DURATION ("45 minutes per day"), not a day
  // count — treating "45 minutes" as 45 days would make the Phase A1 day-count
  // validation demand an absurd roadmap and fail it. This mirrors lib/llm.ts.
  return null;
}

/** The concrete minutes-per-day budget, or null when not stated. */
export function minutesPerDay(context) {
  if (!context) return null;
  if (
    typeof context.minutes_per_day === "number" &&
    Number.isFinite(context.minutes_per_day) &&
    context.minutes_per_day > 0
  ) {
    return context.minutes_per_day;
  }
  if (context.time_available) {
    const str = String(context.time_available).toLowerCase();
    const hourMatch = str.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/);
    if (hourMatch) {
      const hours = parseFloat(hourMatch[1]);
      if (Number.isFinite(hours) && hours > 0) {
        return Math.round(Math.min(16, hours) * 60);
      }
    }
    const minMatch = str.match(/(\d{1,4})\s*(?:minutes?|mins?|m)\b/);
    if (minMatch) {
      const mins = parseInt(minMatch[1], 10);
      if (Number.isFinite(mins) && mins > 0) return Math.min(960, mins);
    }
  }
  return null;
}

/** Day total of estimated task minutes. */
export function dayTotalMinutes(day) {
  return (day?.tasks ?? []).reduce(
    (sum, t) => sum + (t?.estimated_minutes || 0),
    0
  );
}

/** A1: strict server-side day-count validation. */
export function validateDayCount(roadmap, dayCount) {
  if (dayCount === null) return true; // no hard requirement -> don't reject
  return Array.isArray(roadmap?.days) && roadmap.days.length === dayCount;
}

/**
 * E: normalizes the model's suggested search into a YouTube query.
 * Strips a "video:" / "youtube:" style prefix the model may add, trims, caps.
 */
export function sanitizeSearch(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim().replace(/^(?:video|youtube|yt)\s*:\s*/i, "").trim();
  s = s.replace(/\s+/g, " ");
  if (!s) return null;
  return s.slice(0, 200);
}

/** E: guarantees every day has a usable `search` string. */
export function ensureSearchLinks(roadmap) {
  if (!roadmap || !Array.isArray(roadmap.days)) return roadmap;
  for (const day of roadmap.days) {
    const explicit = sanitizeSearch(day?.search);
    if (explicit) {
      day.search = explicit;
      continue;
    }
    const tasks = Array.isArray(day?.tasks) ? day.tasks : [];
    const focus =
      tasks.find((t) => t && t.priority === "High")?.name ||
      (typeof tasks[0]?.name === "string" ? tasks[0].name : "") ||
      (typeof day?.day_title === "string" ? day.day_title : "");
    const base =
      typeof roadmap.topic_name === "string" ? roadmap.topic_name : "";
    day.search = sanitizeSearch([focus, base].filter(Boolean).join(" ")) ?? "";
  }
  return roadmap;
}