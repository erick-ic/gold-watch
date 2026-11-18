import { INSTRUMENT_IDS, TROY_OUNCE_GRAMS, type InstrumentId } from '../shared/instruments';
import type { HistoryPoint, MarketSession, MarketSnapshot, Quote } from '../shared/types';
import type { PushSubscriptionRecord, PushTargets } from '../shared/push-types';
import { getMarketSession } from '../shared/sessions';
import { fetchEastmoneyHistory, fetchEastmoneyQuotes, hasEastmoneyQuote } from '../server/data/eastmoney';
import { fetchZheshangGoldQuote } from '../server/data/jdgold';
import { fetchGoldSpotUsd, fetchUsdCny } from '../server/data/fallback';
import { fetchSinaSnapshot } from '../server/data/sina';
import {
  evaluateAlertsForSubscription,
  sendWebPush,
  encryptPushPayload,
  base64UrlToBytes,
} from './push';

// =============================================================
//  Cloudflare Worker env 类型声明
// =============================================================
declare global {
  interface Env {
    PUSH_KV: KVNamespace;
    VAPID_PRIV: string;
  }

  interface RequestContext {
    env: Env;
  }
}

// VAPID 公钥与前端编译时常量保持一致（Base64url Raw 格式）
const VAPID_PUB = 'BFLp7IDaSWU1lZKXeWAsM38b1dKajJEZyRW1Bw-lPMTZ1xwyPncXrmfEJ1c4EXgVyPNIQ8O5C8LtF2sooPcVrQo';

// Worker 环境下 TTL 延长到 15s，避免频繁刷新触发 CPU 超限
// （Cloudflare Worker 免费版仅 10ms CPU/请求，刷新一次约 8-12ms）
const CACHE_TTL_MS = 15_000;
const QUOTE_STALE_MS = 120_000;
// 主数据源超过该时长未更新时改用备用源（留出缓存与推送间隔的余量）
const FRESH_MS = 60_000;
const HISTORY_TTL_MS = 30_000;

// Cron Worker 的行情刷新 TTL（更长，因为 Cron 本身是 30s 一次）
const CRON_CACHE_TTL_MS = 60_000;

interface HistoryCacheEntry {
  points: HistoryPoint[];
  prevClose: number | null;
  fetchedAt: number;
}

interface WorkerState {
  snapshot: MarketSnapshot | null;
  fetchedAt: number;
  sessionSeries: Map<InstrumentId, HistoryPoint[]>;
  historyCache: Map<InstrumentId, HistoryCacheEntry>;
}

