const CACHE_VERSION = 'flood-crisis-management-shell-v4';
const APP_SHELL = [
  '/',
  '/crisis.html',
  '/mongo-collab.js?v=4.3.0',
  '/manifest.webmanifest',
  '/branding/flood-crisis-management-logo.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_VERSION).then(cache => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_VERSION).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put('/crisis.html', copy));
          return response;
        })
        .catch(() => caches.match('/crisis.html'))
    );
    return;
  }

  if (url.pathname === '/mongo-collab.js') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) caches.open(CACHE_VERSION).then(cache => cache.put(request, response.clone()));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok) caches.open(CACHE_VERSION).then(cache => cache.put(request, response.clone()));
      return response;
    }))
  );
});
