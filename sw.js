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

// =============================================================
//  Web Push：接收 Worker Cron 推送，展示系统通知
// =============================================================

self.addEventListener('push', (event) => {
  // event.data 已经是浏览器解密后的 PushMessageData
  const data = event.data?.json?.() ?? null;
  if (!data || typeof data !== 'object') return;

  const { title = 'GoldWatch 到价提醒', body = '', tag } = data;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag,
      silent: true,
      requireInteraction: false,
      data: { url: './' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  const targetUrl = notification.data?.url ?? './';
  notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // 优先聚焦已打开的页面
      for (const client of windowClients) {
        if (client.url.includes(self.location.host)) {
          return client.focus().then(() => client.navigate?.(targetUrl));
        }
      }
      // 没有打开的页面则新开
      return self.clients.openWindow(targetUrl);
    }),
  );
});
