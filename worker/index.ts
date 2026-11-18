import { INSTRUMENT_IDS, TROY_OUNCE_GRAMS, type InstrumentId } from '../shared/instruments';
import type { HistoryPoint, MarketSession, MarketSnapshot, Quote } from '../shared/types';
import { getMarketSession } from '../shared/sessions';
import { fetchEastmoneyHistory, fetchEastmoneyQuotes, hasEastmoneyQuote } from '../server/data/eastmoney';
import { fetchZheshangGoldQuote } from '../server/data/jdgold';
import { fetchGoldSpotUsd, fetchUsdCny } from '../server/data/fallback';
import { appendSample } from '../server/data/sessionSeries';
import { fetchSinaSnapshot } from '../server/data/sina';

// 与 server/config.ts 对齐；serverless 下不用 SSE 与限流相关配置
const CACHE_TTL_MS = 4_000;
const QUOTE_STALE_MS = 120_000;
const HISTORY_TTL_MS = 30_000;
const HISTORY_MAX_POINTS = 900;

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
    const quotes = new Map<InstrumentId, Quote>();
    let usdcny: number | null = null;

    try {
      const sina = await fetchSinaSnapshot();
      for (const quote of sina.quotes) quotes.set(quote.id, quote);
      usdcny = sina.usdcny;
    } catch {
      // 单个行情源失败时继续尝试其他源
    }

    const missing = INSTRUMENT_IDS.filter((id) => !quotes.has(id) && hasEastmoneyQuote(id));
    if (missing.length > 0) {
      try {
        const eastmoneyQuotes = await fetchEastmoneyQuotes(missing);
        for (const quote of eastmoneyQuotes) quotes.set(quote.id, quote);
      } catch {
        // 同上
      }
    }

    if (!quotes.has('zsjcg')) {
      try {
        const quote = await fetchZheshangGoldQuote();
        if (quote) quotes.set(quote.id, quote);
      } catch {
        // 同上
      }
    }

    if (!quotes.has('xauusd')) {
      try {
        const usdPrice = await fetchGoldSpotUsd();
        if (usdPrice !== null) {
          quotes.set('xauusd', {
            id: 'xauusd',
            price: usdPrice,
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
      } catch {
        // 同上
      }
    }

    if (usdcny === null) {
      try {
        usdcny = await fetchUsdCny();
      } catch {
        // 汇率仅用于参考换算，失败时静默降级
      }
    }

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

    for (const id of INSTRUMENT_IDS) {
      if (!quotes.has(id)) {
        const old = previous?.quotes.find((quote) => quote.id === id);
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

    for (const quote of annotatedQuotes) {
      if (hasEastmoneyQuote(quote.id)) continue;
      const points = state.sessionSeries.get(quote.id) ?? [];
      state.sessionSeries.set(
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
