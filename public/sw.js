// Dawn ZhConvert service worker — offline support with deploy freshness.
// Strategy (same-origin GETs only, only response.ok is ever cached):
//   - navigations / index.html: NETWORK-FIRST (a fresh deploy shows up
//     immediately; the cache is only an offline fallback)
//   - other assets (content-hashed JS/CSS, images, icons): STALE-WHILE-
//     REVALIDATE (hashed filenames make this safe)
// Bump CACHE_VERSION whenever this file's strategy changes.
const CACHE_VERSION = 'zhconvert-v1';
const INDEX_URL = '/index.html';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;

  const isNavigation = req.mode === 'navigate'
    || url.pathname === '/'
    || url.pathname.endsWith('/index.html');

  if (isNavigation) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const cache = await caches.open(CACHE_VERSION);
          cache.put(INDEX_URL, res.clone());
        }
        return res;
      } catch (err) {
        const cached = await caches.match(INDEX_URL);
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req);
    const network = fetch(req)
      .then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      })
      .catch(() => null);
    if (cached) {
      event.waitUntil(network.catch(() => {}));
      return cached;
    }
    const res = await network;
    return res || Response.error();
  })());
});
