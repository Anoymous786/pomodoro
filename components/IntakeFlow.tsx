"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Loader2, Send, Sparkles, X, Zap } from "lucide-react";
import { IntakeContext } from "@/lib/types";
import { apiPost, isRemoteApi, uploadResumeToS3 } from "@/lib/api";

interface IntakeFlowProps {
  /** Topic the user typed in the board before opening the flow. */
  topic: string;
  /** True while the parent is generating the roadmap. */
  generating: boolean;
  /**
   * Optional pre-known total days (e.g. a task workspace already has a fixed
   * day window). When set, the flow SKIPS its own days question and treats
   * the value as the user's explicit answer — it can never be overridden by
   * the model, only the minutes-per-day question still applies.
   */
  initialDays?: number | null;
  onCancel: () => void;
  /** Called once when the flow has enough info (or the user skips). */
  onComplete: (topic: string, context: IntakeContext) => void;
}

interface IntakeTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * INTERNAL safety cap on intake turns so the conversation can never loop
 * forever even if the model keeps asking. Deliberately NOT surfaced to
 * the user — at the cap we silently proceed to generation.
 */
const MAX_TURNS = 8;

/**
 * Phase B: resolves the concrete number of days from the explicit numeric
 * field (`daysInput`) or from a free-text answer captured into `daysCount`.
 * Returns null when the user has NOT (yet) given a concrete day count.
 */
function resolveDays(
  daysInput: string,
  daysCount: number | null,
): number | null {
  if (daysCount !== null && Number.isFinite(daysCount) && daysCount >= 1) {
    return Math.floor(daysCount);
  }
  const trimmed = (daysInput || "").trim();
  if (/^\d{1,3}$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return null;
}

/**
 * Phase B: attempts to extract BOTH a concrete day count and a minutes-per-day
 * value from the user's free-text answer. Returns new values (or nulls) for
 * whichever it could pin down. Example recognized strings:
 *   "7 days"                 -> days = 7
 *   "1 hour a day"           -> mins = 60
 *   "45 minutes each day"    -> mins = 45
 *   "10 days, 30 min / day"  -> days = 10, mins = 30
 */
function parseNumbersFromText(text: string): {
  days: number | null;
  minutes: number | null;
} {
  const t = text.toLowerCase();
  const daysMatch = t.match(/(\d{1,3})\s*(?:days?|din\b)/);
  const days = daysMatch ? parseInt(daysMatch[1], 10) : null;

  let minutes: number | null = null;
  // "Xh Ymin" (optional Y)
  const hours = t.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/);
  if (hours) {
    let m = parseFloat(hours[1]) * 60;
    const mins = t.match(/^\d+[^h]*?(\d+)\s*(?:minutes?|mins?|m)\b/);
    if (mins) m += parseInt(mins[1], 10);
    if (m > 0 && m <= 24 * 60) {
      minutes = Math.round(m);
    }
  }
  if (minutes === null) {
    const mins = t.match(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/);
    if (mins) {
      const n = parseFloat(mins[1]);
      if (Number.isFinite(n) && n > 0 && n <= 24 * 60) {
        minutes = Math.round(n);
      }
    }
  }
  return { days: days && days >= 1 ? days : null, minutes };
}

/** Sensible defaults for the goal/level fields (NEVER for days or time-per-day). */
function defaultContext(
  topic: string,
): Pick<IntakeContext, "topic" | "goal" | "level"> {
  return {
    topic,
    level: "Beginner moving toward intermediate",
    goal: "General-purpose learning of this topic",
  };
}

/**
 * Best-effort, dependency-free PDF text extraction (client-side).
 * PDFs store visible strings inside parentheses within content streams;
 * we decode as latin1 and pull those runs out. Works for many text-based
 * PDFs; fails gracefully otherwise.
 */
function extractPdfText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let raw = "";
  const CHUNK = 0x8000;
  const chunk = new Array<number>(CHUNK);
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(bytes.length, i + CHUNK);
    let n = 0;
    for (let j = i; j < end; j++) chunk[n++] = bytes[j];
    raw += String.fromCharCode.apply(null, chunk.slice(0, n));
  }
  const matches = raw.match(/\((?:\\.|[^\\)])*\)/g) ?? [];
  return matches
    .map((m) =>
      m
        .slice(1, -1)
        .replace(/\\([()\\])/g, "$1")
        .replace(/\\[rn]/g, " "),
    )
    .filter((s) => /[A-Za-z]{2,}/.test(s))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

