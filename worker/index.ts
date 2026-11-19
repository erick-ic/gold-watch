import { INSTRUMENT_IDS, TROY_OUNCE_GRAMS, type InstrumentId } from '../shared/instruments';
import type { HistoryPoint, MarketSession, MarketSnapshot, Quote } from '../shared/types';
import type { PushSubscriptionRecord, PushTargets } from '../shared/push-types';
import { getMarketSession } from '../shared/sessions';
import { HISTORY_MAX_POINTS } from '../server/config';
import { appendSample } from '../server/data/sessionSeries';
import { fetchEastmoneyHistory, fetchEastmoneyQuotes, hasEastmoneyQuote } from '../server/data/eastmoney';
import { fetchMinshengGoldQuote, fetchZheshangGoldQuote } from '../server/data/jdgold';
import { fetchGoldSpotUsd, fetchUsdCny } from '../server/data/fallback';
import { fetchSinaSnapshot } from '../server/data/sina';
import {
  evaluateAlertsForSubscription,
  sendWebPush,
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

// Worker 缓存策略：5s TTL + 3s fetch 超时，快速失败快速刷新
// （刷新本身很快，正常并行 5 源总耗时在 200ms 内；3s 超时够覆盖慢源又不拖垮 Worker）
const CACHE_TTL_MS = 5_000;
const QUOTE_STALE_MS = 120_000;
// 主数据源超过该时长未更新时改用备用源
const FRESH_MS = 30_000;
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
  /** 会话采样写入 Edge Cache 的节流时间 */
  seriesWriteAt: Map<InstrumentId, number>;
}

// Worker isolate 内模块级状态跨请求保留，充当快照缓存与分时采样累积器
const state: WorkerState = {
  snapshot: null,
  fetchedAt: 0,
  sessionSeries: new Map(),
  historyCache: new Map(),
  seriesWriteAt: new Map(),
};

// Cloudflare 边缘访问国内行情源偶发失败（本地直连稳定），
// 用 colo 级 Cache API 保存最近一次成功数据，跨 isolate 共享并在故障时兜底
const EDGE_HISTORY_ORIGIN = 'https://goldwatch-history.internal';
const EDGE_HISTORY_TTL_SEC = 6 * 60 * 60;
const SERIES_EDGE_WRITE_MS = 30_000;

function edgeCache(): Cache | null {
  // 部分 workers-types 版本未声明 caches.default
  return (caches as unknown as { default?: Cache }).default ?? null;
}

async function readEdgeHistory(id: InstrumentId): Promise<HistoryCacheEntry | null> {
  const cache = edgeCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(new Request(`${EDGE_HISTORY_ORIGIN}/${id}`));
    if (!hit) return null;
    const entry = (await hit.json()) as HistoryCacheEntry;
    return Array.isArray(entry?.points) && entry.points.length > 0 ? entry : null;
  } catch {
    return null;
  }
}

async function writeEdgeHistory(id: InstrumentId, entry: HistoryCacheEntry): Promise<void> {
  if (entry.points.length === 0) return;
  const cache = edgeCache();
  if (!cache) return;
  try {
    await cache.put(
      new Request(`${EDGE_HISTORY_ORIGIN}/${id}`),
      new Response(JSON.stringify(entry), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `max-age=${EDGE_HISTORY_TTL_SEC}`,
        },
      }),
    );
  } catch {
    // Edge Cache 仅作兜底，写入失败忽略
  }
}

