"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Rocket, X } from "lucide-react";
import { usePomodoro } from "@/hooks/usePomodoro";
import { istTodayKey, labelIST, shiftIST } from "@/lib/date-ist";

const PRESETS = [1, 3, 7, 14, 30];

/**
 * /task/new — the blank "New Task" workspace.
 *
 * Like starting a new chat: opening this route shows NOTHING from previous
 * tasks — no lists, no roadmaps, no history. The user names the task, adds
 * an optional description and picks how many days they expect it to take.
 * Day 1 starts today (Asia/Kolkata); the deadline is derived automatically.
 * Creating the task navigates straight into its dedicated workspace
 * (/task/[id]).
 */
export default function NewTaskPage() {
  const router = useRouter();
  const { addPracticeTask, hydrated } = usePomodoro();

  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [days, setDays] = useState(7);
  const [custom, setCustom] = useState("");
  const [creating, setCreating] = useState(false);

  // Escape always returns to the dashboard (nothing to save on a blank slate).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") router.push("/");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  const effectiveDays = custom ? Math.max(1, Number(custom) || 1) : days;

  // IST date math: Day 1 is TODAY; deadline = start + duration - 1.
  const start = istTodayKey();
  const deadline = shiftIST(start, effectiveDays - 1);
  const range = `${labelIST(start)} → ${labelIST(deadline)}`;

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    const id = addPracticeTask(trimmed, desc.trim() || undefined, effectiveDays);
    if (!id) {
      setCreating(false);
      return;
    }
    // Open the newly created task's dedicated workspace immediately.
    router.push(`/task/${id}`);
  };

    return (
    <main className="flex min-h-screen w-full flex-col items-center bg-gradient-to-b from-gray-950 to-gray-900 px-4 pt-8">
      {/* Top bar — only a way back; no previous task content anywhere. */}
      <div className="mb-8 flex w-full max-w-3xl items-center justify-between">
        <Link
          href="/"
          data-testid="newtask-back"
          className="flex items-center gap-2 rounded-full border border-white/10 bg-surface-raised px-4 py-2 text-sm font-semibold text-gray-300 outline-none transition hover:bg-surface-overlay hover:text-gray-100 active:scale-95"
        >
          <ArrowLeft className="h-4 w-4" />
          Dashboard
        </Link>
        <button
          onClick={() => router.push("/")}
          aria-label="Close new task workspace"
          className="rounded-lg p-2 text-gray-500 transition hover:bg-white/5 hover:text-gray-200"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {/* Full-screen blank-slate form — no surrounding card so the workspace
          feels like a fresh chat with only the form and whitespace visible. */}
      <div className="w-full max-w-3xl">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-gray-50">New Task</h1>
          <p
            data-testid="newtask-blank-hint"
            className="mt-2 text-base text-gray-500"
          >
            A fresh workspace — nothing here yet. Day 1 starts today.
          </p>
        </div>

        <label
          htmlFor="nt-name"
          className="mb-1.5 block text-sm font-medium text-gray-200"
        >
          Task name
        </label>
        <input
          id="nt-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="e.g. Django"
          data-testid="ct-name"
          disabled={creating}
          className="mb-4 w-full rounded-xl border border-white/10 bg-surface-raised px-4 py-3 text-sm text-gray-100 placeholder-gray-500 outline-none transition focus:border-habeet-500 focus:ring-2 focus:ring-habeet-500/30"
        />

          <label
            htmlFor="nt-desc"
            className="mb-1.5 block text-sm font-medium text-gray-200"
          >
            Description <span className="text-gray-500">(optional)</span>
          </label>
          <textarea
            id="nt-desc"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="What outcome do you want? Any constraints?"
            rows={2}
            data-testid="ct-desc"
            disabled={creating}
            className="mb-4 w-full resize-none rounded-xl border border-white/10 bg-surface-raised px-3 py-2.5 text-sm text-gray-100 placeholder-gray-500 outline-none transition focus:border-habeet-500 focus:ring-2 focus:ring-habeet-500/30"
          />

          <label className="mb-1.5 block text-sm font-medium text-gray-200">
            How many days do you expect it to take?
          </label>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {PRESETS.map((p) => {
              const active = !custom && days === p;
              return (
                <button
                  key={p}
                  onClick={() => {
                    setDays(p);
                    setCustom("");
                  }}
                  disabled={creating}
                  data-testid={`ct-days-${p}`}
                  aria-pressed={active}
                  className={`rounded-xl px-3 py-1.5 text-xs font-semibold tabular-nums outline-none transition focus-visible:ring-2 focus-visible:ring-habeet-400 ${
                    active
                      ? "bg-habeet-600 text-white shadow-lg shadow-habeet-600/30"
                      : "border border-white/15 text-gray-300 hover:bg-white/5"
                  }`}
                >
                  {p} day{p === 1 ? "" : "s"}
                </button>
              );
            })}
            <input
              type="number"
              min={1}
              max={60}
              value={custom}
              onChange={(e) => setCustom(e.target.value.replace(/\D/g, ""))}
              placeholder="Custom"
              aria-label="Custom days"
              data-testid="ct-days-custom"
              disabled={creating}
              className="w-20 rounded-xl border border-white/10 bg-surface-raised px-2 py-1.5 text-center text-xs tabular-nums text-gray-100 placeholder-gray-600 outline-none focus:border-habeet-500"
            />
          </div>

          {/* Live deadline preview — computed from IST today + duration. */}
          <div className="mb-5 rounded-xl bg-habeet-500/10 px-3.5 py-3 ring-1 ring-habeet-500/25">
            <p
              data-testid="ct-range"
              className="text-sm font-semibold tabular-nums text-habeet-100"
            >
              {effectiveDays} Day{effectiveDays === 1 ? "" : "s"} — {range}
            </p>
            <p className="mt-0.5 text-[11px] text-gray-400">
              Day 1 starts today · deadline calculated for you.
            </p>
          </div>

          <button
            onClick={submit}
            disabled={!name.trim() || creating || !hydrated}
            data-testid="ct-create"
            className="btn-primary w-full px-4 py-3 text-sm"
          >
            <Rocket className="h-4 w-4" />
            {creating ? "Creating…" : "Create Task"}
          </button>
        </div>  {/* closes max-w-3xl form container */}
    </main>
  );
}