/**
 * lib/skills.ts — §13 persistent per-topic skill scoring.
 *
 * A topic's score is a rolling weighted average over ALL evidence, so it
 * persists across sessions and never resets when a new roadmap of the same
 * topic is completed. Evidence comes from two sources:
 *   - per-step check-ins (lib/types StepCheckIn) — low weight, quick gate
 *   - full-roadmap mock exam answers (lib/types RoadmapExamResult) — high
 *     weight, measures real comprehension
 *
 * The rolling design keeps earlier correct answers meaningful without ever
 * letting a single roadmap wipe the profile (no reset-per-roadmap). This is
 * the same shape that maps 1:1 onto a future DynamoDB row per user/topic.
 */
import type { SkillProfile } from "./types";

/** Weigh a check-in answer lightly, a mock-exam answer heavily. */
export interface SkillEvidence {
  topic: string;
  label: string;
  correct: boolean;
  /** Weight of this answer in the rolling score (higher = more influence). */
  weight: number;
  /** True if this evidence came from a graded mock-exam question. */
  fromExam?: boolean;
  /** Epoch ms for lastUpdated. Defaults to Date.now(). */
  timestamp?: number;
}

/**
 * Merges new pieces of evidence into an existing (or fresh) profile.
 *
 * Score = (prior score * priorWeight + Σ(evidence.correct ? weight : 0)) /
 *         (priorWeight + Σ weight)   expressed as a percentage.
 *
 * priorWeight = the profile's existing raw count of weighted answers seen so
 * far. This keeps it a true EMA-style rolling average that converges on the
 * learner's real level without hard resets per roadmap.
 */
export function updateSkillProfile(
  existing: SkillProfile | undefined,
  evidence: SkillEvidence[],
): SkillProfile | null {
  if (evidence.length === 0) return existing ?? null;

  const topic = evidence[0].topic;
  const label = evidence[0].label || topic;
  const base: SkillProfile =
    existing && existing.topic === topic
      ? { ...existing }
      : {
          topic,
          label,
          score: 0,
          questionsAttempted: 0,
          correct: 0,
          total: 0,
          examsTaken: 0,
          lastUpdated: 0,
        };

  let totalWeight = 0;
  let weightedCorrect = 0;
  let lastTs = base.lastUpdated;
  for (const ev of evidence) {
    const w = ev.weight > 0 ? ev.weight : 1;
    totalWeight += w;
    if (ev.correct) {
      weightedCorrect += w;
      base.correct += 1;
    }
    base.total += 1;
    if (ev.fromExam) base.examsTaken += 1;
    if (ev.timestamp) lastTs = Math.max(lastTs, ev.timestamp);
  }

  const priorWeight = base.total - evidence.length; // weight from before this batch
  const denominator = priorWeight + totalWeight;
  const numerator = (base.score / 100) * priorWeight + weightedCorrect;

  base.score =
    denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
  base.questionsAttempted += evidence.filter((e) => e.fromExam).length;
  base.lastUpdated = lastTs || Date.now();
  return base;
}
/**
 * Builds the full set of evidence from a completed roadmap's steps (their
 * check-ins) plus a roadmap exam result. Returns one SkillProfile per distinct
 * topic found.
 */
export function skillProfilesFromRoadmapEvidence(input: {
  topicLabel: string;
  steps: {
    title: string;
    checkIn?: {
      correct: boolean;
    };
  }[];
  exam?: {
    breakdown: Record<string, { correct: number; total: number }>;
    gradedAt?: number;
  };
}): SkillEvidence[][] {
  // Primary topic = the roadmap topic itself.
  const topic = slugTopic(input.topicLabel);
  const groups = new Map<string, SkillEvidence[]>();
  const ensure = (t: string, label: string) => {
    if (!groups.has(t)) groups.set(t, []);
    return groups.get(t)!;
  };

  // 1) Check-ins contribute low-weight evidence for the roadmap topic AND for
  //    this step's own sub-topic (derived from the step title) when present.
  for (const step of input.steps) {
    if (!step.checkIn) continue;
    const weight = 1; // check-ins are quick gates — light weight
    const minor = topicFromStep(step);
    ensure(topic, input.topicLabel).push({
      topic,
      label: input.topicLabel,
      correct: step.checkIn.correct,
      weight,
      fromExam: false,
      timestamp: Date.now(),
    });
    if (minor && minor !== topic) {
      ensure(minor, prettyLabel(minor)).push({
        topic: minor,
        label: prettyLabel(minor),
        correct: step.checkIn.correct,
        weight,
        fromExam: false,
        timestamp: Date.now(),
      });
    }
  }

  // 2) Mock-exam breakdown questions contribute higher-weight evidence.
  if (input.exam) {
    for (const [t, { correct, total }] of Object.entries(
      input.exam.breakdown,
    )) {
      const w = 3; // exam answers weigh more than quick check-ins
      const arr = ensure(t, prettyLabel(t));
      const incorrect = Math.max(0, total - correct);
      for (let i = 0; i < correct; i++) {
        arr.push({
          topic: t,
          label: prettyLabel(t),
          correct: true,
          weight: w,
          fromExam: true,
          timestamp: input.exam.gradedAt ?? Date.now(),
        });
      }
      for (let i = 0; i < incorrect; i++) {
        arr.push({
          topic: t,
          label: prettyLabel(t),
          correct: false,
          weight: w,
          fromExam: true,
          timestamp: input.exam.gradedAt ?? Date.now(),
        });
      }
    }
  }

  return Array.from(groups.values());
}

/** Turns "Learn React in 7 days" into "react". */
export function slugTopic(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "general"
  );
}

/** Best-effort display label for a slug (react -> React). */
export function prettyLabel(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) =>
      w === "general" ? "General" : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(" ");
}

/** Extracts a sub-topic from a step title if it looks topical. */
function topicFromStep(step: { title: string }): string | null {
  const t = slugTopic(step.title);
  if (!t || t === "general") return null;
  return t;
}