// Worker isolate 内模块级状态跨请求保留，充当快照缓存与分时采样累积器
const state: WorkerState = {
  snapshot: null,
  fetchedAt: 0,
  sessionSeries: new Map(),
  historyCache: new Map(),
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

async function refreshQuotes(cacheTtlMs = CACHE_TTL_MS): Promise<MarketSnapshot | null> {
  if (state.snapshot && Date.now() - state.fetchedAt < cacheTtlMs) return state.snapshot;

  // 刷新 Promise 仅属于当前请求，不能放入全局 state 供其他请求复用
  return (async (): Promise<MarketSnapshot | null> => {
    const previous = state.snapshot;

    // 并行发起所有上游请求——最大化网络等待重叠
    const sinaP = fetchSinaSnapshot().catch(() => null);
    const eastmoneyP = fetchEastmoneyQuotes(INSTRUMENT_IDS.filter(hasEastmoneyQuote)).catch(() => []);
    const zheshangP = fetchZheshangGoldQuote().catch(() => null);
    const goldApiP = fetchGoldSpotUsd().catch(() => null);
    const usdcnyP = fetchUsdCny().catch(() => null);

    // 主数据源已覆盖全部品种时无需等待备用源，避免被最慢的兜底请求拖住
    const [sina, zheshangQuote] = await Promise.all([sinaP, zheshangP]);

    const quotes = new Map<InstrumentId, Quote>();
    let usdcny: number | null = sina?.usdcny ?? null;

    if (sina) {
      for (const q of sina.quotes) quotes.set(q.id, q);
    }
    if (zheshangQuote) quotes.set(zheshangQuote.id, zheshangQuote);

    // 新浪偶发停更时也要取备用源，否则该品种会被长期标记为延迟
    const nowForFresh = Date.now();
    const needsEastmoney = INSTRUMENT_IDS.some((id) => {
      if (!hasEastmoneyQuote(id)) return false;
      const quote = quotes.get(id);
      if (!quote) return true;
      return quote.quoteTime === null || nowForFresh - quote.quoteTime > FRESH_MS;
    });
    const needsGoldApi = !quotes.has('xauusd');
    const needsUsdcny = usdcny === null && !quotes.has('au9999');
    const [eastmoneyQuotes, goldPrice, usdcnyResult] = await Promise.all([
      needsEastmoney ? eastmoneyP : Promise.resolve([]),
      needsGoldApi ? goldApiP : Promise.resolve(null),
      needsUsdcny ? usdcnyP : Promise.resolve(null),
    ]);

    // 同一品种取时间更新的行情，避免旧数据覆盖新数据
    for (const q of eastmoneyQuotes) {
      const existing = quotes.get(q.id);
      if (!existing || (q.quoteTime ?? 0) > (existing.quoteTime ?? 0)) quotes.set(q.id, q);
    }
    if (usdcny === null) usdcny = usdcnyResult ?? null;

    // gold-api 兜底 xauusd
    if (!quotes.has('xauusd') && goldPrice !== null) {
      quotes.set('xauusd', {
        id: 'xauusd', price: goldPrice,
        bid: null, ask: null, prevClose: null, open: null, high: null, low: null,
        change: null, changePct: null, quoteTime: Date.now(),
        source: 'gold-api', derived: false, stale: false,
      });
    }

    // 沪金衍生换算
    if (!quotes.has('au9999') && usdcny !== null) {
      const xau = quotes.get('xauusd');
      if (xau) {
        quotes.set('au9999', {
          id: 'au9999', price: round2((xau.price * usdcny) / TROY_OUNCE_GRAMS),
          bid: null, ask: null, prevClose: null, open: null, high: null, low: null,
          change: null, changePct: null, quoteTime: Date.now(),
          source: 'derived', derived: true, stale: false,
        });
      }
    }

    // 缺失品种回退到上一次的快照标记 stale
    for (const id of INSTRUMENT_IDS) {
      if (!quotes.has(id)) {
        const old = previous?.quotes.find((q) => q.id === id);
        if (old) quotes.set(id, { ...old, stale: true });
      }
    }

    if (!usdcny) usdcny = previous?.usdcny ?? null;
    if (quotes.size === 0) return previous;

    const orderedQuotes = INSTRUMENT_IDS.map((id) => quotes.get(id)).filter(
      (quote): quote is Quote => quote !== undefined,
    );
    const now = Date.now();
    const sessions = Object.fromEntries(
      INSTRUMENT_IDS.map((id) => [id, getMarketSession(id, now)]),
    ) as Record<InstrumentId, MarketSession>;

    const annotatedQuotes = orderedQuotes.map((quote) => {
      if (quote.stale || sessions[quote.id].phase !== 'open' || quote.quoteTime === null) {
        return quote;
      }
      return now - quote.quoteTime > QUOTE_STALE_MS ? { ...quote, stale: true } : quote;
    });

    // Worker 不累积 sessionSeries（跨请求 CPU 成本高），直接跳过采样
    // （分时历史走 /api/history 接口按需从东财拉取）

    const degraded =
      annotatedQuotes.length < INSTRUMENT_IDS.length ||
      annotatedQuotes.some((q) => q.stale) ||
      usdcny === null;

    const snapshot: MarketSnapshot = {
      fetchedAt: now, usdcny, quotes: annotatedQuotes, sessions, degraded,
    };
    state.snapshot = snapshot;
    state.fetchedAt = now;
    return snapshot;
  })();
}

async function getHistory(id: InstrumentId, prevClose: number | null) {
  const cached = state.historyCache.get(id);
  if (cached && Date.now() - cached.fetchedAt < HISTORY_TTL_MS) {
    return {
      id,
      prevClose: prevClose ?? cached.prevClose,
      points: cached.points,
      source: 'eastmoney' as const,
      fetchedAt: cached.fetchedAt,
      stale: false,
    };
  }

  try {
    const history = await fetchEastmoneyHistory(id);
    if (history) {
      const entry: HistoryCacheEntry = {
        points: history.points,
        prevClose: history.prevClose,
        fetchedAt: Date.now(),
      };
      state.historyCache.set(id, entry);
      return {
        id,
        prevClose: prevClose ?? history.prevClose,
        points: history.points,
        source: 'eastmoney' as const,
        fetchedAt: entry.fetchedAt,
        stale: false,
      };
    }
  } catch {
    // 落到采样数据
  }

  if (cached) {
    return {
      id,
      prevClose: prevClose ?? cached.prevClose,
      points: cached.points,
      source: 'eastmoney' as const,
      fetchedAt: cached.fetchedAt,
      stale: true,
    };
  }

  const points = state.sessionSeries.get(id) ?? [];
  return {
    id,
    prevClose,
    points: [...points],
    source: 'session' as const,
    fetchedAt: Date.now(),
    stale: points.length === 0,
  };
}

// =============================================================
//  推送订阅路由
// =============================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

function makeKey(endpoint: string): string {
  // endpoint 可能很长，做个短 hash 作为 KV key
  return 'sub_' + endpoint.slice(-80);
}

async function handlePushSubscribe(
  env: Env,
  request: Request,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: '请求体必须是 JSON' }, 400);
  }

  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
  const p256dh = typeof body.p256dh === 'string' ? body.p256dh.trim() : '';
  const auth = typeof body.auth === 'string' ? body.auth.trim() : '';
  const targets = body.targets as PushTargets | undefined;

  if (!endpoint || !p256dh || !auth) {
    return json({ error: '缺少 endpoint / p256dh / auth 字段' }, 400);
  }

  // 校验 p256dh 和 auth 是否是合法的 base64url + 有效长度
  try {
    const dhBytes = base64UrlToBytes(p256dh);
    if (dhBytes.length !== 65 || dhBytes[0] !== 0x04) {
      return json({ error: 'p256dh 格式无效，应为 65 字节 Raw 格式' }, 400);
    }
    const authBytes = base64UrlToBytes(auth);
    if (authBytes.length !== 16) {
      return json({ error: 'auth 格式无效，应为 16 字节' }, 400);
    }
  } catch {
    return json({ error: 'p256dh / auth 解码失败' }, 400);
  }

  // 构造订阅记录
  const record: PushSubscriptionRecord = {
    endpoint,
    p256dh,
    auth,
    targets: normalizeTargets(targets),
    runtime: createDefaultRuntime(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const key = makeKey(endpoint);
  await env.PUSH_KV.put(key, JSON.stringify(record));

  return json({ ok: true, key });
}

async function handlePushUpdate(
  env: Env,
  request: Request,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: '请求体必须是 JSON' }, 400);
  }

  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
  const targets = body.targets as PushTargets | undefined;

  if (!endpoint) return json({ error: '缺少 endpoint 字段' }, 400);

  const key = makeKey(endpoint);
  const raw = await env.PUSH_KV.get(key);
  if (!raw) return json({ error: '订阅不存在，请先 subscribe' }, 404);

  const record: PushSubscriptionRecord = JSON.parse(raw) as PushSubscriptionRecord;
  record.targets = normalizeTargets(targets);
  record.updatedAt = Date.now();

  // 当用户把所有品种都禁用时，重置 runtime 避免残留状态
  if (Object.values(record.targets).every((t) => !t.enabled)) {
    record.runtime = createDefaultRuntime();
  }

  await env.PUSH_KV.put(key, JSON.stringify(record));
  return json({ ok: true });
}

