/* ==========================================================================
 * Caseload Manager — sw.js
 * Minimal offline app-shell cache. Bump CACHE_VERSION to force an update.
 * No user data is ever cached or transmitted; only the static app files.
 * ========================================================================== */
const CACHE_VERSION = 'caseload-shell-v81';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      // Fetch each shell file bypassing the HTTP cache so a versioned deploy
      // always snapshots the current files (addAll could reuse stale responses).
      .then((cache) => Promise.all(
        APP_SHELL.map((url) =>
          fetch(new Request(url, { cache: 'reload' })).then((response) => {
            if (!response.ok) throw new Error('Precache failed: ' + url);
            return cache.put(url, response);
          })
        )
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  // Cache-first for same-origin app files; network fallback for the rest.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          // Cache same-origin successful responses opportunistically.
          if (response.ok && new URL(request.url).origin === self.location.origin) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
