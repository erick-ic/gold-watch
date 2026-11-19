import { INSTRUMENT_IDS, TROY_OUNCE_GRAMS, type InstrumentId } from '../../shared/instruments.js';
import type {
  HistoryPoint,
  MarketSession,
  MarketSnapshot,
  Quote,
  QuoteSource,
} from '../../shared/types.js';
import { getMarketSession } from '../../shared/sessions.js';
import { fetchEastmoneyQuotes, fetchEastmoneyHistory, hasEastmoneyQuote } from './eastmoney.js';
import { fetchMinshengGoldQuote, fetchZheshangGoldQuote } from './jdgold.js';
import { fetchGoldSpotUsd, fetchUsdCny } from './fallback.js';
import { appendSample } from './sessionSeries.js';
import { fetchSinaSnapshot } from './sina.js';
import { fetchSinaForexHistory, fetchSinaHistory } from './sinaHistory.js';
import { fetchSgeHistory } from './sgeHistory.js';
import {
  HISTORY_MAX_POINTS,
  HISTORY_TTL_MS,
  POLL_INTERVAL_MS,
  QUOTE_STALE_MS,
  STALE_AFTER_MS,
} from '../config.js';

/** 无第三方分时接口的品种，由服务端按轮询节奏累积采样点 */
const sessionSeries = new Map<InstrumentId, HistoryPoint[]>();

/** 银行积存金刷新节流：源本身更新慢，避免 2s 轮询把它们打成高频请求 */
const BANK_GOLD_MIN_REFRESH_MS = 6000;

/** 东财报价失败后的重试间隔，避免在接口不可达时每 2s 反复撞墙 */
const EASTMONEY_QUOTES_BACKOFF_MS = 60_000;

/** 日志里使用的行情来源中文名 */
const QUOTE_SOURCE_LABELS: Record<Quote['source'], string> = {
  sina: '新浪财经',
  eastmoney: '东方财富',
  jd: '京东金融',
  'gold-api': 'gold-api',
  derived: '参考换算',
};

/** 合并两组采样点（时间戳去重、升序、保留最近 max 个） */
function mergeSeries(
  base: readonly HistoryPoint[],
  incoming: readonly HistoryPoint[],
  max = HISTORY_MAX_POINTS,
): HistoryPoint[] {
  const map = new Map<number, number>();
  for (const point of [...base, ...incoming]) {
    if (Number.isFinite(point.t) && Number.isFinite(point.p) && point.p > 0) {
      map.set(point.t, point.p);
    }
  }
  const sorted = [...map.entries()].sort((a, b) => a[0] - b[0]);
  const trimmed = sorted.length > max ? sorted.slice(sorted.length - max) : sorted;
  return trimmed.map(([t, p]) => ({ t, p }));
}

/**
 * 沪金主力连续与 Au99.99 / T+D 存在基差，按最新价做整体平移，
 * 让备用走势与卡片上的真实报价对齐（只平移不改形）
 */
function alignToPrice(points: HistoryPoint[], price: number | null): HistoryPoint[] {
  if (price === null || points.length === 0) return points;
  const offset = price - points[points.length - 1].p;
  if (!Number.isFinite(offset) || Math.abs(offset) < 1e-6) return points;
  return points.map((point) => ({ t: point.t, p: round2(point.p + offset) }));
}

/**
 * 对齐并校验：末尾与现价偏离超过 3% 视为数据异常（错合约/异常延迟），直接判失败
 */
function alignAndValidate(points: HistoryPoint[], price: number | null): HistoryPoint[] | null {
  if (price === null || points.length === 0) return points;
  const last = points[points.length - 1].p;
  if (!Number.isFinite(last) || last <= 0) return null;
  if (Math.abs(price - last) / price > 0.03) return null;
  return alignToPrice(points, price);
}

class MarketService {
  private latest: MarketSnapshot | null = null;
  private lastSuccessAt: number | null = null;
  private lastError: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<MarketSnapshot | null> | null = null;
  private listeners = new Set<(snapshot: MarketSnapshot) => void>();
  private sourceCounts = new Map<QuoteSource, number>();
  private errorLoggedAt = 0;
  private lastZheshangFetchAt = 0;
  private lastMinshengFetchAt = 0;
  private eastmoneyQuotesRetryAt = 0;

