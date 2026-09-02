/**
 * lib/calibration.ts — adaptive time estimation (Phase 2).
 *
 * Turns the raw estimation log (actual-vs-estimated samples recorded when a
 * task-driven work session ends) into a tiny Calibration summary that is fed
 * into the LLM prompts that assign task time estimates:
 *
 *   - ratio        : mean of recent actual/estimated ratios (1.3 = user is
 *                     ~30% slower than typical estimates, so the AI should
 *                     scale future minutes up by ~1.3x)
 *   - sampleSize   : how many observations back that ratio
 *   - recentMinutes: the mean actual session length the user recently kept
 *
 * No new caching mechanism: whenever calibration is attached to a roadmap
 * generation context it becomes part of the existing llm_cache key, so a
 * meaningful change in pace naturally invalidates the cached response.
 */
import type { Calibration, EstimationRecord } from "./types";

/** Keep the window bounded so old habits don't dominate forever. */
const MAX_SAMPLES = 200;

/**
 * Computes a Calibration from the estimation log.
 * Returns null when there is not enough signal yet (fewer than RECENT_TAKE
 * samples), so callers can omit calibration rather than send noise.
 */
export function computeCalibration(
  log: EstimationRecord[]
): Calibration | null {
  if (!log || log.length === 0) return null;

  // Use the most recent samples, newest first is fine; sort NOT needed —
  // completeSession appends chronologically. Take the tail window.
  const recent = log.slice(-MAX_SAMPLES);
  const denom = recent.filter((r) => r.estimated_minutes > 0);

  if (denom.length < 3) {
    // Too few observations to calibrate confidently.
    return null;
  }

  const ratioSum = denom.reduce((s, r) => s + r.ratio, 0);
  const ratio = denom.length > 0 ? ratioSum / denom.length : 1;

  const recentMinutesSum = denom.reduce((s, r) => s + r.actual_minutes, 0);
  const recentMinutes = recentMinutesSum / denom.length;

  return {
    // Clamp to a sane band so a single odd task can't blow up estimates.
    ratio: Math.min(3, Math.max(0.5, ratio)),
    sampleSize: denom.length,
    recentMinutes: Math.round(recentMinutes),
  };
}
