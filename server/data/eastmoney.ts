import type { Quote, HistoryPoint } from '../../shared/types.js';
import type { InstrumentId } from '../../shared/instruments.js';
import {
  EASTMONEY_HEADERS,
  fetchJson,
  positiveOrNull,
  toFiniteNumber,
} from '../http.js';
import { HISTORY_MAX_POINTS } from '../config.js';
import { parseBeijingDateTime } from './sina.js';

const SECID_MAP: Partial<Record<InstrumentId, string>> = {
  xauusd: '122.XAU',
  au9999: '118.AU9999',
  autd: '118.AUTD',
};

export function hasEastmoneyQuote(id: InstrumentId): boolean {
  return SECID_MAP[id] !== undefined;
}

interface EastmoneyQuoteData {
  f43?: number | string;
  f44?: number | string;
  f45?: number | string;
  f46?: number | string;
  f57?: string;
  f58?: string;
  f59?: number | string;
  f60?: number | string;
  f86?: number | string;
}

interface EastmoneyQuoteResponse {
  rc?: number;
  data?: EastmoneyQuoteData | null;
}

interface EastmoneyTrendsData {
  code?: string;
  name?: string;
  decimal?: number;
  preClose?: number;
  preSettlement?: number;
  trends?: string[];
}

interface EastmoneyTrendsResponse {
  rc?: number;
  data?: EastmoneyTrendsData | null;
}

export interface EastmoneyHistory {
  points: HistoryPoint[];
  prevClose: number | null;
}

export async function fetchEastmoneyQuote(id: InstrumentId): Promise<Quote | null> {
  const secid = SECID_MAP[id];
  if (!secid) return null;
  const url =
    `https://push2.eastmoney.com/api/qt/stock/get?secid=${encodeURIComponent(secid)}` +
    '&fields=f43,f44,f45,f46,f57,f58,f59,f60,f86';
  const response = await fetchJson<EastmoneyQuoteResponse>(url, { headers: EASTMONEY_HEADERS });
  const data = response.data;
  if (!data) return null;

  const decimals = toFiniteNumber(data.f59) ?? 2;
  const scale = 10 ** decimals;
  const price = positiveOrNull(scaleValue(toFiniteNumber(data.f43), scale));
  if (price === null) return null;

  const prevClose = positiveOrNull(scaleValue(toFiniteNumber(data.f60), scale));
  const change = prevClose === null ? null : price - prevClose;
  const timestamp = toFiniteNumber(data.f86);

  return {
    id,
    price,
    bid: null,
    ask: null,
    prevClose,
    open: positiveOrNull(scaleValue(toFiniteNumber(data.f46), scale)),
    high: positiveOrNull(scaleValue(toFiniteNumber(data.f44), scale)),
    low: positiveOrNull(scaleValue(toFiniteNumber(data.f45), scale)),
    change,
    changePct: prevClose === null || prevClose === 0 ? null : (change! / prevClose) * 100,
    quoteTime: timestamp !== null && timestamp > 0 ? timestamp * 1000 : null,
    source: 'eastmoney',
    derived: false,
    stale: false,
  };
}

export async function fetchEastmoneyQuotes(ids: readonly InstrumentId[]): Promise<Quote[]> {
  const results = await Promise.allSettled(ids.map((id) => fetchEastmoneyQuote(id)));
  const quotes: Quote[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) quotes.push(result.value);
  }
  if (quotes.length === 0 && ids.length > 0) {
    throw new Error('东方财富行情不可用');
  }
  return quotes;
}

export async function fetchEastmoneyHistory(id: InstrumentId): Promise<EastmoneyHistory | null> {
  const secid = SECID_MAP[id];
  if (!secid) return null;
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${encodeURIComponent(secid)}` +
    '&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52&iscr=0&ndays=1';
  const response = await fetchJson<EastmoneyTrendsResponse>(url, { headers: EASTMONEY_HEADERS });
  const data = response.data;
  const trends = data?.trends;
  if (!data || !Array.isArray(trends) || trends.length === 0) return null;

  const byTime = new Map<number, number>();
  for (const row of trends) {
    const [stamp, priceRaw] = row.split(',');
    if (!stamp || priceRaw === undefined) continue;
    const [date, time] = stamp.trim().split(' ');
    const t = parseBeijingDateTime(date, time);
    const p = toFiniteNumber(priceRaw);
    if (t === null || p === null || p <= 0) continue;
    byTime.set(t, p);
  }

  const points = [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-HISTORY_MAX_POINTS)
    .map(([t, p]) => ({ t, p }));

  if (points.length === 0) return null;

  const prevCloseCandidate =
    toFiniteNumber(data.preClose) ?? toFiniteNumber(data.preSettlement) ?? null;
  return { points, prevClose: prevCloseCandidate };
}

function scaleValue(value: number | null, scale: number): number | null {
  return value === null ? null : value / scale;
}
