// Offline shell, so the app still opens (and can queue shares) with no internet. Supabase calls are
// cross-origin and pass straight through.
const CACHE = "gleaner-shell-v1";
const EXTRA = ["/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

// shortcut: the asset list is scraped from the page HTML, so a lazy-loaded chunk is cached only
// after its first use; switch to a build-time precache list when the app has more than one page.
async function precache() {
  const cache = await caches.open(CACHE);
  const res = await fetch("/", { cache: "no-store" });
  if (!res.ok) return;
  const html = await res.clone().text();
  const assets = new Set(html.match(/\/_next\/static\/[^"'\\\s<>]+/g) || []);
  await Promise.all([
    // Hashed file names never change content, so one download is enough.
    ...[...assets].map(async (url) => (await cache.match(url)) || cache.add(url)),
    // Fixed names (manifest, icons) are re-fetched, or an edited manifest would never reach the phone.
    ...EXTRA.map((url) => cache.add(new Request(url, { cache: "no-store" }))),
  ]);
  // Stored last, so the cached page never points at assets that are not cached yet.
  await cache.put("/", res);
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/")
  ) {
    return;
  }
  const isPage = event.request.mode === "navigate";
  event.respondWith(
    (async () => {
      // Pages go network-first, so a new deploy shows on the first load; the cached shell
      // (one for every URL, including a share /?text=...) is the offline fallback.
      if (isPage) {
        event.waitUntil(precache().catch(() => {}));
        try {
          return await fetch(event.request);
        } catch {
          return (await caches.match("/")) || Response.error();
        }
      }
      const cached = await caches.match(event.request);
      if (cached) return cached;
      const res = await fetch(event.request);
      if (res.ok && url.pathname.startsWith("/_next/static/")) {
        const cache = await caches.open(CACHE);
        event.waitUntil(cache.put(event.request, res.clone()));
      }
      return res;
    })(),
  );
});
