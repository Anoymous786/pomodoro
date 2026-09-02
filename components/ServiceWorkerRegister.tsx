"use client";

import { useEffect } from "react";

/**
 * Registers the hand-written service worker (/public/sw.js) in production
 * builds only — `next dev` HMR must never be intercepted by a cache.
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        // PWA is a progressive enhancement; never surface registration noise.
        console.debug("Service worker registration skipped:", err);
      });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}