async function handlePushUnsubscribe(env: Env, request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: '请求体必须是 JSON' }, 400);
  }

  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
  if (!endpoint) return json({ error: '缺少 endpoint 字段' }, 400);

  const key = makeKey(endpoint);
  await env.PUSH_KV.delete(key);
  return json({ ok: true });
}

function normalizeTargets(targets: PushTargets | undefined): PushTargets {
  const result: PushTargets = {} as PushTargets;
  for (const id of INSTRUMENT_IDS) {
    const raw = targets?.[id];
    if (raw && typeof raw === 'object') {
      const low = typeof raw.low === 'number' && raw.low > 0 ? raw.low : null;
      const high = typeof raw.high === 'number' && raw.high > 0 ? raw.high : null;
      result[id] = { low, high, enabled: raw.enabled === true && (low !== null || high !== null) };
    } else {
      result[id] = { low: null, high: null, enabled: false };
    }
  }
  return result;
}

function createDefaultRuntime(): Record<InstrumentId, { zone: 'inside' | 'outside'; lastTriggeredAt: number }> {
  return Object.fromEntries(
    INSTRUMENT_IDS.map((id) => [id, { zone: 'outside' as const, lastTriggeredAt: 0 }]),
  ) as Record<InstrumentId, { zone: 'inside' | 'outside'; lastTriggeredAt: number }>;
}