  getSnapshot(): MarketSnapshot | null {
    return this.latest;
  }

  getLastSuccessAt(): number | null {
    return this.lastSuccessAt;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getSourceCounts(): Record<string, number> {
    return Object.fromEntries(this.sourceCounts);
  }

  isStale(now = Date.now()): boolean {
    return this.lastSuccessAt === null || now - this.lastSuccessAt > STALE_AFTER_MS;
  }

  onUpdate(listener: (snapshot: MarketSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.timer) return;
    void this.refresh().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.refresh().catch(() => undefined);
    }, POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  async refresh(): Promise<MarketSnapshot | null> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<MarketSnapshot> {
    const previous = this.latest;

    // 并行发起所有上游请求——最大化网络等待重叠
    // 与 Worker 版本保持一致的并行策略，避免串行超时累积
    const nowForFresh = Date.now();
    const refreshZheshang = nowForFresh - this.lastZheshangFetchAt >= BANK_GOLD_MIN_REFRESH_MS;
    if (refreshZheshang) this.lastZheshangFetchAt = nowForFresh;
    const refreshMinsheng = nowForFresh - this.lastMinshengFetchAt >= BANK_GOLD_MIN_REFRESH_MS;
    if (refreshMinsheng) this.lastMinshengFetchAt = nowForFresh;

    const sinaP = fetchSinaSnapshot().catch((e) => { this.noteError(e); return null; });
    const zheshangP = refreshZheshang
      ? fetchZheshangGoldQuote().catch((e) => { this.noteError(e); return null; })
      : Promise.resolve(null);
    const minshengP = refreshMinsheng
      ? fetchMinshengGoldQuote().catch((e) => { this.noteError(e); return null; })
      : Promise.resolve(null);
    const goldApiP = fetchGoldSpotUsd().catch(() => null);
    const usdcnyP = fetchUsdCny().catch(() => null);

    // 先等主数据源（新浪 + 两家银行），它们覆盖了全部品种
    const [sina, zheshangQuote, minshengQuote] = await Promise.all([sinaP, zheshangP, minshengP]);

    const quotes = new Map<InstrumentId, Quote>();
    let usdcny: number | null = sina?.usdcny ?? null;

    if (sina) {
      for (const q of sina.quotes) quotes.set(q.id, q);
    }
    if (zheshangQuote) {
      quotes.set(zheshangQuote.id, zheshangQuote);
    } else if (!refreshZheshang) {
      // 节流窗口内沿用上一轮报价，但不打 stale 标记（仍在有效期）
      const previousZsjcg = previous?.quotes.find((quote) => quote.id === 'zsjcg');
      if (previousZsjcg) quotes.set('zsjcg', previousZsjcg);
    }
    if (minshengQuote) {
      quotes.set(minshengQuote.id, minshengQuote);
    } else if (!refreshMinsheng) {
      const previousMsjcg = previous?.quotes.find((quote) => quote.id === 'msjcg');
      if (previousMsjcg) quotes.set('msjcg', previousMsjcg);
    }

    // 判断哪些品种需要备用源补充：主数据源缺失 OR 行情过旧
    const FRESH_MS = 60_000; // 主源报价超过 60s 视为需要备用源刷新（仅开盘时段判断）
    const needsEastmoney = INSTRUMENT_IDS.some((id) => {
      if (!hasEastmoneyQuote(id)) return false;
      const q = quotes.get(id);
      if (!q) return true;
      if (getMarketSession(id, nowForFresh).phase !== 'open') return false;
      return q.quoteTime === null || nowForFresh - q.quoteTime > FRESH_MS;
    });
    const needsGoldApi = !quotes.has('xauusd');
    const needsUsdcny = usdcny === null && !quotes.has('au9999');

    // 东财报价只在主源缺失/过旧时才发起，避免每轮都去撞一个可能被限流的接口
    const eastmoneyIds = INSTRUMENT_IDS.filter(hasEastmoneyQuote);
    const loadEastmoneyQuotes = (): Promise<Quote[]> => {
      if (Date.now() < this.eastmoneyQuotesRetryAt) return Promise.resolve([] as Quote[]);
      return fetchEastmoneyQuotes(eastmoneyIds).catch((e) => {
        this.eastmoneyQuotesRetryAt = Date.now() + EASTMONEY_QUOTES_BACKOFF_MS;
        const detail = e instanceof Error ? e.message : String(e);
        // 只统计受影响品种当前的实际来源，避免把银行积存金的来源也算进来
        const sources = new Set<string>();
        for (const id of eastmoneyIds) {
          const source = quotes.get(id)?.source;
          if (source && source !== 'derived') sources.add(QUOTE_SOURCE_LABELS[source]);
        }
        const sourceText =
          sources.size > 0
            ? `当前报价来自${[...sources].join('、')}`
            : '当前无可用报价';
        this.noteError(
          new Error(`${detail}；${EASTMONEY_QUOTES_BACKOFF_MS / 1000}s 后重试，${sourceText}`),
        );
        return [] as Quote[];
      });
    };

    // 按需等待备用源——主源已覆盖时不被备用源的慢请求拖住
    const [eastmoneyQuotes, goldPrice, usdcnyResult] = await Promise.all([
      needsEastmoney ? loadEastmoneyQuotes() : Promise.resolve([] as Quote[]),
      needsGoldApi ? goldApiP : Promise.resolve(null as number | null),
      needsUsdcny ? usdcnyP : Promise.resolve(null as number | null),
    ]);

    // 东方财富作为备用源：取时间更新的行情（避免旧数据覆盖新数据）
    for (const q of eastmoneyQuotes) {
      const existing = quotes.get(q.id);
      if (!existing || (q.quoteTime ?? 0) > (existing.quoteTime ?? 0)) quotes.set(q.id, q);
    }
    if (usdcny === null) usdcny = usdcnyResult ?? null;

    // gold-api 兜底 xauusd
    if (!quotes.has('xauusd') && goldPrice !== null) {
      quotes.set('xauusd', {
        id: 'xauusd',
        price: goldPrice,
        bid: null,
        ask: null,
        prevClose: null,
        open: null,
        high: null,
        low: null,
        change: null,
        changePct: null,
        quoteTime: Date.now(),
        source: 'gold-api',
        derived: false,
        stale: false,
      });
    }

    // 沪金衍生换算（当新浪/东财都不给 au9999 时用 XAUUSD + 汇率推导）
    if (!quotes.has('au9999') && usdcny !== null) {
      const xau = quotes.get('xauusd');
      if (xau) {
        const price = round2((xau.price * usdcny) / TROY_OUNCE_GRAMS);
        quotes.set('au9999', {
          id: 'au9999',
          price,
          bid: null,
          ask: null,
          prevClose: null,
          open: null,
          high: null,
          low: null,
          change: null,
          changePct: null,
          quoteTime: Date.now(),
          source: 'derived',
          derived: true,
          stale: false,
        });
      }
    }

    // 缺失品种回退到上一次快照并标记 stale
    for (const id of INSTRUMENT_IDS) {
      if (!quotes.has(id)) {
        const old = previous?.quotes.find((quote) => quote.id === id);
        if (old) quotes.set(id, { ...old, stale: true });
      }
    }

    if (!usdcny) usdcny = previous?.usdcny ?? null;

    if (quotes.size === 0) {
      this.lastError = '全部行情源均不可用';
      throw new Error(this.lastError);
    }

    const orderedQuotes = INSTRUMENT_IDS.map((id) => quotes.get(id)).filter(
      (quote): quote is Quote => quote !== undefined,
    );
    const now = Date.now();
    const sessions = Object.fromEntries(
      INSTRUMENT_IDS.map((id) => [id, getMarketSession(id, now)]),
    ) as Record<InstrumentId, MarketSession>;

    // 交易时段内报价停止更新才标记延迟；休市时的旧报价属于正常收盘价
    const annotatedQuotes = orderedQuotes.map((quote) => {
      if (quote.stale || sessions[quote.id].phase !== 'open' || quote.quoteTime === null) {
        return quote;
      }
      return now - quote.quoteTime > QUOTE_STALE_MS ? { ...quote, stale: true } : quote;
    });

    // 所有品种都累积采样：东方财富分时接口常被限流/重置，
    // 此时用它作为图表兜底，避免分时区整块空白
    for (const quote of annotatedQuotes) {
      const points = sessionSeries.get(quote.id) ?? [];
      sessionSeries.set(
        quote.id,
        appendSample(points, { t: quote.quoteTime ?? now, p: quote.price }, HISTORY_MAX_POINTS),
      );
    }

    const degraded =
      annotatedQuotes.length < INSTRUMENT_IDS.length ||
      annotatedQuotes.some((quote) => quote.stale) ||
      usdcny === null;

    const snapshot: MarketSnapshot = {
      fetchedAt: now,
      usdcny,
      quotes: annotatedQuotes,
      sessions,
      degraded,
    };

    this.latest = snapshot;
    this.lastSuccessAt = now;
    this.lastError = null;
    for (const quote of annotatedQuotes) {
      this.sourceCounts.set(quote.source, (this.sourceCounts.get(quote.source) ?? 0) + 1);
    }

    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.noteError(error);
      }
    }
    return snapshot;
  }

  private noteError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.lastError = message;
    const now = Date.now();
    if (now - this.errorLoggedAt > 60_000) {
      this.errorLoggedAt = now;
      console.warn(`[quotes] ${message}`);
    }
  }
}

