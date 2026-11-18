import type { InstrumentId } from '../shared/instruments';
import { INSTRUMENT_IDS } from '../shared/instruments';
import type { MarketSnapshot, Quote } from '../shared/types';
import type { PushSubscriptionRecord } from '../shared/push-types';
import { formatPushNotification } from './push-format';

// Cloudflare Worker 的 Web Crypto 实现
const SC: any = crypto.subtle;

// =============================================================
//  工具函数：base64url 编解码
// =============================================================

/** base64url（无 padding）→ Uint8Array */
export function base64UrlToBytes(input: string): Uint8Array {
  let s = input.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Uint8Array → base64url（无 padding） */
export function bytesToBase64Url(input: Uint8Array): string {
  let s = '';
  for (let i = 0; i < input.length; i++) s += String.fromCharCode(input[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 把任何 ArrayBufferLike 转成纯 ArrayBuffer */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// =============================================================
//  HKDF-Extract + Expand（RFC 5869，crypto.subtle 没有原生 HKDF）
// =============================================================

/** HKDF-Extract: PRK = HMAC(salt, ikm) */
async function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  const saltKey = await SC.importKey('raw', toArrayBuffer(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await SC.sign({ name: 'HMAC' }, saltKey, toArrayBuffer(ikm)));
}

/** HKDF-Expand: 从 PRK 派生指定长度的输出 */
async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const prkKey = await SC.importKey('raw', toArrayBuffer(prk), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const result = new Uint8Array(length);
  let t = new Uint8Array(0);
  let offset = 0;
  let counter = 0;
  while (offset < length) {
    counter++;
    const counterBuf = new Uint8Array(1);
    counterBuf[0] = counter;
    const message = new Uint8Array(t.length + info.length + 1);
    message.set(t, 0);
    message.set(info, t.length);
    message.set(counterBuf, t.length + info.length);
    t = new Uint8Array(await SC.sign({ name: 'HMAC' }, prkKey, toArrayBuffer(message)));
    const take = Math.min(32, length - offset);
    result.set(t.slice(0, take), offset);
    offset += take;
  }
  return result;
}

// =============================================================
//  ECDSA 签名工具（用于 VAPID）
// =============================================================

function intToBigEndian(n: number, bytes: Uint8Array, offset: number): void {
  // 把 32 位整数写入 [offset, offset+3]，大端序
  bytes[offset] = (n >>> 24) & 0xff;
  bytes[offset + 1] = (n >>> 16) & 0xff;
  bytes[offset + 2] = (n >>> 8) & 0xff;
  bytes[offset + 3] = n & 0xff;
}

// =============================================================
//  VAPID JWT 签名
// =============================================================

export async function signVapidAudience(
  vapidPrivDerB64: string,
  vapidPubRawB64: string,
  audienceOrigin: string,
  subject: string,
): Promise<string> {
  const privDerBytes = base64UrlToBytes(vapidPrivDerB64);
  const privDerAb = toArrayBuffer(privDerBytes);

  const privKey = await SC.importKey(
    'pkcs8',
    privDerAb,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  const pubB64 = vapidPubRawB64;

  const exp = Math.floor(Date.now() / 1000) + 60 * 5;
  const claims = `{"aud":"${audienceOrigin}","exp":${exp},"sub":"${subject}"}`;
  const header = `{"alg":"ES256","typ":"JWT"}`;

  const headerB64 = bytesToBase64Url(new TextEncoder().encode(header) as unknown as Uint8Array);
  const claimsB64 = bytesToBase64Url(new TextEncoder().encode(claims) as unknown as Uint8Array);
  const signingInput = `${headerB64}.${claimsB64}`;

  const sigAb = await SC.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privKey,
    new TextEncoder().encode(signingInput),
  );
  const sigB64 = bytesToBase64Url(new Uint8Array(sigAb));

  return `vapid t=${signingInput}.${sigB64},k=${pubB64}`;
}

// =============================================================
//  Web Push 消息加密 — RFC 8291 aes128gcm（严格对标 http_ece 标准库）
// =============================================================

const RECORD_SIZE = 4096;
const KEY_LENGTH = 16;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

export async function encryptPushPayload(
  plaintext: string,
  clientP256dhB64: string,
  clientAuthB64: string,
): Promise<{
  encryptedData: Uint8Array;
  debug?: {
    saltB64: string;
    ephemeralPubB64: string;
    webpushSecretHex: string;
    cekHex: string;
    baseNonceHex: string;
    ecdhSharedHex: string;
  };
}> {
  const clientPub = base64UrlToBytes(clientP256dhB64); // 65 bytes (0x04 prefix)
  const clientAuth = base64UrlToBytes(clientAuthB64); // 16 bytes

  // 1. 生成 Worker 临时 ECDH P-256 密钥对
  const ephemeral = (await SC.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits'],
  )) as CryptoKeyPair;

  const ephemeralPubRaw = new Uint8Array(await SC.exportKey('raw', ephemeral.publicKey));

  // 2. import 客户端公钥
  const clientPubKey = await SC.importKey(
    'raw',
    toArrayBuffer(clientPub),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );

  // 3. 派生 ECDH 共享值
  const ecdhShared = new Uint8Array(
    await SC.deriveBits({ name: 'ECDH', public: clientPubKey }, ephemeral.privateKey, 256),
  );

  // 4. webpush_secret = HKDF(clientAuth, ecdhShared, "WebPush: info\0" || clientPub || ephemeralPub, 32)
  const webpushInfo = new Uint8Array('WebPush: info\0'.length + clientPub.length + ephemeralPubRaw.length);
  const enc = new TextEncoder();
  webpushInfo.set(enc.encode('WebPush: info\0'), 0);
  webpushInfo.set(clientPub, 'WebPush: info\0'.length);
  webpushInfo.set(ephemeralPubRaw, 'WebPush: info\0'.length + clientPub.length);

  // HKDF-Extract + Expand 一步合成
  const prk = await hkdfExtract(clientAuth, ecdhShared);
  const webpushSecret = await hkdfExpand(prk, webpushInfo, 32);

  // 5. 生成随机 salt（16 bytes）
  const salt = crypto.getRandomValues(new Uint8Array(KEY_LENGTH));

  // 6. 派生 CEK 和 BASE_NONCE
  // PRK2 = HKDF-Extract(salt, webpush_secret)
  const prk2 = await hkdfExtract(salt, webpushSecret);
  const cek = await hkdfExpand(prk2, enc.encode('Content-Encoding: aes128gcm\0'), KEY_LENGTH);
  const baseNonce = await hkdfExpand(prk2, enc.encode('Content-Encoding: nonce\0'), NONCE_LENGTH);

  // 7. 二进制头部（aes128gcm 规范：salt(16) + rs(4 BE) + keyid_len(1) + keyid(ephemeralPub)）
  const headerLen = KEY_LENGTH + 4 + 1 + ephemeralPubRaw.length;
  const binaryHeader = new Uint8Array(headerLen);
  binaryHeader.set(salt, 0);
  intToBigEndian(RECORD_SIZE, binaryHeader, KEY_LENGTH);
  binaryHeader[KEY_LENGTH + 4] = ephemeralPubRaw.length;
  binaryHeader.set(ephemeralPubRaw, KEY_LENGTH + 5);

  // 8. 加密每条记录
  const plaintextBytes = enc.encode(plaintext);
  const perRecordOverhead = 1 + TAG_LENGTH; // 1 byte padding marker + 16 bytes auth tag
  const maxDataPerRecord = RECORD_SIZE - perRecordOverhead;

  const records: Uint8Array[] = [];
  let offset = 0;
  let counter = 0;
  while (offset < plaintextBytes.length || records.length === 0) {
    const remaining = plaintextBytes.length - offset;
    const dataLen = Math.min(maxDataPerRecord, Math.max(0, remaining));
    const isLast = offset + dataLen >= plaintextBytes.length;

    const data = new Uint8Array(dataLen);
    data.set(plaintextBytes.slice(offset, offset + dataLen), 0);

    // 构造 per-record nonce = baseNonce[0:6] || XOR(baseNonce[6:12], counter_BE_6bytes)
    const nonce = new Uint8Array(NONCE_LENGTH);
    nonce.set(baseNonce, 0);
    // counter 写入 6 字节大端（放在 nonce 最后 6 字节）
    let c = counter;
    for (let i = NONCE_LENGTH - 1; i >= 6; i--) {
      nonce[i] ^= c & 0xff;
      c = Math.floor(c / 256);
    }

    // padding marker：非最后记录 = 1，最后记录 = 2
    const padByte = new Uint8Array(1);
    padByte[0] = isLast ? 2 : 1;

    // 构造 record plaintext = data || padByte
    const recordPlaintext = new Uint8Array(dataLen + 1);
    recordPlaintext.set(data, 0);
    recordPlaintext[dataLen] = padByte[0];

    // AES-GCM 加密
    const aesKey = await SC.importKey('raw', toArrayBuffer(cek), { name: 'AES-GCM', length: 128 }, false, ['encrypt']);
    const encryptedRecord = new Uint8Array(
      await SC.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(nonce) }, aesKey, toArrayBuffer(recordPlaintext)),
    );

    records.push(encryptedRecord);
    offset += dataLen;
    counter++;

    if (isLast && dataLen === 0 && records.length > 1) break;
  }

  // 9. 拼接 binaryHeader + 所有 encrypted records
  const totalLen = headerLen + records.reduce((s, r) => s + r.length, 0);
  const result = new Uint8Array(totalLen);
  let pos = 0;
  result.set(binaryHeader, pos);
  pos += headerLen;
  for (const rec of records) {
    result.set(rec, pos);
    pos += rec.length;
  }

  const buf2hex = (b: Uint8Array) => { let s = ''; for (const x of b) s += x.toString(16).padStart(2, '0'); return s; };
  const bytesToB64url = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

  return {
    encryptedData: result,
    debug: {
      saltB64: bytesToB64url(salt),
      ephemeralPubB64: bytesToB64url(ephemeralPubRaw),
      webpushSecretHex: buf2hex(webpushSecret),
      cekHex: buf2hex(cek),
      baseNonceHex: buf2hex(baseNonce),
      ecdhSharedHex: buf2hex(ecdhShared),
    },
  };
}

// =============================================================
//  发送 Web Push
// =============================================================

const PUSH_TIMEOUT_MS = 15_000;

export async function sendWebPush(
  endpoint: string,
  vapidPrivDerB64: string,
  vapidPubRawB64: string,
  vapidSubject: string,
  p256dh: string,
  auth: string,
  plaintext: string,
): Promise<{ ok: boolean; retryAfter?: number; error?: string; statusCode?: number }> {
  try {
    const url = new URL(endpoint);

    const vapidAuth = await signVapidAudience(vapidPrivDerB64, vapidPubRawB64, url.origin, vapidSubject);
    const { encryptedData } = await encryptPushPayload(plaintext, p256dh, auth);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);

    // aes128gcm 把 salt + keyid 都放进了 body 二进制头部
    // HTTP 头只需要 Content-Encoding、Content-Type、Authorization (VAPID)
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuth,
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Content-Length': String(encryptedData.length),
        'TTL': '30',
      },
      body: toArrayBuffer(encryptedData),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    const retryAfter = resp.headers.get('Retry-After');
    return {
      ok: resp.ok || resp.status === 202,
      retryAfter: retryAfter ? parseInt(retryAfter, 10) : undefined,
      statusCode: resp.status,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[sendWebPush] 异常:', msg);
    return { ok: false, error: msg };
  }
}

