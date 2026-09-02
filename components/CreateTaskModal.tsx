"use client";

import { useEffect, useState } from "react";
import { Rocket, X } from "lucide-react";
import { istTodayKey, labelIST, shiftIST } from "@/lib/date-ist";

interface Props {
  onClose: () => void;
  onCreate: (
    name: string,
    description: string | undefined,
    durationDays: number
  ) => void;
}

const PRESETS = [1, 3, 7];

/** v5 — focused creation wizard (§15): name → duration → live range preview. */
export default function CreateTaskModal({ onClose, onCreate }: Props) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [days, setDays] = useState(7);
  const [custom, setCustom] = useState("");
  const [created, setCreated] = useState<{
    name: string;
    days: number;
    range: string;
  } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const effectiveDays = custom ? Math.max(1, Number(custom) || 1) : days;
  const start = istTodayKey();
  const deadline = shiftIST(start, effectiveDays - 1);
  const range = `${labelIST(start)} → ${labelIST(deadline)}`;

  const submit = () => {
    if (!name.trim()) return;
    onCreate(name, desc || undefined, effectiveDays);
    setCreated({ name: name.trim(), days: effectiveDays, range });
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Create practice task"
    >
      <div
        className="animate-pop-in w-full max-w-md rounded-2xl bg-surface-raised p-6 shadow-2xl ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        {!created ? (
          <>
            <div className="mb-5 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-gray-50">New Task</h2>
                <p className="mt-0.5 text-xs text-gray-500">
                  Day 1 starts today — no waiting around.
                </p>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="rounded-lg p-1 text-gray-500 transition hover:bg-white/5 hover:text-gray-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <label className="mb-1.5 block text-sm font-medium text-gray-200">
              What do you want to accomplish?
            </label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="e.g. Learn Django ORM"
              data-testid="ct-name"
              className="mb-4 w-full rounded-xl border border-white/10 bg-surface px-3 py-2.5 text-sm text-gray-100 placeholder-gray-500 outline-none transition focus:border-habeet-500 focus:ring-2 focus:ring-habeet-500/30"
            />

            <label className="mb-1.5 block text-sm font-medium text-gray-200">
              Details <span className="text-gray-500">(optional)</span>
            </label>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={2}
              placeholder="Scope, resources, notes…"
              data-testid="ct-desc"
              className="mb-4 w-full resize-none rounded-xl border border-white/10 bg-surface px-3 py-2.5 text-sm text-gray-100 placeholder-gray-500 outline-none transition focus:border-habeet-500 focus:ring-2 focus:ring-habeet-500/30"
            />

            <label className="mb-1.5 block text-sm font-medium text-gray-200">
              How many days will you take?
            </label>
            <div className="mb-2 flex flex-wrap gap-2">
              {PRESETS.map((p) => {
                const active = !custom && days === p;
                return (
                  <button
                    key={p}
                    onClick={() => {
                      setDays(p);
                      setCustom("");
                    }}
                    data-testid={`ct-days-${p}`}
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
              
            </div>

            <div className="mb-5 rounded-xl bg-habeet-500/10 px-3.5 py-3 ring-1 ring-habeet-500/25">
              <p
                data-testid="ct-range"
                className="text-sm font-semibold tabular-nums text-habeet-100"
              >
                {effectiveDays} Day{effectiveDays === 1 ? "" : "s"} — {range}
              </p>
              <p className="mt-0.5 text-[11px] text-gray-400">
                Miss the deadline and it&apos;s marked{" "}
                <span className="font-semibold text-amber-300">Overdue</span> —
                deadlines don&apos;t move.
              </p>
            </div>

            <button
              onClick={submit}
              disabled={!name.trim()}
              data-testid="ct-create"
              className="btn-primary w-full px-4 py-3 text-sm"
            >
              <Rocket className="h-4 w-4" />
              Create Task
            </button>
          </>
        ) : (
          <div className="flex flex-col items-center py-4 text-center">
            <span className="text-4xl">🎯</span>
            <h2 className="mt-3 text-lg font-bold text-gray-50">Task Created</h2>
            <p className="mt-1 text-sm font-semibold text-habeet-200">
              {created.name}
            </p>
            <p
              data-testid="ct-success-range"
              className="mt-1 text-sm tabular-nums text-gray-400"
            >
              {created.days} Days · {created.range}
            </p>
            <p className="mt-0.5 text-xs text-gray-500">Day 1 starts today.</p>
            <button
              onClick={() => {
                onClose();
                document
                  .getElementById("section-practice")
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              data-testid="ct-done"
              className="btn-primary mt-6 w-full px-4 py-3 text-sm"
            >
              Start Practicing
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
