"use client";

import { Check } from "lucide-react";

/**
 * CircleCheckbox — every "mark done" affordance in the app (§0).
 * Unchecked = neutral outlined circle · Checked = solid purple circle
 * with a white checkmark. Renders a real <button> for a11y.
 */
export default function CircleCheckbox({
  checked,
  onChange,
  label,
  disabled = false,
  size = 22,
  ...rest
}: {
  checked: boolean;
  onChange: () => void;
  /** Accessible name, e.g. the task title. */
  label: string;
  disabled?: boolean;
  size?: number;
  [key: string]: unknown;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      style={{ width: size, height: size }}
      {...rest}
      className={`flex shrink-0 items-center justify-center rounded-full border-2 outline-none transition-all duration-150 focus-visible:ring-2 focus-visible:ring-habeet-400/70 active:scale-90 disabled:cursor-not-allowed disabled:opacity-40 ${
        checked
          ? "border-habeet-500 bg-habeet-500 hover:bg-habeet-400 hover:border-habeet-400"
          : "border-gray-500 bg-transparent hover:border-habeet-400 hover:bg-habeet-500/10"
      }`}
    >
      {checked && (
        <Check
          strokeWidth={3.5}
          className="text-white"
          style={{ width: size * 0.55, height: size * 0.55 }}
        />
      )}
    </button>
  );
}