// =============================================================
//  手动测试接口：立即发送一条推送，不经过 Cron / KV
//  curl -X POST https://goldwatch.ichenghub.cn/api/push/test \
//    -H 'Content-Type: application/json' \
//    -d '{"endpoint":"...", "p256dh":"...", "auth":"..."}'
// =============================================================

async function handlePushTest(env: Env, request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: '请求体必须是 JSON' }, 400);
  }

  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
  const p256dh = typeof body.p256dh === 'string' ? body.p256dh.trim() : '';
  const auth = typeof body.auth === 'string' ? body.auth.trim() : '';
  const title = typeof body.title === 'string' ? body.title : 'GoldWatch 测试推送';
  const customBody = typeof body.body === 'string'
    ? body.body
    : '这是一条手动触发的测试推送，Worker 加密链路已验证通过 ✅';
  const tag = typeof body.tag === 'string' ? body.tag : `gw-test-${Date.now()}`;

  if (!endpoint || !p256dh || !auth) {
    return json({ error: '缺少 endpoint / p256dh / auth 字段' }, 400);
  }

  // 简单校验
  if (!endpoint.startsWith('https://')) {
    return json({ error: 'endpoint 必须是 https:// 推送端点' }, 400);
  }

  // 严格长度校验：p256dh base64url 解码后必须是 65 字节 (0x04 + 32 + 32 = P-256 未压缩公钥)
  // auth base64url 解码后必须是 16 字节
  function b64uLen(s: string): number {
    let padded = s.replace(/-/g, '+').replace(/_/g, '/');
    while (padded.length % 4) padded += '=';
    return Buffer.from(padded, 'base64').length;
  }
  const p256dhBytes = b64uLen(p256dh);
  const authBytes = b64uLen(auth);
  if (p256dhBytes !== 65) {
    return json({ error: `p256dh 长度错误：当前 ${p256dhBytes} 字节，必须 65 字节（P-256 未压缩公钥）。可能是 Console 显示截断了，用 copy() 或直接 fetch 不手动复制` }, 400);
  }
  if (authBytes !== 16) {
    return json({ error: `auth 长度错误：当前 ${authBytes} 字节，必须 16 字节` }, 400);
  }

  const payload = JSON.stringify({ title, body: customBody, tag });
  const start = Date.now();

  const result = await sendWebPush(
    endpoint,
    env.VAPID_PRIV,
    VAPID_PUB,
    'mailto:goldwatch@ichenghub.cn',
    p256dh,
    auth,
    payload,
  );

  const elapsedMs = Date.now() - start;

  if (result.ok) {
    return json({
      ok: true,
      elapsedMs,
      endpoint: endpoint.slice(0, 60) + '...',
      payload: JSON.parse(payload),
      retryAfter: result.retryAfter,
      statusCode: result.statusCode,
    });
  }

  return json(
    {
      ok: false,
      elapsedMs,
      error: result.error || '推送服务返回失败，请检查 endpoint / p256dh / auth 是否有效',
      retryAfter: result.retryAfter,
      pushStatusCode: result.statusCode,
    },
    502,
  );
}

// =============================================================
//  Cron Handler：每 30s 检查行情，遍历订阅推送
// =============================================================

interface CronEnv extends Env {} // Cron handler 共享相同的 env

