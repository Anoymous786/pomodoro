"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  FileText,
  Loader2,
  Send,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import { IntakeContext } from "@/lib/types";

interface IntakeFlowProps {
  /** Topic the user typed in the board before opening the flow. */
  topic: string;
  /** True while the parent is generating the roadmap. */
  generating: boolean;
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

/** Sensible defaults used by the prominent skip button. */
function defaultContext(topic: string): IntakeContext {
  return {
    topic,
    time_available: "About 1 hour per day",
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
        .replace(/\\[rn]/g, " ")
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
  onCancel,
  onComplete,
}: IntakeFlowProps) {
  const [messages, setMessages] = useState<IntakeTurn[]>([]);
  const [knownFields, setKnownFields] = useState<Partial<IntakeContext>>({});
  const [resumeText, setResumeText] = useState<string | null>(null);
  const [resumeName, setResumeName] = useState<string | null>(null);
  const [input, setInput] = useState("");
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
      resume: string | null
    ) => {
      const res = await fetch("/api/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic,
          history,
          knownFields: known,
          ...(resume ? { resumeText: resume } : {}),
        }),
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
    [topic]
  );

  /** Fires roadmap generation exactly once with everything gathered. */
  const finalize = useCallback(
    (known: Partial<IntakeContext>, resume: string | null) => {
      if (finished.current) return;
      finished.current = true;
      const finalTopic = topic.trim() || "New skill";
      const context: IntakeContext = {
        ...defaultContext(finalTopic),
        ...known,
        topic: finalTopic,
        ...(resume ? { resumeText: resume } : {}),
      };
      onComplete(finalTopic, context);
    },
    [onComplete, topic]
  );

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
    []
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
          finalize({}, null);
        } else {
          setMessages([{ role: "assistant", content: decision.next_question }]);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Could not start the intake."
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
    setMessages(nextHistory);
    setInput("");
    setThinking(true);
    setError(null);
    turnCount.current += 1;
    try {
      // Safety cap reached → stop asking and generate now (never surfaced).
      if (turnCount.current >= MAX_TURNS) {
        finalize(knownFields, resumeText);
        return;
      }
      const decision = await askNextQuestion(
        nextHistory,
        knownFields,
        resumeText
      );
      mergeInference(decision);
      if (decision.done || !decision.next_question) {
        finalize(knownFields, resumeText);
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
    finalize(knownFields, resumeText);
  };

  const handleResumeUpload = async (file: File) => {
    setError(null);
    let clipped = "";
    try {
      const text = await readFileText(file);
      if (!text || text.replace(/\s+/g, "").length < 80) {
        throw new Error(
          "We couldn't read enough text from that file. Try a .txt export instead."
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
        finalize({ ...knownFields }, clipped);
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
    <div className="animate-pop-in rounded-2xl border border-tomato-200 bg-white p-5 shadow-sm dark:border-tomato-800 dark:bg-gray-800">
      {/* Header */}
      <div className="mb-4 flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-tomato-600" />
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

      {/* Prominent skip — visible at every step */}
      <button
        onClick={handleSkip}
        disabled={generating}
        className="mb-4 flex w-full items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-amber-500 to-orange-500 px-3 py-2.5 text-sm font-bold text-white shadow transition hover:from-amber-600 hover:to-orange-600 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
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
          className="mb-3 flex w-full items-center gap-2 rounded-xl border border-dashed border-gray-300 px-3 py-2.5 text-left text-sm text-gray-500 transition hover:border-tomato-400 hover:text-tomato-600 disabled:opacity-50 dark:border-gray-600 dark:text-gray-400"
        >
          <FileText className="h-4 w-4 shrink-0" />
          <span>
            <span className="font-semibold">Optional:</span> upload your resume
            (.txt / .pdf) and we&apos;ll infer your level — one less question.
          </span>
        </button>
      ) : (
        <div className="mb-3 flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
          <FileText className="h-4 w-4 shrink-0" />
          <span className="flex-1 truncate font-medium">{resumeName} attached</span>
          <span className="text-xs opacity-75">level inferred ✓</span>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,.md,.pdf,text/plain,application/pdf"
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
        className="mb-3 max-h-72 space-y-3 overflow-y-auto rounded-xl bg-gray-50 p-3 dark:bg-gray-900"
      >
        {messages.map((m, i) => (
          <div
            key={i}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm ${m.role === "user"
                ? "rounded-br-sm bg-tomato-600 text-white"
                : "rounded-bl-sm bg-white text-gray-800 shadow-sm dark:bg-gray-800 dark:text-gray-100"
                }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {thinking && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-white px-3.5 py-2 text-sm text-gray-400 shadow-sm dark:bg-gray-800">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Thinking…
            </div>
          </div>
        )}
        {generating && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-tomato-50 px-3.5 py-2 text-sm font-medium text-tomato-700 dark:bg-tomato-900/30 dark:text-tomato-300">
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
          disabled={thinking || generating || messages.length === 0}
          className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-tomato-500 focus:ring-2 focus:ring-tomato-500/30 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        />
        <button
          onClick={submitAnswer}
          disabled={
            !input.trim() || thinking || generating || messages.length === 0
          }
          aria-label="Send answer"
          className="flex items-center gap-1.5 rounded-lg bg-tomato-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-tomato-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Send className="h-4 w-4" />
          Send
        </button>
        <button
          onClick={onCancel}
          aria-label="Cancel intake"
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-500 transition hover:bg-gray-50 active:scale-95 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-700"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
