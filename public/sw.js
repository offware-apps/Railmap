/**
 * Service Worker for Railmap PWA
 *
 * Scope: /Railmap/ (registered from that sub-path)
 *
 * Strategies:
 *  - Navigation requests  → network-first, fallback to cached shell
 *  - /data/*.json         → network-first, fallback to cache
 *  - Same-origin GET      → cache-first (hashed JS/CSS assets)
 *  - train-api *.json     → network-first, fallback to cache (offline timetable)
 *  - Other cross-origin / POST → passthrough, never cached
 */

// Bump on every release that changes the build output. A new value forces the SW to
// re-install and re-activate: the activate handler then deletes the previous cache
// and navigates any client stranded on a stale shell (the white-page failure mode)
// onto the freshly deployed one.
const CACHE_NAME = "maxjeune-v38";

// Minimal app shell — paths relative to the SW's scope (/Railmap/)
// Vite injects a hashed index.html in the build output at the base path.
// We store the scope root ("/Railmap/") as the shell fallback URL.
const SHELL_URL = self.registration.scope; // e.g. "https://host/Railmap/"

// Where the train-api timetable is served from (the `train-api` meta in index.html).
const TRAIN_API_ORIGIN = "https://offware-apps.github.io";

// ---------------------------------------------------------------------------
// Install — precache the app shell
// ---------------------------------------------------------------------------
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // cache:"reload" → precache a FRESH shell, never a stale HTTP-cached one.
      .then((cache) => cache.add(new Request(SHELL_URL, { cache: "reload" })))
      .then(() => self.skipWaiting())
  );
});

// ---------------------------------------------------------------------------
// Activate — delete stale caches, claim clients, and heal stuck clients.
// ---------------------------------------------------------------------------
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // If an older cache exists, this is an UPGRADE: a client may be stranded on
      // a stale shell pointing at a deleted bundle (the blank-page failure mode).
      const wasUpgrade = keys.some((k) => k !== CACHE_NAME);
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      await self.clients.claim();
      if (wasUpgrade) {
        // Force any open window onto the fresh shell. The page's own JS can't
        // self-heal when its bundle 404s, but the SW runs independently — so it
        // navigates the client itself. (No loop: the reloaded page is controlled
        // by this SW, so no further activate fires.)
        const clients = await self.clients.matchAll({ type: "window" });
        for (const client of clients) {
          try {
            await client.navigate(client.url);
          } catch {
            /* some browsers disallow navigate(); the network-first nav still heals on reload */
          }
        }
      }
    })()
  );
});

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle GET; let POST/PUT/etc pass through unchanged.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);

  // The train-api timetable replaces /data/*.json for most visitors, so keep the last
  // copy for offline use the same way (see trainApiBase in src/config.ts).
  if (url.origin === TRAIN_API_ORIGIN && url.pathname.startsWith("/train-api/") && url.pathname.endsWith(".json")) {
    event.respondWith(networkFirstWithCacheFallback(request));
    return;
  }

  // Never intercept other cross-origin requests (SNCF API, map tiles, etc.)
  if (url.origin !== scope.origin) return;

  const isSameOrigin = url.origin === scope.origin;

  if (!isSameOrigin) return; // redundant safety check

  // ----- Navigation requests: network-first → shell fallback ---------------
  if (request.mode === "navigate") {
    event.respondWith(networkFirstWithShellFallback(request));
    return;
  }

  // ----- /data/*.json: network-first → cache fallback ----------------------
  if (url.pathname.startsWith(scope.pathname + "data/") && url.pathname.endsWith(".json")) {
    event.respondWith(networkFirstWithCacheFallback(request));
    return;
  }

  // ----- Other same-origin GET (JS/CSS/fonts/images): cache-first ----------
  event.respondWith(cacheFirstThenNetwork(request));
});

// ---------------------------------------------------------------------------
// Strategy helpers
// ---------------------------------------------------------------------------

/**
 * Network-first. On failure, return cached shell.
 */
async function networkFirstWithShellFallback(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    // cache:"reload" bypasses the browser HTTP cache so the navigation always
    // gets the freshly deployed index.html — never a stale copy that points to
    // a hashed bundle that no longer exists (the "white page" failure mode).
    const networkResponse = await fetch(request, { cache: "reload" });
    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Last resort: serve the shell index
    const shell = await cache.match(SHELL_URL);
    return shell ?? new Response("Offline", { status: 503 });
  }
}

/**
 * Network-first. On failure, fall back to whatever is in the cache.
 */
async function networkFirstWithCacheFallback(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    const cached = await cache.match(request);
    return cached ?? new Response("Offline", { status: 503 });
  }
}

/**
 * Cache-first. On cache miss, fetch from network and populate cache.
 */
async function cacheFirstThenNetwork(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    return new Response("Offline", { status: 503 });
  }
}
