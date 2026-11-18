/** 前端 Web Push 订阅与 Worker API 对接 */

import { apiUrl } from './api';

// VAPID 公钥（从 .env.production 编译时注入）
const VAPID_PUB_B64: string = (import.meta.env.VITE_VAPID_PUB as string | undefined) ?? '';

/**
 * Base64url（无 padding）→ Uint8Array
 * 用于 PushManager.subscribe({ applicationServerKey })
 */
function base64UrlToBytes(input: string): Uint8Array {
  let s = input.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** 是否支持 Push API + Service Worker */
export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'serviceWorker' in navigator &&
    VAPID_PUB_B64 !== ''
  );
}

/** 当前订阅状态 —— 通过 SW registration 获取 */
export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

/**
 * 创建新的 Web Push 订阅
 * 必须由用户手势（按钮点击）触发
 */
export async function createPushSubscription(): Promise<PushSubscription> {
  if (!pushSupported()) throw new Error('当前浏览器不支持 Web Push');

  // 先检查现有订阅
  const existing = await getExistingSubscription();
  if (existing) return existing;

  // VAPID 公钥 → Uint8Array → BufferSource（显式转 ArrayBuffer 避免 TS 报错）
  const keyBytes = base64UrlToBytes(VAPID_PUB_B64);
  const applicationServerKey = keyBytes.buffer.slice(
    keyBytes.byteOffset,
    keyBytes.byteOffset + keyBytes.byteLength,
  ) as ArrayBuffer;

  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });
}

/**
 * 把订阅序列化后上报给 Worker
 * PushSubscription 的 endpoint + p256dh + auth 是 Web Push 必需的三件套
 */
export function serializeSubscription(subscription: PushSubscription): {
  endpoint: string;
  p256dh: string;
  auth: string;
} {
  const raw = subscription.toJSON() as {
    endpoint: string;
    keys?: { p256dh: string; auth: string };
  };
  if (!raw.endpoint || !raw.keys?.p256dh || !raw.keys?.auth) {
    throw new Error('订阅对象缺少必要字段');
  }
  return {
    endpoint: raw.endpoint,
    p256dh: raw.keys.p256dh,
    auth: raw.keys.auth,
  };
}

/**
 * POST /api/push/subscribe —— 注册订阅 + 同步当前 targets
 */
export async function subscribePush(
  subscription: PushSubscription,
  targets: Record<string, unknown>,
): Promise<void> {
  const serialized = serializeSubscription(subscription);
  const resp = await fetch(apiUrl('/api/push/subscribe'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...serialized, targets }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? '订阅失败');
  }
}

/**
 * POST /api/push/update —— 用户修改 targets 后同步到 Worker
 */
export async function updatePushTargets(
  subscription: PushSubscription,
  targets: Record<string, unknown>,
): Promise<void> {
  const serialized = serializeSubscription(subscription);
  const resp = await fetch(apiUrl('/api/push/update'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: serialized.endpoint, targets }),
  });
  if (!resp.ok) {
    // 更新失败不影响前端，静默吞掉
    return;
  }
}

/**
 * POST /api/push/unsubscribe —— 从 Worker KV 删除订阅
 * 同时调用 subscription.unsubscribe() 从浏览器推送服务注销
 */
export async function unsubscribePush(subscription: PushSubscription): Promise<void> {
  const serialized = serializeSubscription(subscription);
  try {
    await fetch(apiUrl('/api/push/unsubscribe'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: serialized.endpoint }),
    });
  } catch {
    // Worker 不可达时也要尝试注销浏览器端
  }
  await subscription.unsubscribe();
}
