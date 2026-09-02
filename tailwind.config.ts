import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        /** Habeet dark-purple accent scale — the ONE accent family. */
        habeet: {
          50: "#f5f3ff",
          100: "#ede9fe",
          200: "#ddd6fe",
          300: "#c4b5fd",
          400: "#a78bfa",
          500: "#8b5cf6",
          600: "#7c3aed",
          700: "#6d28d9",
          800: "#5b21b6",
          900: "#4c1d95",
          950: "#2e1065",
        },
        /** Secondary accent — amber/teal for variety (§P1). */
        amberAccent: {
          50: "#fffbeb",
          100: "#fef3c7",
          200: "#fde68a",
          300: "#fcd34d",
          400: "#fbbf24",
          500: "#f59e0b",
          600: "#d97706",
          700: "#b45309",
          800: "#92400e",
          900: "#78350f",
          950: "#451a03",
        },
        tealAccent: {
          50: "#f0fdfa",
          100: "#ccfbf1",
          200: "#99f6e4",
          300: "#5eead4",
          400: "#2dd4bf",
          500: "#14b8a6",
          600: "#0d9488",
          700: "#0f766e",
          800: "#115e59",
          900: "#134e4a",
          950: "#042f2e",
        },
        /** Neutral dark surfaces (purple-tinted) for nesting levels. */
        surface: {
          DEFAULT: "#100e18",
          raised: "#18152a",
          overlay: "#221c3a",
        },
        /**
         * Heatmap intensity scale (§4.1/v2 Fix 3) — five VISIBLY distinct
         * steps on the dark card background: neutral no-activity gray +
         * four purple shades light→saturated. The grid and the Less→More
         * legend MUST both use these tokens so they can never diverge.
         */
        heat: {
          0: "#2a2740", // no activity — neutral, clearly lighter than surface
          1: "#453a6b", // lightest purple step
          2: "#5f4aa8",
          3: "#7f5ff0",
          4: "#a98bff", // most saturated step
        },
      },
      boxShadow: {
        card: "0 4px 24px rgba(0,0,0,0.45), 0 1px 3px rgba(0,0,0,0.30)",
        "card-hover": "0 12px 40px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.35)",
        glow: "0 0 40px rgba(124,58,237,0.25), 0 0 80px rgba(124,58,237,0.10)",
        "glow-amber": "0 0 32px rgba(245,158,11,0.20), 0 0 64px rgba(245,158,11,0.08)",
      },
      borderRadius: {
        card: "1.125rem",
        "card-lg": "1.25rem",
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['"Inter"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "pop-in": {
          "0%": { opacity: "0", transform: "scale(0.95)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        "toast-in": {
          "0%": { opacity: "0", transform: "translateX(110%)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        "toast-out": {
          "0%": { opacity: "1", transform: "translateX(0)" },
          "100%": { opacity: "0", transform: "translateX(110%)" },
        },
        "ring-pulse": {
          "0%, 100%": { filter: "drop-shadow(0 0 4px rgba(139,92,246,0.4))" },
          "50%": { filter: "drop-shadow(0 0 14px rgba(139,92,246,0.7))" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.3s ease-out",
        "pop-in": "pop-in 0.2s ease-out",
        "toast-in": "toast-in 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
        "toast-out": "toast-out 0.2s ease-in",
        "ring-pulse": "ring-pulse 2s ease-in-out infinite",
      },
      transitionTimingFunction: {
        "press": "cubic-bezier(0.4, 0, 0.2, 1)",
        "spring": "cubic-bezier(0.16, 1, 0.3, 1)",
      },
      transitionDuration: {
        150: "150ms",
        "press": "150ms",
      },
    },
  },
  plugins: [],
};

export default config;