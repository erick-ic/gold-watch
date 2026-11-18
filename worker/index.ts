import { INSTRUMENT_IDS, TROY_OUNCE_GRAMS, type InstrumentId } from '../shared/instruments';
import type { HistoryPoint, MarketSession, MarketSnapshot, Quote } from '../shared/types';
import { getMarketSession } from '../shared/sessions';
import { fetchEastmoneyHistory, fetchEastmoneyQuotes, hasEastmoneyQuote } from '../server/data/eastmoney';
import { fetchZheshangGoldQuote } from '../server/data/jdgold';
import { fetchGoldSpotUsd, fetchUsdCny } from '../server/data/fallback';
import { fetchSinaSnapshot } from '../server/data/sina';

// Worker 环境下 TTL 延长到 15s，避免频繁刷新触发 CPU 超限
// （Cloudflare Worker 免费版仅 10ms CPU/请求，刷新一次约 8-12ms）
const CACHE_TTL_MS = 15_000;
const QUOTE_STALE_MS = 120_000;
const HISTORY_TTL_MS = 30_000;

interface HistoryCacheEntry {
  points: HistoryPoint[];
  prevClose: number | null;
  fetchedAt: number;
}

interface WorkerState {
  snapshot: MarketSnapshot | null;
  fetchedAt: number;
  inFlight: Promise<MarketSnapshot | null> | null;
  sessionSeries: Map<InstrumentId, HistoryPoint[]>;
  historyCache: Map<InstrumentId, HistoryCacheEntry>;
}

// Worker isolate 内模块级状态跨请求保留，充当快照缓存与分时采样累积器
const state: WorkerState = {
  snapshot: null,
  fetchedAt: 0,
  inFlight: null,
  sessionSeries: new Map(),
  historyCache: new Map(),
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

async function refreshQuotes(): Promise<MarketSnapshot | null> {
  if (state.snapshot && Date.now() - state.fetchedAt < CACHE_TTL_MS) return state.snapshot;
  if (state.inFlight) return state.inFlight;

  state.inFlight = (async (): Promise<MarketSnapshot | null> => {
    const previous = state.snapshot;

    // 并行发起所有上游请求——最大化网络等待重叠，避免串行判断的 CPU 开销
    const sinaP = fetchSinaSnapshot().catch(() => null);
    const eastmoneyP = fetchEastmoneyQuotes(INSTRUMENT_IDS.filter(hasEastmoneyQuote)).catch(() => []);
    const zheshangP = fetchZheshangGoldQuote().catch(() => null);
    const goldApiP = fetchGoldSpotUsd().catch(() => null);
    const usdcnyP = fetchUsdCny().catch(() => null);

    const [sina, eastmoneyQuotes, zheshangQuote, goldPrice, usdcnyResult] = await Promise.all([
      sinaP, eastmoneyP, zheshangP, goldApiP, usdcnyP,
    ]);

    const quotes = new Map<InstrumentId, Quote>();
    let usdcny: number | null = usdcnyResult ?? null;

    // 新浪
    if (sina) {
      for (const q of sina.quotes) quotes.set(q.id, q);
      if (usdcny === null) usdcny = sina.usdcny;
    }

    // 东方财富（新浪未覆盖的品种）
    for (const q of eastmoneyQuotes) {
      if (!quotes.has(q.id)) quotes.set(q.id, q);
    }

    // 浙商积存金
    if (zheshangQuote) quotes.set(zheshangQuote.id, zheshangQuote);

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
  })().finally(() => {
    state.inFlight = null;
  });

  return state.inFlight;
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

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
      if (request.method !== 'GET') return json({ error: 'Method Not Allowed' }, 405);

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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 保留旧快照（如有），返回 503 而非裸 500，让前端有机会继续显示旧数据
      if (state.snapshot) return json(state.snapshot);
      return json({ error: `服务暂时不可用: ${message}` }, 503);
    }
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
    </ul>
    <p class="foot">支持品种：伦敦金 · 沪金99 · 黄金T+D · 浙商积存金</p>
  </main>
</body>
</html>
`;