export const marketService = new MarketService();

type HistorySource = 'eastmoney' | 'sina' | 'sge' | 'session';

interface HistoryResult {
  points: HistoryPoint[];
  prevClose: number | null;
}

interface HistoryProvider {
  /** 冷却键：同源不同接口分开计数 */
  key: string;
  source: Exclude<HistorySource, 'session'>;
  supports: (id: InstrumentId) => boolean;
  fetch: (id: InstrumentId, price: number | null) => Promise<HistoryResult | null>;
}

/** 单个来源失败后冷却一段时间，连续失败时按指数退避，避免持续撞限流 */
const HISTORY_FAILURE_COOLDOWN_MS = 60_000;
const HISTORY_BACKOFF_MAX_MS = 10 * 60_000;
const historyCooldown = new Map<string, number>();
const historyFailureCount = new Map<string, number>();

/** 记录来源失败并进入冷却，返回冷却截止时间 */
export function markHistoryProviderFailure(key: string, now = Date.now()): number {
  const failures = (historyFailureCount.get(key) ?? 0) + 1;
  historyFailureCount.set(key, failures);
  const cooldownMs = Math.min(
    HISTORY_FAILURE_COOLDOWN_MS * 2 ** (failures - 1),
    HISTORY_BACKOFF_MAX_MS,
  );
  const until = now + cooldownMs;
  historyCooldown.set(key, until);
  return until;
}

