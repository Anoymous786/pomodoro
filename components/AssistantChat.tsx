"use client";

import { useState } from "react";
import { Bot, Loader2, MessageCircle, Send, X } from "lucide-react";
import { apiPost } from "@/lib/api";
import type { PracticeTask, RoadmapExamResult, SkillProfile } from "@/lib/types";
import { prettyLabel } from "@/lib/skills";
import { buildMonitoringContext } from "@/lib/monitoring";

/** §13/§6 grounding data the chat can answer from. */
export interface ChatGrounding {
  skillProfiles: Record<string, SkillProfile>;
  roadmapExamResults: Record<string, RoadmapExamResult>;
  practiceTasks: {
    id: string;
    name: string;
    durationDays: number;
    is_completed?: boolean;
    roadmap?: import("@/lib/types").RoadmapStep[];
    assessment?: import("@/lib/types").TaskAssessment;
  }[];
}

interface Msg {
  role: "user" | "assistant";
  content: string;
}

/** Builds the JSON grounding context describing the user's REAL tracked data. */
export function buildChatContext(g: ChatGrounding): string {
  const profiles = Object.values(g.skillProfiles ?? {}).map(
    (p) =>
      `${p.label}: ${p.score}% (${p.examsTaken} exam${p.examsTaken === 1 ? "" : "s"})`,
  );
  const completedTopics = (g.practiceTasks ?? [])
    .filter((t) => t.is_completed)
    .map((t) => `${t.name} (${t.durationDays} days)`);
  const recentExams = Object.values(g.roadmapExamResults ?? {}).map((r) => {
    const first = Object.keys(r.breakdown ?? {})[0];
    const label = first ? prettyLabel(first) : "Roadmap exam";
    return `${label}: ${r.score}/${r.total} (${r.pct}%)`;
  });
  // Phase 2: structured, token-efficient per-task learning monitoring.
  const monitoring = buildMonitoringContext(g.practiceTasks as PracticeTask[] | undefined);
  return JSON.stringify({
    skill_profiles: profiles,
    completed_topics: completedTopics,
    recent_exams: recentExams,
    learning_progress: JSON.parse(monitoring),
  });
}
interface AssistantChatProps {
  grounding: ChatGrounding;
}

/**
 * §6 in-app assistant chatbot (floating widget). Answers are grounded in the
 * user's real stored skill profile + task/exam history via /api/chat. When a
 * topic has no tracked data, the model is instructed to say so honestly rather
 * than guess.
 */
export default function AssistantChat({ grounding }: AssistantChatProps) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([
    {
      role: "assistant",
      content:
        "Hi! I can answer how much you know in a topic, review your tracked skills, or help you prep — grounded in your real progress here.",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (text: string) => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setInput("");
    setError(null);
    const next: Msg[] = [...msgs, { role: "user", content: prompt }];
    setMsgs(next);
    setBusy(true);
    try {
      const res = await apiPost("/api/chat", {
        messages: next,
        context: buildChatContext(grounding),
      });
      const data = (await res.json()) as { reply?: string; error?: string };
      if (!res.ok || !data.reply) {
        throw new Error(data.error ?? "The assistant could not respond.");
      }
      setMsgs((m) => [
        ...m,
        { role: "assistant", content: data.reply as string },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Assistant unavailable.");
      setMsgs((m) => [
        ...m,
        {
          role: "assistant",
          content:
            "I couldn't reach the assistant just now. Please try again in a moment.",
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* Launcher */}
      <button
        onClick={() => setOpen((o) => !o)}
        data-testid="chat-launcher"
        aria-label={open ? "Close assistant" : "Open assistant"}
        className="fixed bottom-5 right-5 z-40 flex items-center justify-center rounded-full bg-habeet-600 text-white shadow-xl transition hover:bg-habeet-700"
        style={{ width: 52, height: 52 }}
      >
        {open ? (
          <X className="h-5 w-5" />
        ) : (
          <MessageCircle className="h-5 w-5" />
        )}
      </button>

      {/* Panel */}
      {open && (
        <div
          data-testid="chat-panel"
          className="fixed bottom-20 right-5 z-40 flex h-[480px] w-[92vw] max-w-sm flex-col overflow-hidden rounded-2xl border border-white/10 bg-surface shadow-2xl"
        >
          <div className="flex items-center gap-2 border-b border-white/10 bg-surface-raised px-4 py-3">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-habeet-500/15 text-habeet-300 ring-1 ring-habeet-400/30">
              <Bot className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-50">
                Study assistant
              </p>
              <p className="text-[11px] text-gray-500">
                Grounded in your tracked skill data
              </p>
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close assistant"
              className="ml-auto rounded-md p-1 text-gray-400 outline-none transition hover:bg-white/5"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {msgs.map((m, i) => (
              <div
                key={i}
                className={`max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm leading-snug ${
                  m.role === "user"
                    ? "ml-auto bg-habeet-600 text-white"
                    : "bg-surface-overlay/60 text-gray-200 ring-1 ring-white/5"
                }`}
              >
                {m.content}
              </div>
            ))}
            {busy && (
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
              </div>
            )}
            {error && <p className="text-xs text-amber-300">{error}</p>}
          </div>

          <div className="flex items-center gap-2 border-t border-white/10 p-3">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void send(input);
              }}
              placeholder="e.g. how much do I know in React?"
              data-testid="chat-input"
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-surface-overlay/40 px-3 py-2 text-sm text-gray-100 outline-none placeholder:text-gray-500 focus:border-habeet-500"
            />
            <button
              onClick={() => void send(input)}
              disabled={!input.trim() || busy}
              data-testid="chat-send"
              aria-label="Send"
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-habeet-600 text-white transition hover:bg-habeet-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
