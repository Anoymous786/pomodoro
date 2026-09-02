/**
 * public/sw.js — minimal hand-written service worker (Phase 7).
 *
 * Strategy (deliberately small — no workbox/next-pwa dependency):
 *   - Install: precache the app shell ("/" and "/architecture").
 *   - Navigate: network-first, fall back to the last cached page so the UI
 *     shell + last-cached view still open offline.
 *   - Static assets (/ _next/static, icon): cache-first (content-hashed URLs,
 *     safe to pin forever per version).
 *   - /api/*: NEVER cached. Data requires connectivity by design; failures
 *     surface through the app's normal error toasts.
 *
 * Bump VERSION to invalidate every client cache after a deploy.
 */
const VERSION = "v1";
const SHELL_CACHE = `pomodoro-shell-${VERSION}`;
const RUNTIME_CACHE = `pomodoro-runtime-${VERSION}`;
const SHELL_URLS = ["/", "/architecture"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        // addAll() fails atomically; add individually so one 404 can't break install.
        Promise.allSettled(SHELL_URLS.map((url) => cache.add(url)))
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // data needs connectivity

  // App navigation: network-first with cached-page fallback.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() =>
          caches
            .match(req)
            .then((hit) => hit || caches.match("/"))
        )
    );
    return;
  }

  // Hashed static assets: cache-first.
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname === "/icon.svg"
  ) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy));
            return res;
          })
      )
    );
  }
});