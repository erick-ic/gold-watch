import type { Quote } from '../../shared/types.js';
import type { InstrumentId } from '../../shared/instruments.js';
import { fetchText, positiveOrNull, SINA_HEADERS, toFiniteNumber } from '../http.js';

const SINA_QUOTE_URL =
  'https://hq.sinajs.cn/list=hf_XAU,gds_AU9999,gds_AUTD,fx_susdcny';

export interface SinaSnapshot {
  quotes: Quote[];
  usdcny: number | null;
}

export function parseBeijingDateTime(date?: string, time?: string): number | null {
  if (!date || !time) return null;
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time.trim());
  if (!dateMatch || !timeMatch) return null;
  const ms = Date.parse(
    `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3] ?? '00'}+08:00`,
  );
  return Number.isFinite(ms) ? ms : null;
}

function buildQuote(id: InstrumentId, fields: string[]): Quote | null {
  const price = positiveOrNull(toFiniteNumber(fields[0]));
  if (price === null) return null;

  const prevClose = positiveOrNull(toFiniteNumber(fields[7]));
  const change = prevClose === null ? null : price - prevClose;
  const changePct = prevClose === null || prevClose === 0 ? null : (change! / prevClose) * 100;

  return {
    id,
    price,
    bid: positiveOrNull(toFiniteNumber(fields[2])),
    ask: positiveOrNull(toFiniteNumber(fields[3])),
    prevClose,
    open: positiveOrNull(toFiniteNumber(fields[8])),
    high: positiveOrNull(toFiniteNumber(fields[4])),
    low: positiveOrNull(toFiniteNumber(fields[5])),
    change,
    changePct,
    quoteTime: parseBeijingDateTime(fields[12], fields[6]),
    source: 'sina',
    derived: false,
    stale: false,
  };
}

export function parseSinaResponse(text: string): SinaSnapshot {
  const quotes: Quote[] = [];
  let usdcny: number | null = null;

  for (const match of text.matchAll(/var hq_str_([a-zA-Z0-9_]+)="([^"]*)";/g)) {
    const symbol = match[1];
    const fields = match[2].split(',');
    if (symbol === 'hf_XAU') {
      const quote = buildQuote('xauusd', fields);
      if (quote) quotes.push(quote);
    } else if (symbol === 'gds_AU9999') {
      const quote = buildQuote('au9999', fields);
      if (quote) quotes.push(quote);
    } else if (symbol === 'gds_AUTD') {
      const quote = buildQuote('autd', fields);
      if (quote) quotes.push(quote);
    } else if (symbol === 'fx_susdcny') {
      const bid = toFiniteNumber(fields[1]);
      const ask = toFiniteNumber(fields[2]);
      const mid = bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask);
      if (mid !== null && mid > 3 && mid < 15) usdcny = mid;
    }
  }

  if (quotes.length === 0) {
    throw new Error('新浪行情返回为空');
  }
  return { quotes, usdcny };
}

export async function fetchSinaSnapshot(): Promise<SinaSnapshot> {
  const text = await fetchText(SINA_QUOTE_URL, { headers: SINA_HEADERS });
  return parseSinaResponse(text);
}