async function runPushCron(env: CronEnv): Promise<void> {
  try {
    // 1. 拉行情快照（Cron Worker 有弹性 CPU 不限 10ms）
    const snapshot = await refreshQuotes(CRON_CACHE_TTL_MS);
    if (!snapshot) {
      console.warn('[Cron] 行情不可用，跳过本轮');
      return;
    }

    // 2. 遍历所有订阅者
    const subscriptions = await listAllSubscriptions(env.PUSH_KV);
    if (subscriptions.length === 0) {
      console.warn('[Cron] 无订阅者，跳过本轮');
      return;
    }
    console.log('[Cron] 行情 fetchedAt =', snapshot.fetchedAt, '订阅数 =', subscriptions.length);


    const now = Date.now();
    const pushes: Array<{
      record: PushSubscriptionRecord;
      endpoint: string;
      key: string;
      alerts: Array<{ title: string; body: string; tag: string }>;
    }> = [];

    for (const { record, key } of subscriptions) {
      const alerts = evaluateAlertsForSubscription(record, snapshot, now);
      if (alerts.length > 0) {
        // 一次订阅只推一条通知（取第一个品种的 alert，或合并）
        const first = alerts[0];
        pushes.push({
          record,
          endpoint: record.endpoint,
          key,
          alerts: [{ title: first.title, body: first.body, tag: first.tag }],
        });
      } else {
        // 虽然没有到价，但仍需更新 runtime（zone 变化）
        await env.PUSH_KV.put(key, JSON.stringify(record));
      }
    }

    if (pushes.length === 0) return;

    // 3. 并发发送所有推送
    const results = await Promise.all(
      pushes.map(async ({ record, endpoint, key, alerts }) => {
        const { title, body, tag } = alerts[0];
        const payload = JSON.stringify({ title, body, tag });
        const result = await sendWebPush(
          endpoint,
          env.VAPID_PRIV,
          VAPID_PUB,
          'mailto:goldwatch@ichenghub.cn',
          record.p256dh,
          record.auth,
          payload,
        );
        return { record, key, result };
      }),
    );

    // 4. 更新 KV（成功推送后保存 runtime；失败则不存避免丢失 alert 状态）
    for (const { record, key, result } of results) {
      (record.runtime as Record<string, unknown>)._lastPushResult = result;
      if (result.ok) {
        await env.PUSH_KV.put(key, JSON.stringify(record));
      } else {
        // 失败也存一下，保留失败信息
        await env.PUSH_KV.put(key, JSON.stringify(record));
        console.warn('[Cron] 推送失败', result);
      }
    }
  } catch (e) {
    // Cron 异常吞掉，避免 Cron 重试风暴；但保留错误信息给调试
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[Cron] runPushCron 异常:', msg);
    // 存一条调试记录到 KV
    try {
      const errRecord = { at: Date.now(), error: msg };
      await env.PUSH_KV.put('_cron_last_error', JSON.stringify(errRecord));
    } catch { /* ignore */ }
  }
}

/** 手动调试版 Cron：返回每条订阅的详细推送结果 */
async function runPushCronDebug(env: CronEnv): Promise<Record<string, unknown>> {
  const snapshot = await refreshQuotes(CRON_CACHE_TTL_MS);
  if (!snapshot) return { error: '行情不可用' };

  const subscriptions = await listAllSubscriptions(env.PUSH_KV);
  const results: Array<Record<string, unknown>> = [];
  const now = Date.now();

  for (const { record, key } of subscriptions) {
    const alerts = evaluateAlertsForSubscription(record, snapshot, now);
    const alert = alerts[0];
    const beforeZone = record.runtime.xauusd?.zone;

    const pushResult = alert
      ? await sendWebPush(
          record.endpoint,
          env.VAPID_PRIV,
          VAPID_PUB,
          'mailto:goldwatch@ichenghub.cn',
          record.p256dh,
          record.auth,
          JSON.stringify({ title: alert.title, body: alert.body, tag: alert.tag }),
        )
      : null;

    results.push({
      key: key.slice(0, 40) + '...',
      endpoint: record.endpoint.slice(0, 50) + '...',
      beforeZone,
      willTrigger: !!alert,
      alert: alert ? { title: alert.title, body: alert.body } : null,
      pushResult,
    });
  }

  return {
    snapshot: { fetchedAt: snapshot.fetchedAt, xauusdPrice: snapshot.quotes.find((q) => q.id === 'xauusd')?.price },
    subscriptionCount: subscriptions.length,
    results,
  };
}

/** 遍历 KV 中所有订阅者（带 pagination） */
async function listAllSubscriptions(
  kv: KVNamespace,
): Promise<Array<{ record: PushSubscriptionRecord; key: string }>> {
  const all: Array<{ record: PushSubscriptionRecord; key: string }> = [];
  let cursor: string | undefined;

  do {
    const list = await kv.list({ prefix: 'sub_', cursor });
    for (const item of list.keys) {
      const raw = await kv.get(item.name);
      if (raw) {
        try {
          const record = JSON.parse(raw) as PushSubscriptionRecord;
          if (isValidSubscription(record)) {
            all.push({ record, key: item.name });
          }
        } catch {
          // 跳过损坏的记录
        }
      }
    }
    cursor = list.list_complete ? undefined : (list.cursor as string | undefined);
  } while (cursor);

  return all;
}

