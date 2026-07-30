// Reading Room — Service Worker
// Cache version: bump this string to force all clients to update
const CACHE = 'reading-room-v4';

// App shell: local files that MUST cache on install for offline use
const SHELL = [
  './',
  './index.html',
  './icon.svg',
  './icon-maskable.svg',
  './manifest.json',
];

// External extras: cache if reachable, but never fail the install over them
// (they're also picked up by the cache-first fetch handler on first use)
const SHELL_EXTERNAL = [
  // Fonts
  'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400;1,600&family=Lora:ital,wght@0,400;0,500;1,400&family=IM+Fell+English+SC&display=swap',
  // Barcode scanner library
  'https://unpkg.com/@zxing/library@0.19.1/umd/index.min.js',
];

// ── Install: cache the app shell ──────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(async c => {
        await c.addAll(SHELL);
        await Promise.allSettled(SHELL_EXTERNAL.map(u => c.add(u)));
      })
      .then(() => self.skipWaiting())
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

  // Cover images are immutable once fetched — cache them so the library still
  // has its artwork offline. They used to fall into the API branch below and
  // 503 whenever the network was gone, leaving every card blank.
  if (url.hostname === 'covers.openlibrary.org') {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        }).catch(() => new Response('', { status: 503 }));
      })
    );
    return;
  }

  // Always go to network for live API calls (book lookups, Gist sync)
  const isApi = url.hostname.includes('openlibrary.org') ||
                url.hostname.includes('api.github.com') ||
                url.hostname.includes('fonts.gstatic.com'); // font files vary

  if (isApi) {
    e.respondWith(
      fetch(e.request).catch(() => new Response('', { status: 503 }))
    );
    return;
  }

  // Network-first for the page itself so new deploys reach installed clients
  // without a cache-version bump; fall back to the cached copy when offline.
  const isShellPage = e.request.mode === 'navigate' || url.pathname.endsWith('/index.html');
  if (isShellPage) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() =>
        caches.match(e.request).then(cached => cached || caches.match('./index.html'))
      )
    );
    return;
  }

  // Cache-first for static assets (icon, manifest, fonts CSS, ZXing)
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
