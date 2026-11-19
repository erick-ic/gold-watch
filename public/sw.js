const CACHE_NAME = 'goldwatch-v2';

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
    (async () => {
      // 页面必须优先获取最新 HTML，离线时才使用缓存，避免旧 bundle 长期驻留
      if (request.mode === 'navigate') {
        try {
          const response = await fetch(request);
          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put('./', response.clone());
          }
          return response;
        } catch {
          const cached = await caches.match('./');
          return cached || Response.error();
        }
      }

      // 带哈希的静态资源使用缓存优先
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});

// =============================================================
//  Web Push：接收 Worker Cron 推送，展示系统通知
// =============================================================

self.addEventListener('push', (event) => {
  console.log('[SW] push 事件收到！event.data =', event.data);
  let data = null;
  try {
    data = event.data?.json?.() ?? null;
    console.log('[SW] 解析后的 push data:', data);
  } catch (e) {
    console.error('[SW] event.data.json() 失败:', e);
  }

  event.waitUntil(
    (async () => {
      // 用户正在查看页面时由页面内的 toast/通知负责提醒，避免同一事件重复弹出
      // （DevTools 手工测试没有 data，仍然展示，便于排查）
      if (data && typeof data === 'object') {
        const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const focused = clientsList.some(
          (client) => client.focused && client.visibilityState === 'visible',
        );
        if (focused) {
          console.log('[SW] 页面正在前台，跳过系统通知');
          return;
        }
      }

      // DevTools 直接测试按钮发来的没有 data，给个默认通知方便调试
      if (!data || typeof data !== 'object') {
        console.warn('[SW] 没有有效 data，发送默认通知');
        await self.registration.showNotification('GoldWatch DevTools 测试 ✅', {
          body: '这条是 DevTools 直接触发的——如果看到了说明 SW 没问题',
          icon: './icons/icon-192.png',
          silent: false,
          requireInteraction: true,
        });
        return;
      }

      const { title = 'GoldWatch 到价提醒', body = '', tag } = data;
      console.log('[SW] 准备显示通知:', { title, body, tag });
      await self.registration.showNotification(title, {
        body,
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
        tag,
        silent: false,
        requireInteraction: true,
        data: { url: './' },
      });
    })().catch((e) => console.error('[SW] showNotification 失败:', e)),
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
