import { INSTRUMENT_IDS, TROY_OUNCE_GRAMS, type InstrumentId } from '../../shared/instruments.js';
import type {
  HistoryPoint,
  MarketSession,
  MarketSnapshot,
  Quote,
  QuoteSource,
} from '../../shared/types.js';
import { getMarketSession } from '../../shared/sessions.js';
import { fetchEastmoneyQuotes, fetchEastmoneyHistory, hasEastmoneyQuote, type EastmoneyHistory } from './eastmoney.js';
import { fetchZheshangGoldQuote } from './jdgold.js';
import { fetchGoldSpotUsd, fetchUsdCny } from './fallback.js';
import { appendSample } from './sessionSeries.js';
import { fetchSinaSnapshot } from './sina.js';
import {
  HISTORY_MAX_POINTS,
  HISTORY_TTL_MS,
  POLL_INTERVAL_MS,
  QUOTE_STALE_MS,
  STALE_AFTER_MS,
} from '../config.js';

/** 无第三方分时接口的品种，由服务端按轮询节奏累积采样点 */
const sessionSeries = new Map<InstrumentId, HistoryPoint[]>();

class MarketService {
  private latest: MarketSnapshot | null = null;
  private lastSuccessAt: number | null = null;
  private lastError: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<MarketSnapshot | null> | null = null;
  private listeners = new Set<(snapshot: MarketSnapshot) => void>();
  private sourceCounts = new Map<QuoteSource, number>();
  private errorLoggedAt = 0;

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
    const quotes = new Map<InstrumentId, Quote>();
    let usdcny: number | null = null;

    try {
      const sina = await fetchSinaSnapshot();
      for (const quote of sina.quotes) quotes.set(quote.id, quote);
      usdcny = sina.usdcny;
    } catch (error) {
      this.noteError(error);
    }

    const missing = INSTRUMENT_IDS.filter(
      (id) => !quotes.has(id) && hasEastmoneyQuote(id),
    );
    if (missing.length > 0) {
      try {
        const eastmoneyQuotes = await fetchEastmoneyQuotes(missing);
        for (const quote of eastmoneyQuotes) quotes.set(quote.id, quote);
      } catch (error) {
        this.noteError(error);
      }
    }

    if (!quotes.has('zsjcg')) {
      try {
        const quote = await fetchZheshangGoldQuote();
        if (quote) quotes.set(quote.id, quote);
      } catch (error) {
        this.noteError(error);
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
      } catch (error) {
        this.noteError(error);
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

    for (const quote of annotatedQuotes) {
      if (hasEastmoneyQuote(quote.id)) continue;
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

const historyCache = new Map<InstrumentId, { data: EastmoneyHistory & { fetchedAt: number }; at: number }>();

export async function getHistory(
  id: InstrumentId,
  prevClose: number | null,
): Promise<{
  id: InstrumentId;
  prevClose: number | null;
  points: EastmoneyHistory['points'];
  source: 'eastmoney' | 'session';
  fetchedAt: number;
  stale: boolean;
}> {
  const cached = historyCache.get(id);
  if (cached && Date.now() - cached.at < HISTORY_TTL_MS) {
    return {
      id,
      prevClose: prevClose ?? cached.data.prevClose,
      points: cached.data.points,
      source: 'eastmoney',
      fetchedAt: cached.data.fetchedAt,
      stale: false,
    };
  }

  try {
    const history = await fetchEastmoneyHistory(id);
    if (history) {
      const fetchedAt = Date.now();
      historyCache.set(id, { data: { ...history, fetchedAt }, at: fetchedAt });
      return {
        id,
        prevClose: prevClose ?? history.prevClose,
        points: history.points,
        source: 'eastmoney',
        fetchedAt,
        stale: false,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[history] ${id}: ${message}`);
  }

  if (cached) {
    return {
      id,
      prevClose: prevClose ?? cached.data.prevClose,
      points: cached.data.points,
      source: 'eastmoney',
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
    stale: points.length === 0,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
