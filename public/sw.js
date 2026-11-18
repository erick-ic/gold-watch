const CACHE_NAME = 'goldwatch-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(['./'])),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // 行情接口与跨域请求始终走网络
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) return;

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      const fetched = fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          if (request.mode === 'navigate') {
            return caches.match('./').then((fallback) => fallback || Response.error());
          }
          return cached || Response.error();
        });
      return cached || fetched;
    }),
  );
});
