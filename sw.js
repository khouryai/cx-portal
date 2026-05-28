// cx-portal Service Worker — desktop-first PWA shell with offline support.
// Strategy:
//  - Precache the app shell so the page boots offline.
//  - Runtime: stale-while-revalidate for same-origin static + Supabase Storage GETs
//    of PDFs and edit-state JSON; bypass everything else (auth, REST mutations, etc).
//  - Bump CACHE_VERSION to force clients to upgrade.

const CACHE_VERSION = 'cxp-v11';
const SHELL_CACHE   = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './app.js',
  './data.js',
  './styles.css',
  './chart.umd.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Best-effort: don't fail install if a single asset is missing.
    await Promise.allSettled(SHELL_ASSETS.map(u => cache.add(new Request(u, { cache: 'reload' }))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !k.startsWith(CACHE_VERSION)).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

function isSupabaseStorageGet(url) {
  // Cache PDF + edit-state JSON GETs only.
  return /\/storage\/v1\/object\//.test(url.pathname) && /\.(pdf|json)$/.test(url.pathname);
}

function isCdnAsset(url) {
  return /(^|\.)jsdelivr\.net$/.test(url.hostname) || /(^|\.)cloudflare\.com$/.test(url.hostname);
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then((res) => {
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => cached);
  return cached || fetchPromise;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Same-origin shell: try cache, then network.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && res.ok && (req.destination === 'script' || req.destination === 'style' || req.destination === 'document' || req.destination === 'font')) {
          const cache = await caches.open(SHELL_CACHE);
          cache.put(req, res.clone());
        }
        return res;
      } catch {
        // Last-resort: hand back the cached index for navigations.
        if (req.mode === 'navigate') {
          const fallback = await caches.match('./index.html');
          if (fallback) return fallback;
        }
        throw new Error('offline');
      }
    })());
    return;
  }

  // Supabase Storage GETs (PDFs + edit-state JSON): stale-while-revalidate.
  if (isSupabaseStorageGet(url)) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // CDN libs: stale-while-revalidate.
  if (isCdnAsset(url)) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Everything else: network only.
});