function isValidSubscription(record: unknown): record is PushSubscriptionRecord {
  if (typeof record !== 'object' || record === null) return false;
  const r = record as Record<string, unknown>;
  return (
    typeof r.endpoint === 'string' &&
    typeof r.p256dh === 'string' &&
    typeof r.auth === 'string' &&
    r.endpoint.startsWith('https://')
  );
}

// =============================================================
//  主 Handler
// =============================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

      // === 行情 API ===
      if (request.method === 'GET') {
        if (url.pathname === '/api/quotes') {
          const snapshot = await refreshQuotes();
          if (!snapshot) return json({ error: '行情数据尚未就绪，请稍后重试' }, 503);
          return json(snapshot);
        }

        if (url.pathname === '/api/history') {
          const id = url.searchParams.get('id') ?? '';
          if (!INSTRUMENT_IDS.includes(id as InstrumentId)) {
            return json({ error: '未知的行情代码' }, 400);
          }
          const quote = state.snapshot?.quotes.find((item) => item.id === id);
          return json(await getHistory(id as InstrumentId, quote?.prevClose ?? null));
        }

        if (url.pathname === '/api/health') {
          const snapshot = await refreshQuotes();
          return json({
            ok: snapshot !== null,
            uptimeSec: 0,
            lastSuccessAt: snapshot?.fetchedAt ?? null,
            lastError: null,
            clients: 0,
            sources: {},
          });
        }

        // === 推送路由 ===
        if (url.pathname === '/api/push/keys') {
          return json({ vapid: VAPID_PUB });
        }
        if (url.pathname === '/api/push/subscriptions') {
          // 调试接口：列出所有 KV 里的订阅
          const subs = await listAllSubscriptions(env.PUSH_KV);
          return json({
            count: subs.length,
            subscriptions: subs.map(({ record, key }) => ({
              key,
              endpoint: record.endpoint.slice(0, 60) + '...',
              p256dhLen: record.p256dh.length,
              authLen: record.auth.length,
              targets: record.targets,
              runtime: Object.fromEntries(
                Object.entries(record.runtime).map(([id, r]) => [id, { zone: r.zone, lastTriggeredAt: r.lastTriggeredAt }]),
              ),
            })),
          });
        }
        if (url.pathname === '/api/push/first-subscription') {
          // 调试接口：返回第一条订阅的完整 endpoint/p256dh/auth（用于本地 web-push 对照测试）
          const subs = await listAllSubscriptions(env.PUSH_KV);
          if (subs.length === 0) return json({ error: '无订阅' }, 404);
          const s = subs[0];
          return json({
            endpoint: s.record.endpoint,
            p256dh: s.record.p256dh,
            auth: s.record.auth,
          });
        }
        if (url.pathname === '/api/push/encrypt-test') {
          const subs = await listAllSubscriptions(env.PUSH_KV);
          if (subs.length === 0) return json({ error: '无订阅' }, 404);
          const target = url.searchParams.get('target') ?? 'fcm';
          const s = subs.find(sub => target === 'fcm' ? sub.record.endpoint.includes('fcm') : !sub.record.endpoint.includes('fcm')) ?? subs[0];
          const plaintext = url.searchParams.get('payload') ?? JSON.stringify({ title: 'Worker 加密测试', body: '这是 Worker 加密的内容', tag: 'test' });
          const { encryptedData, debug } = await encryptPushPayload(plaintext, s.record.p256dh, s.record.auth);
          return json({
            ok: true,
            endpoint: s.record.endpoint,
            p256dh: s.record.p256dh,
            auth: s.record.auth,
            plaintext,
            encryptedBase64: Buffer.from(encryptedData).toString('base64'),
            encryptedLen: encryptedData.length,
            debug,
          });
        }
        if (url.pathname === '/api/push/manual-cron') {
          // 调试接口：手动跑一次 Cron，返回详细结果
          return json(await runPushCronDebug(env));
        }
        if (url.pathname === '/api/push/trigger-cron') {
          // 调试接口：手动跑一次完整的正式 Cron（含 KV 更新）
          await runPushCron(env);
          // 执行后查 subscriptions 看结果
          const subs = await listAllSubscriptions(env.PUSH_KV);
          return json({
            ran: true,
            subscriptionCount: subs.length,
            subs: subs.map(({ record }) => ({
              endpoint: record.endpoint.slice(0, 50) + '...',
              zone: ((record.runtime as Record<string, unknown>).xauusd as { zone: string } | undefined)?.zone,
              lpr: (record.runtime as Record<string, unknown>)._lastPushResult ?? null,
            })),
          });
        }
        if (url.pathname === '/api/push/reset-zones') {
          // 调试接口：把所有订阅的 zone 重置为 outside，方便重新测试 Cron 触发
          const subs = await listAllSubscriptions(env.PUSH_KV);
          for (const { record, key } of subs) {
            for (const id of INSTRUMENT_IDS) {
              record.runtime[id] = { zone: 'outside', lastTriggeredAt: 0 };
            }
            delete (record.runtime as Record<string, unknown>)._lastPushResult;
            await env.PUSH_KV.put(key, JSON.stringify(record));
          }
          return json({ reset: true, count: subs.length });
        }

        if (url.pathname === '/') {
          return new Response(ROOT_PAGE, {
            headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS },
          });
        }

        return json({ error: '接口不存在' }, 404);
      }

      // === 推送 POST 路由 ===
      if (request.method === 'POST') {
        if (url.pathname === '/api/push/subscribe') {
          return handlePushSubscribe(env, request);
        }
        if (url.pathname === '/api/push/update') {
          return handlePushUpdate(env, request);
        }
        if (url.pathname === '/api/push/unsubscribe') {
          return handlePushUnsubscribe(env, request);
        }
        if (url.pathname === '/api/push/test') {
          return handlePushTest(env, request);
        }
        return json({ error: '接口不存在' }, 404);
      }

      return json({ error: 'Method Not Allowed' }, 405);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (state.snapshot) return json(state.snapshot);
      return json({ error: `服务暂时不可用: ${message}` }, 503);
    }
  },

  async scheduled(_controller: ScheduledController, env: CronEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runPushCron(env));
  },
};

