/**
 * lib/confetti.ts — §P4 confetti animation for complete-roadmap celebrations.
 * Uses canvas-confetti (already installed as a dependency). No extra cost;
 * fire-and-forget helpers so a failure never blocks app logic.
 */
// Import inside a try so SSR/build never chokes if the module can't resolve.
import confetti from "canvas-confetti";

export function fireCelebration(): void {
  if (typeof window === "undefined") return;
  try {
    // Two bursts from opposite sides for a fuller celebration.
    confetti({ particleCount: 120, spread: 70, origin: { x: 0.3, y: 0.6 } });
    confetti({ particleCount: 120, spread: 70, origin: { x: 0.7, y: 0.6 } });
  } catch {
    // Confetti is cosmetic — never block on it.
  }
}