/** 来源恢复后清零失败计数 */
function markHistoryProviderSuccess(key: string): void {
  historyFailureCount.delete(key);
}

/** 清空冷却状态（测试用） */
export function clearHistoryCooldowns(): void {
  historyCooldown.clear();
  historyFailureCount.clear();
}

const historyCache = new Map<
  InstrumentId,
  { data: HistoryResult & { fetchedAt: number }; source: Exclude<HistorySource, 'session'>; at: number }
>();

/**
 * 分时来源池：每个品种保持三个来源，东财被限流时仍有两条独立链路
 * - 伦敦金：东财 / 新浪外盘期货 / 新浪外汇现货
 * - 沪金：  东财 / 新浪内盘沪金主力 / 上金所官网
 */
const HISTORY_PROVIDERS: HistoryProvider[] = [
  {
    key: 'eastmoney',
    source: 'eastmoney',
    supports: (id) => hasEastmoneyQuote(id),
    fetch: (id) => fetchEastmoneyHistory(id),
  },
  {
    key: 'sina-futures',
    source: 'sina',
    supports: (id) => id === 'xauusd' || id === 'au9999' || id === 'autd',
    fetch: async (id, price) => {
      const result = await fetchSinaHistory(id);
      if (!result) return null;
      // 沪金主力与现货有基差，按现价平移对齐
      if (id === 'xauusd') return result;
      const aligned = alignAndValidate(result.points, price);
      return aligned ? { ...result, points: aligned } : null;
    },
  },
  {
    key: 'sina-forex',
    source: 'sina',
    supports: (id) => id === 'xauusd',
    fetch: () => fetchSinaForexHistory(),
  },
  {
    key: 'sge',
    source: 'sge',
    supports: (id) => id === 'au9999' || id === 'autd',
    fetch: async (id, price) => {
      const result = await fetchSgeHistory(id);
      if (!result) return null;
      // 官网分时偶有延迟，同样按现价对齐并做偏差校验
      const aligned = alignAndValidate(result.points, price);
      return aligned ? { ...result, points: aligned } : null;
    },
  },
];

