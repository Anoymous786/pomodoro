"use client";

/**
 * ProgressRing — the app's single circular-progress primitive (§P1).
 * Used by the timer, roadmap day rows, and stat tiles so every
 * completion percentage reads identically. Purple accent only.
 * Animated SVG: stroke-dashoffset eases smoothly; when `active` the
 * ring gets a soft pulsing glow while a session is running.
 */
export interface ProgressRingProps {
  /** 0..1 — fraction complete. */
  progress: number;
  /** Rendered diameter in px (SVG scales via viewBox; CSS sizes the box). */
  size?: number;
  /** Stroke thickness in px. Defaults to ~8% of size, kept proportional. */
  strokeWidth?: number;
  /** Center label (e.g. "64%"). Omit for a bare ring. */
  label?: string;
  /** Small text under the label (e.g. "done"). */
  sublabel?: string;
  className?: string;
  title?: string;
  /** While running, animate the progress arc with a pulsing glow. */
  active?: boolean;
  /** Stroke color for accent variety (default = habeet/purple). */
  strokeClassName?: string;
}

export default function ProgressRing({
  progress,
  size = 40,
  strokeWidth,
  label,
  sublabel,
  className = "",
  title,
  active = false,
  strokeClassName = "stroke-habeet-500",
}: ProgressRingProps) {
  const sw = strokeWidth ?? Math.max(3, Math.round(size * 0.09));
  const r = (100 - sw) / 2; // viewBox is 100x100; stroke hugs the edge
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  const offset = c * (1 - clamped);

  return (
    <div
      className={`relative shrink-0 ${active ? "animate-ring-pulse" : ""} ${className}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={title ?? `${Math.round(clamped * 100)}% complete`}
      title={title}
    >
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
        {/* Track — lightest defined neutral, never transparent */}
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          strokeWidth={sw}
          className="stroke-surface-overlay"
        />
        {/* Animated progress arc — depletes smoothly; eased 600ms transition */}
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          strokeWidth={sw}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          className={`${strokeClassName} transition-[stroke-dashoffset] duration-500 ease-spring`}
          style={{ filter: active ? "drop-shadow(0 0 6px rgba(139,92,246,0.6))" : undefined }}
        />
      </svg>
      {label !== undefined && (
        <span className="absolute inset-0 flex flex-col items-center justify-center leading-none">
          <span
            className="font-semibold tabular-nums text-gray-100"
            style={{ fontSize: Math.max(9, Math.round(size * 0.28)) }}
          >
            {label}
          </span>
          {sublabel && (
            <span
              className="mt-0.5 text-gray-400"
              style={{ fontSize: Math.max(7, Math.round(size * 0.17)) }}
            >
              {sublabel}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
