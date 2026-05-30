// Reading Room — Service Worker
// Cache version: bump this string to force all clients to update
const CACHE = 'reading-room-v1';

// App shell: files we cache on install for offline use
const SHELL = [
  './',
  './index.html',
  './icon.svg',
  './manifest.json',
  // Fonts
  'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400;1,600&family=Lora:ital,wght@0,400;0,500;1,400&family=IM+Fell+English+SC&display=swap',
  // Barcode scanner library
  'https://unpkg.com/@zxing/library@0.19.1/umd/index.min.js',
];

// ── Install: cache the app shell ──────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches ────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: serve from cache, fall back to network ────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always go to network for API calls (book lookups, cover images, Gist sync)
  const isApi = url.hostname.includes('openlibrary.org') ||
                url.hostname.includes('covers.openlibrary.org') ||
                url.hostname.includes('api.github.com') ||
                url.hostname.includes('fonts.gstatic.com'); // font files vary

  if (isApi) {
    e.respondWith(
      fetch(e.request).catch(() => new Response('', { status: 503 }))
    );
    return;
  }

  // Cache-first for everything else (app shell, fonts CSS, ZXing)
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});