function mergeSeries(
  base: readonly HistoryPoint[],
  incoming: readonly HistoryPoint[],
): HistoryPoint[] {
  const map = new Map<number, number>();
  for (const point of [...base, ...incoming]) {
    if (Number.isFinite(point.t) && Number.isFinite(point.p)) map.set(point.t, point.p);
  }
  const merged = [...map.entries()].sort((a, b) => a[0] - b[0]);
  const trimmed =
    merged.length > HISTORY_MAX_POINTS ? merged.slice(merged.length - HISTORY_MAX_POINTS) : merged;
  return trimmed.map(([t, p]) => ({ t, p }));
}

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
    // 东财报价仅在主源缺失/过旧时才真正发起，避免每轮都请求一个可能不可达的接口
    let eastmoneyP: Promise<Quote[]> | null = null;
    const loadEastmoneyQuotes = (): Promise<Quote[]> => {
      eastmoneyP ??= fetchEastmoneyQuotes(INSTRUMENT_IDS.filter(hasEastmoneyQuote)).catch(() => []);
      return eastmoneyP;
    };
    const zheshangP = fetchZheshangGoldQuote().catch(() => null);
    const minshengP = fetchMinshengGoldQuote().catch(() => null);
    const goldApiP = fetchGoldSpotUsd().catch(() => null);
    const usdcnyP = fetchUsdCny().catch(() => null);

    // 主数据源已覆盖全部品种时无需等待备用源，避免被最慢的兜底请求拖住
    const [sina, zheshangQuote, minshengQuote] = await Promise.all([sinaP, zheshangP, minshengP]);

    const quotes = new Map<InstrumentId, Quote>();
    let usdcny: number | null = sina?.usdcny ?? null;

    if (sina) {
      for (const q of sina.quotes) quotes.set(q.id, q);
    }
    if (zheshangQuote) quotes.set(zheshangQuote.id, zheshangQuote);
    if (minshengQuote) quotes.set(minshengQuote.id, minshengQuote);

    // 新浪偶发停更时也要取备用源，否则该品种会被长期标记为延迟
    const nowForFresh = Date.now();
    const needsEastmoney = INSTRUMENT_IDS.some((id) => {
      if (!hasEastmoneyQuote(id)) return false;
      const quote = quotes.get(id);
      if (!quote) return true;
      // 休市时报价时间天然是旧的，不必因此请求备用源
      if (getMarketSession(id, nowForFresh).phase !== 'open') return false;
      return quote.quoteTime === null || nowForFresh - quote.quoteTime > FRESH_MS;
    });
    const needsGoldApi = !quotes.has('xauusd');
    const needsUsdcny = usdcny === null && !quotes.has('au9999');
    const [eastmoneyQuotes, goldPrice, usdcnyResult] = await Promise.all([
      needsEastmoney ? loadEastmoneyQuotes() : Promise.resolve([]),
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

    // 累积会话采样：没有第三方分时接口的品种（如浙商积存金）以及
    // 东财分时接口失败时的兜底，都依赖这里积累的走势点
    for (const quote of annotatedQuotes) {
      if (hasEastmoneyQuote(quote.id)) continue;
      const points = appendSample(
        state.sessionSeries.get(quote.id) ?? [],
        { t: quote.quoteTime ?? now, p: quote.price },
        HISTORY_MAX_POINTS,
      );
      state.sessionSeries.set(quote.id, points);

      // 定期写入 Edge Cache，供其他 isolate 或上游故障时恢复走势
      const lastWrite = state.seriesWriteAt.get(quote.id) ?? 0;
      if (points.length >= 2 && now - lastWrite > SERIES_EDGE_WRITE_MS) {
        state.seriesWriteAt.set(quote.id, now);
        await writeEdgeHistory(quote.id, {
          points,
          prevClose: quote.prevClose ?? previous?.quotes.find((q) => q.id === quote.id)?.prevClose ?? null,
          fetchedAt: now,
        });
      }
    }

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
      await writeEdgeHistory(id, entry);
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

  // 上游失败时优先用 Edge Cache 里最近一次成功的数据，避免图表变空
  const edge = await readEdgeHistory(id);
  if (edge) {
    state.historyCache.set(id, edge);
    if (!hasEastmoneyQuote(id)) {
      state.sessionSeries.set(
        id,
        mergeSeries(state.sessionSeries.get(id) ?? [], edge.points),
      );
    }
    return {
      id,
      prevClose: prevClose ?? edge.prevClose,
      points: edge.points,
      source: 'eastmoney' as const,
      fetchedAt: edge.fetchedAt,
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
    // 有东财分时的品种走到这里说明上游失败，标记 stale 让前端稍后重试
    stale: hasEastmoneyQuote(id) ? true : points.length === 0,
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

  // 构造订阅记录：已存在时保留 runtime / createdAt
  // 否则每次页面加载重新 subscribe 都会把到价状态重置，导致重复推送
  const key = makeKey(endpoint);
  const existingRaw = await env.PUSH_KV.get(key);
  let record: PushSubscriptionRecord;
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw) as PushSubscriptionRecord;
      record = {
        ...existing,
        endpoint,
        p256dh,
        auth,
        targets: normalizeTargets(targets),
        updatedAt: Date.now(),
      };
    } catch {
      record = createNewRecord(endpoint, p256dh, auth, targets);
    }
  } else {
    record = createNewRecord(endpoint, p256dh, auth, targets);
  }

  await env.PUSH_KV.put(key, JSON.stringify(record));

  return json({ ok: true, key });
}

function createNewRecord(
  endpoint: string,
  p256dh: string,
  auth: string,
  targets: PushTargets | undefined,
): PushSubscriptionRecord {
  return {
    endpoint,
    p256dh,
    auth,
    targets: normalizeTargets(targets),
    runtime: createDefaultRuntime(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
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

    // 逐个订阅评估并发推送；同一轮多个品种同时到价时逐条发送，避免只发第一条
    const outcomes = await Promise.all(
      subscriptions.map(async ({ record, key }) => {
        const alerts = evaluateAlertsForSubscription(record, snapshot, now);
        if (alerts.length === 0) return { record, key, dead: false as const, ok: undefined };

        const results = await Promise.all(
          alerts.map((alert) =>
            sendWebPush(
              record.endpoint,
              env.VAPID_PRIV,
              VAPID_PUB,
              'mailto:goldwatch@ichenghub.cn',
              record.p256dh,
              record.auth,
              JSON.stringify({ title: alert.title, body: alert.body, tag: alert.tag }),
            ),
          ),
        );

        const dead = results.some((result) => result.statusCode === 404 || result.statusCode === 410);
        const ok = results.every((result) => result.ok);
        for (const result of results) {
          if (!result.ok && !dead) console.warn('[Cron] 推送失败', result);
        }
        return { record, key, dead, ok };
      }),
    );

    // 成功或无需推送时保存 runtime；临时失败不保存，下一轮重试
    for (const { record, key, dead, ok } of outcomes) {
      if (dead) {
        await env.PUSH_KV.delete(key);
        console.warn('[Cron] 推送端点已失效，清理订阅', key);
        continue;
      }
      if (ok !== false) await env.PUSH_KV.put(key, JSON.stringify(record));
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
      <li><code>POST /api/push/subscribe</code><span>注册推送订阅</span></li>
    </ul>
    <p class="foot">支持品种：伦敦金 · 沪金99 · 黄金T+D · 浙商积存金 · 民生积存金</p>
  </main>
</body>
</html>
`;
