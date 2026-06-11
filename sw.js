// cx-portal Service Worker — desktop-first PWA shell with offline support.
// Strategy:
//  - Precache the app shell so the page boots offline.
//  - Runtime: stale-while-revalidate for same-origin static + Supabase Storage GETs
//    of PDFs and edit-state JSON; bypass everything else (auth, REST mutations, etc).
//  - CACHE_VERSION below is a baseline; the GitHub Pages deploy workflow
//    rewrites it to a unique per-commit value (cxp-<sha>) at deploy time,
//    so every deploy forces clients to fetch fresh assets. Manual bumps
//    here are no longer required.

const CACHE_VERSION = 'cxp-v67';
const SHELL_CACHE   = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './icons.js',
  './format.js',
  './cx-state.js',
  './compute.js',
  './app.js',
  './perms-admin.js',
  './markup.js',
  './photos.js',
  './data.js',
  './styles.css',
  './photos.css',
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

  // Same-origin shell: stale-while-revalidate. Serve the cached copy instantly
  // (fast, offline-capable) but ALWAYS refetch in the background and update the
  // cache, so a new deploy propagates on the next load — even if the service
  // worker itself is slow to update (a known iOS PWA problem). Cache-first
  // used to pin clients to a stale app.js indefinitely.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      if (cached) { network.catch(() => {}); return cached; }   // revalidate in bg
      const res = await network;
      if (res) return res;
      // Offline and uncached: hand back the cached index for navigations.
      if (req.mode === 'navigate') {
        const fallback = await caches.match('./index.html');
        if (fallback) return fallback;
      }
      throw new Error('offline');
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
