import type { MetadataRoute } from "next";

/**
 * PWA web app manifest (Phase 7). Next.js serves this at /manifest.webmanifest
 * and injects <link rel="manifest"> automatically.
 *
 * Icons: the app ships a single SVG mark (app/icon.svg -> served at /icon.svg).
 * "sizes": "any" lets Chromium treat the scalable SVG as valid for
 * installability without shipping heavy multi-size PNGs (bundle stays lean).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Pomodoro Focus & Productivity Dashboard",
    short_name: "Pomodoro",
    description:
      "Focus timer, task manager, AI learning roadmaps, and productivity insights.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#dc2626",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}