/** 随机打乱候选来源；处于冷却期的来源优先排除 */
export function pickHistoryProviders(id: InstrumentId, now = Date.now()): HistoryProvider[] {
  const candidates = HISTORY_PROVIDERS.filter((provider) => provider.supports(id));
  const ready = candidates.filter((provider) => (historyCooldown.get(provider.key) ?? 0) <= now);
  const order = [...(ready.length > 0 ? ready : candidates)];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

export async function getHistory(
  id: InstrumentId,
  prevClose: number | null,
  price: number | null = null,
): Promise<{
  id: InstrumentId;
  prevClose: number | null;
  points: HistoryPoint[];
  source: HistorySource;
  fetchedAt: number;
  stale: boolean;
}> {
  const cached = historyCache.get(id);
  if (cached && Date.now() - cached.at < HISTORY_TTL_MS) {
    return {
      id,
      prevClose: prevClose ?? cached.data.prevClose,
      // 分钟线用本地采样补上最新尾巴
      points: mergeSeries(cached.data.points, sessionSeries.get(id) ?? []),
      source: cached.source,
      fetchedAt: cached.data.fetchedAt,
      stale: false,
    };
  }

  // 随机顺序尝试三个来源，失败自动顺延下一个
  for (const provider of pickHistoryProviders(id)) {
    try {
      const result = await provider.fetch(id, price);
      if (!result || result.points.length === 0) {
        // 空结果同样冷却，避免持续撞限流或坏数据
        markHistoryProviderFailure(provider.key);
        continue;
      }
      const fetchedAt = Date.now();
      markHistoryProviderSuccess(provider.key);
      historyCache.set(id, {
        data: { points: result.points, prevClose: result.prevClose, fetchedAt },
        source: provider.source,
        at: fetchedAt,
      });
      return {
        id,
        prevClose: prevClose ?? result.prevClose,
        points: mergeSeries(result.points, sessionSeries.get(id) ?? []),
        source: provider.source,
        fetchedAt,
        stale: false,
      };
    } catch (error) {
      // 连续失败只在第一次打日志，后续静默退避
      const firstFailure = !historyFailureCount.has(provider.key);
      markHistoryProviderFailure(provider.key);
      if (firstFailure) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[history:${provider.key}] ${id}: ${message}（已进入退避，稍后自动重试）`);
      }
    }
  }

  if (cached) {
    return {
      id,
      prevClose: prevClose ?? cached.data.prevClose,
      points: mergeSeries(cached.data.points, sessionSeries.get(id) ?? []),
      source: cached.source,
      fetchedAt: cached.data.fetchedAt,
      stale: true,
    };
  }

  const points = sessionSeries.get(id) ?? [];

  return {
    id,
    prevClose,
    points: [...points],
    source: 'session',
    fetchedAt: Date.now(),
    // 有分时来源的品种走到这里说明全部上游失败，标记 stale 让前端稍后重试
    stale: points.length === 0,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
