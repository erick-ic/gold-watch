import type { Quote } from '../../shared/types.js';
import { fetchJson, JD_GOLD_HEADERS, positiveOrNull, toFiniteNumber } from '../http.js';

const ZHESHANG_SKU = '1961543816';
const ZHESHANG_URL =
  `https://api.jdjygold.com/gw2/generic/jrm/h5/m/stdLatestPrice?productSku=${ZHESHANG_SKU}`;

interface JdGoldData {
  price?: string | number;
  yesterdayPrice?: string | number;
  time?: string | number;
}

interface JdGoldResponse {
  success?: boolean;
  resultData?: {
    datas?: JdGoldData | null;
    status?: string;
  } | null;
}

export function parseJdGoldResponse(payload: JdGoldResponse): Quote | null {
  const data = payload.resultData?.datas;
  if (!data) return null;

  const price = positiveOrNull(toFiniteNumber(data.price));
  if (price === null) return null;

  const prevClose = positiveOrNull(toFiniteNumber(data.yesterdayPrice));
  const change = prevClose === null ? null : price - prevClose;
  const changePct = prevClose === null || prevClose === 0 ? null : (change! / prevClose) * 100;
  const rawTime = toFiniteNumber(data.time);
  const quoteTime =
    rawTime !== null && rawTime > 0 ? (rawTime < 1_000_000_000_000 ? rawTime * 1000 : rawTime) : null;

  return {
    id: 'zsjcg',
    price,
    bid: null,
    ask: null,
    prevClose,
    open: null,
    high: null,
    low: null,
    change,
    changePct,
    quoteTime,
    source: 'jd',
    derived: false,
    stale: false,
  };
}

export async function fetchZheshangGoldQuote(): Promise<Quote | null> {
  const payload = await fetchJson<JdGoldResponse>(ZHESHANG_URL, {
    method: 'POST',
    headers: JD_GOLD_HEADERS,
    body: JSON.stringify({ reqData: { productSku: ZHESHANG_SKU } }),
  });
  return parseJdGoldResponse(payload);
}