async function readFileText(file: File): Promise<string> {
  if (/\.(txt|md|markdown|csv)$/i.test(file.name)) {
    return file.text();
  }
  if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
    const buf = await file.arrayBuffer();
    return extractPdfText(buf);
  }
  // Last resort: try plain text decoding.
  return file.text();
}

/**
 * Adaptive pre-plan intake: a chat where the AI asks ONE question at a
 * time and stops as soon as it can build a solid roadmap. The user can
 * attach a resume up-front (its text infers skill level, skipping the
 * level question) or hit the always-visible skip button.
 */
export default function IntakeFlow({
  topic,
  generating,
  initialDays = null,
  onCancel,
  onComplete,
}: IntakeFlowProps) {
  const [messages, setMessages] = useState<IntakeTurn[]>([]);
  const [knownFields, setKnownFields] = useState<Partial<IntakeContext>>({});
  const [resumeText, setResumeText] = useState<string | null>(null);
  const [resumeName, setResumeName] = useState<string | null>(null);
  const [input, setInput] = useState("");
  /** v3: explicit "kitne din lagaoge?" answer driving roadmap length. */
  const [daysInput, setDaysInput] = useState("");
  /**
   * Phase B: the CONCRETE numbers the user must give before any roadmap is
   * generated. `daysCount` is the total number of days; `minutesPerDay` is how
   * much time they can realistically spend per day. Neither may be assumed —
   * the flow keeps asking until both are concrete. Stored in refs so the
   * gating logic can read them synchronously (no stale-state races).
   */
  const daysCountRef = useRef<number | null>(initialDays);
  const minutesPerDayRef = useRef<number | null>(null);
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const turnCount = useRef(0);
  const finished = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** Asks the API for the next single question (or a done signal). */
  const askNextQuestion = useCallback(
    async (
      history: IntakeTurn[],
      known: Partial<IntakeContext>,
      resume: string | null,
    ) => {
      const res = await apiPost("/api/intake", {
        topic,
        history,
        knownFields: known,
        ...(resume ? { resumeText: resume } : {}),
      });
      const data = (await res.json()) as {
        decision?: {
          next_question?: string | null;
          done: boolean;
          likely_goal?: string | null;
          likely_level?: string | null;
        };
        error?: string;
      };
      if (!res.ok || !data.decision) {
        throw new Error(data.error ?? "The intake assistant is unavailable.");
      }
      return data.decision;
    },
    [topic],
  );

  /** Fires roadmap generation exactly once with everything gathered. */
  const finalize = useCallback(
    (known: Partial<IntakeContext>, resume: string | null) => {
      // Phase B HARD GATE: we must never generate a roadmap without the user's
      // concrete total-days AND minutes-per-day. If either is still missing,
      // this is a no-op — callers route back to a targeted follow-up
      // question instead.
      const days = resolveDays(daysInput, daysCountRef.current);
      const mins = minutesPerDayRef.current;
      if (days === null || mins === null) return;

      if (finished.current) return;
      finished.current = true;
      const finalTopic = topic.trim() || "New skill";
      const context: IntakeContext = {
        ...known,
        topic: finalTopic,
        days_count: days,
        days_requested: `${days} days`,
        minutes_per_day: mins,
        time_available: `${mins} minutes per day`,
        ...(resume ? { resumeText: resume } : {}),
      };
      onComplete(finalTopic, context);
    },
    [onComplete, topic, daysInput],
  );

  /**
   * Phase B gating. When both the concrete total-days AND minutes-per-day are
   * known, finalize the flow. Otherwise append a direct, targeted follow-up
   * question for whichever is still missing — never silently assume numbers.
   */
  const maybeFinish = useCallback(
    (known: Partial<IntakeContext>, resume: string | null): boolean => {
      const wantsFinish =
        resolveDays(daysInput, daysCountRef.current) !== null &&
        minutesPerDayRef.current !== null;
      if (wantsFinish) {
        finalize(known, resume);
        return true;
      }
      const missing: string[] = [];
      if (resolveDays(daysInput, daysCountRef.current) === null) {
        missing.push("how many total days you'll need");
      }
      if (minutesPerDayRef.current === null) {
        missing.push(
          'how much time you can realistically spend per day (e.g. "45 minutes" or "1 hour")',
        );
      }
      setError(null);
      const q = `Great — almost there. I just need one more thing to plan this properly: ${missing.join(" and ")}.`;
      setMessages((prev) => [...prev, { role: "assistant", content: q }]);
      return false;
    },
    [daysInput, finalize],
  );

  /** Parses a user's free-text answer and updates the concrete refs. */
  const captureGrandQuestions = useCallback((text: string) => {
    const { days, minutes } = parseNumbersFromText(text);
    if (days !== null) daysCountRef.current = days;
    if (minutes !== null) minutesPerDayRef.current = minutes;
  }, []);

  /** Merges model inferences without overwriting explicit user answers. */
  const mergeInference = useCallback(
    (decision: Awaited<ReturnType<typeof askNextQuestion>>) => {
      setKnownFields((prev) => ({
        ...prev,
        ...(decision.likely_goal && !prev.goal
          ? { goal: decision.likely_goal }
          : {}),
        ...(decision.likely_level && !prev.level
          ? { level: decision.likely_level }
          : {}),
      }));
    },
    [],
  );

  // Kick off the very first question on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setThinking(true);
      setError(null);
      try {
        const decision = await askNextQuestion([], {}, null);
        if (cancelled) return;
        mergeInference(decision);
        if (decision.done || !decision.next_question) {
          maybeFinish({}, null);
        } else {
          setMessages([{ role: "assistant", content: decision.next_question }]);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Could not start the intake.",
          );
        }
      } finally {
        if (!cancelled) setThinking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll to the newest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, thinking]);

  const submitAnswer = async () => {
    const trimmed = input.trim();
    if (!trimmed || thinking || generating || finished.current) return;
    const nextHistory: IntakeTurn[] = [
      ...messages,
      { role: "user", content: trimmed },
    ];
    // Phase B: capture any concrete day count / minutes-per-day the user just
    // gave in free text (the two fields that can never be assumed).
    captureGrandQuestions(trimmed);
    setMessages(nextHistory);
    setInput("");
    setThinking(true);
    setError(null);
    turnCount.current += 1;
    try {
      // Safety cap reached → stop asking (but NEVER silently finalize with a
      // missing day/time budget — maybeFinish still gates it).
      if (turnCount.current >= MAX_TURNS) {
        maybeFinish(knownFields, resumeText);
        return;
      }
      const decision = await askNextQuestion(
        nextHistory,
        knownFields,
        resumeText,
      );
      mergeInference(decision);
      if (decision.done || !decision.next_question) {
        maybeFinish(knownFields, resumeText);
      } else {
        setMessages([
          ...nextHistory,
          { role: "assistant", content: decision.next_question },
        ]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setMessages(messages); // roll back optimistic bubble so they can retry
    } finally {
      setThinking(false);
    }
  };

  const handleSkip = () => {
    if (generating || finished.current) return;
    // Skip fills goal/level defaults, but NEVER the required day count or
    // time-per-day — those must still come explicitly from the user.
    maybeFinish({ ...defaultContext(topic) }, resumeText);
  };

  const handleResumeUpload = async (file: File) => {
    setError(null);
    let clipped = "";
    try {
      // Deployed: direct-to-S3 upload + server-side extraction (Phase 3).
      // Local dev without the API env var: original client-side extraction.
      const text = isRemoteApi()
        ? await uploadResumeToS3(file)
        : await readFileText(file);
      if (!text || text.replace(/\s+/g, "").length < 80) {
        throw new Error(
          "We couldn't read enough text from that file. Try a .txt export instead.",
        );
      }
      clipped = text.slice(0, 8000);
      setResumeText(clipped);
      setResumeName(file.name);
      // Re-run inference with the resume attached so the level question
      // is skipped from here on.
      setThinking(true);
      const decision = await askNextQuestion(messages, knownFields, clipped);
      mergeInference(decision);
      if (decision.done || !decision.next_question) {
        maybeFinish({ ...knownFields }, clipped);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: decision.next_question! },
        ]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read the file.");
    } finally {
      setThinking(false);
    }
  };

  return (
    <div className="animate-pop-in rounded-2xl bg-surface-raised p-5 shadow-sm ring-1 ring-habeet-500/30">
      {/* Header */}
      <div className="mb-4 flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-habeet-600" />
        <div>
          <h3 className="text-base font-bold text-gray-900 dark:text-gray-100">
            Quick questions first
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Answer a few things (or skip) and we&apos;ll build your roadmap for{" "}
            <span className="font-semibold">{topic.trim() || "your goal"}</span>
          </p>
        </div>
      </div>

      {/* v3: how many days will you need? (hidden when the task pre-sets them) */}
      {initialDays === null && (
        <div className="mb-3 flex items-center gap-3 rounded-xl border border-white/10 bg-surface px-3 py-2.5">
          <span className="flex-1 text-sm font-medium text-gray-200">
            How many days will you need to complete this?
          </span>
          <input
            type="number"
            min={1}
            max={60}
            value={daysInput}
            onChange={(e) => setDaysInput(e.target.value.replace(/\D/g, ""))}
            data-testid="days-input"
            aria-label="Days you will need"
            className="w-16 rounded-lg border border-white/10 bg-surface-raised px-2 py-1.5 text-center text-sm tabular-nums text-gray-100 outline-none transition focus:border-habeet-500"
          />
          <span className="text-xs text-gray-500">days</span>
        </div>
      )}

      {/* Prominent skip — visible at every step */}
      <button
        onClick={handleSkip}
        disabled={generating}
        className="btn-secondary mb-4 w-full px-3 py-2.5 text-sm"
        title="Generate right away with sensible defaults"
      >
        <Zap className="h-4 w-4" />
        Skip questions — auto-generate for me
      </button>

      {/* Resume upload */}
      {!resumeName ? (
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={thinking || generating}
          className="mb-3 flex w-full items-center gap-2 rounded-xl border border-dashed border-white/15 px-3 py-2.5 text-left text-sm text-gray-500 transition hover:border-habeet-400 hover:text-habeet-300 disabled:opacity-50 text-gray-500"
        >
          <FileText className="h-4 w-4 shrink-0" />
          <span>
            <span className="font-semibold">Optional:</span> upload your resume
            (.txt / .docx / .pdf) and we&apos;ll infer your level — one less
            question.
          </span>
        </button>
      ) : (
        <div className="mb-3 flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
          <FileText className="h-4 w-4 shrink-0" />
          <span className="flex-1 truncate font-medium">
            {resumeName} attached
          </span>
          <span className="text-xs opacity-75">level inferred ✓</span>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,.md,.csv,.docx,.pdf,text/plain,application/pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) handleResumeUpload(f);
        }}
      />

      {/* Conversation */}
      <div
        ref={scrollRef}
        className="mb-3 max-h-72 space-y-3 overflow-y-auto rounded-xl bg-surface p-3 ring-1 ring-white/5"
      >
        {messages.map((m, i) => (
          <div
            key={i}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm ${
                m.role === "user"
                  ? "rounded-br-sm bg-habeet-600 text-white"
                  : "rounded-bl-sm bg-surface-overlay text-gray-100 shadow-sm"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {thinking && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-surface-raised px-3.5 py-2 text-sm text-gray-400 shadow-sm ring-1 ring-white/5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Thinking…
            </div>
          </div>
        )}
        {generating && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-habeet-50 px-3.5 py-2 text-sm font-medium text-habeet-700 dark:bg-habeet-900/30 dark:text-habeet-300">
              <Sparkles className="h-4 w-4 animate-pulse" />
              Building your roadmap…
            </div>
          </div>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/30 dark:text-red-300"
        >
          {error}
        </p>
      )}

      {/* Answer input */}
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitAnswer();
          }}
          placeholder="Type your answer… (mention several things at once)"
          data-testid="intake-input"
          disabled={thinking || generating || messages.length === 0}
          className="flex-1 rounded-lg border border-white/10 bg-surface-overlay px-3 py-2 text-sm text-gray-100 outline-none transition focus:border-habeet-500 focus:ring-2 focus:ring-habeet-500/30 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        />
        <button
          onClick={submitAnswer}
          disabled={
            !input.trim() || thinking || generating || messages.length === 0
          }
          aria-label="Send answer"
          className="btn-primary px-4 py-2 text-sm"
        >
          <Send className="h-4 w-4" />
          Send
        </button>
        <button
          onClick={onCancel}
          aria-label="Cancel intake"
          className="btn-secondary px-3 py-2 text-sm"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
