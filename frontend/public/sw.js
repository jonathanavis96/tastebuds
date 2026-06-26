// TasteBuds service worker — makes the app installable + resilient offline over
// Tailscale. Strategy:
//   - navigations: network-first (so deploys land immediately), cached shell offline
//   - dynamic API data (/api/* except posters): never cached — must stay live
//   - cached posters (/api/poster/*), hashed JS/CSS, icons: cache-first
// Bump CACHE to invalidate everything on a breaking change.
const CACHE = 'tastebuds-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // App shell: network-first, fall back to the cached entry document offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('/', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match('/')) ?? Response.error();
      }
    })());
    return;
  }

  // Live API data must never be served stale (recommendations, watchlist, etc.).
  if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/poster/')) return;

  // Hashed assets, icons, and cached posters: cache-first, populate on first fetch.
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    const res = await fetch(req);
    if (res.ok && (res.type === 'basic' || res.type === 'default')) {
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone());
    }
    return res;
  })());
});