const ROOT_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>GoldWatch API</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: radial-gradient(120% 90% at 20% 0%, #1a1610 0%, #0a0a0c 55%);
    color: #eceae4;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: min(26rem, calc(100vw - 2.5rem));
    padding: 2rem 1.75rem;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 20px;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
  }
  h1 { margin: 0; font-size: 1.4rem; letter-spacing: 0.01em; }
  h1 .mark { color: #e3c56a; }
  .sub { margin: 0.5rem 0 0; color: #9b978d; font-size: 0.875rem; line-height: 1.8; }
  ul { list-style: none; margin: 1.4rem 0 0; padding: 0; display: grid; gap: 0.65rem; }
  li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.35rem 0.6rem; font-size: 0.85rem; color: #b9b5aa; }
  code {
    background: rgba(227, 197, 106, 0.13); color: #e8d18a;
    padding: 0.18em 0.55em; border-radius: 7px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.78rem;
    overflow-wrap: anywhere;
  }
  .btn {
    display: inline-flex; align-items: center; gap: 0.4rem;
    margin-top: 1.5rem; padding: 0.7rem 1.5rem;
    background: linear-gradient(135deg, #e8cf7d, #cfa63e);
    color: #17140c; font-size: 0.9rem; font-weight: 600;
    border-radius: 12px; text-decoration: none;
    transition: filter 0.15s ease;
  }
  .btn:hover { filter: brightness(1.1); }
  .btn .arrow { transition: transform 0.15s ease; }
  .btn:hover .arrow { transform: translateX(2px); }
  .foot { margin-top: 1.6rem; padding-top: 1rem; border-top: 1px solid rgba(255, 255, 255, 0.07); font-size: 0.75rem; color: #6d6a62; }
</style>
</head>
<body>
  <main class="card">
    <h1><span class="mark">GoldWatch</span> 行情 API</h1>
    <p class="sub">本服务仅提供数据接口，不承载网页界面。</p>
    <a class="btn" href="https://erick-ic.github.io/gold-watch/">打开 GoldWatch 应用<span class="arrow">→</span></a>
    <ul>
      <li><code>GET /api/health</code><span>服务状态</span></li>
      <li><code>GET /api/quotes</code><span>实时行情快照</span></li>
      <li><code>GET /api/history?id=…</code><span>当日分时数据</span></li>
      <li><code>GET /api/push/keys</code><span>Web Push VAPID 公钥</span></li>
      <li><code>POST /api/push/subscribe</code><span>注册推送订阅</span></li>
    </ul>
    <p class="foot">支持品种：伦敦金 · 沪金99 · 黄金T+D · 浙商积存金</p>
  </main>
</body>
</html>
`;