// =============================================================
//  Cron 行情检测
// =============================================================

const ALERT_COOLDOWN_MS = 60 * 1000;

export function evaluateAlertsForSubscription(
  subscription: PushSubscriptionRecord,
  snapshot: MarketSnapshot,
  now: number,
): Array<{ instrument: InstrumentId; quote: Quote; title: string; body: string; tag: string }> {
  const alerts: Array<{
    instrument: InstrumentId;
    quote: Quote;
    title: string;
    body: string;
    tag: string;
  }> = [];

  for (const id of INSTRUMENT_IDS) {
    const quote = snapshot.quotes.find((q) => q.id === id);
    if (!quote) continue;

    const target = subscription.targets[id];
    if (!target?.enabled) continue;

    const session = snapshot.sessions[id];
    if (session.phase !== 'open' || quote.stale) continue;

    const bounds = normalizeBounds(target);
    if (!bounds) continue;

    const runtime = subscription.runtime[id] ?? { zone: 'outside' as const, lastTriggeredAt: 0 };
    const inside = isInRange(bounds, quote.price);
    const trigger = inside && runtime.zone !== 'inside' && now - runtime.lastTriggeredAt >= ALERT_COOLDOWN_MS;

    if (trigger) {
      const meta = formatPushNotification(id, quote.price, bounds);
      alerts.push({
        instrument: id, quote,
        title: meta.title, body: meta.body, tag: meta.tag,
      });
      subscription.runtime[id] = { zone: 'inside', lastTriggeredAt: now };
    } else {
      subscription.runtime[id] = { ...runtime, zone: inside ? 'inside' : 'outside' };
    }
  }

  return alerts;
}

function normalizeBounds(
  range: { low: number | null; high: number | null },
): { low: number | null; high: number | null } | null {
  const low = isPositive(range.low) ? range.low : null;
  const high = isPositive(range.high) ? range.high : null;
  if (low === null && high === null) return null;
  if (low !== null && high !== null && low > high) return { low: high, high: low };
  return { low, high };
}

function isInRange(bounds: { low: number | null; high: number | null }, price: number): boolean {
  if (!Number.isFinite(price)) return false;
  if (bounds.low !== null && price < bounds.low) return false;
  if (bounds.high !== null && price > bounds.high) return false;
  return true;
}

function isPositive(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
