import type { InstrumentId } from '../../shared/instruments.js';
import type { Quote } from '../../shared/types.js';
import { fetchJson, JD_GOLD_HEADERS, positiveOrNull, toFiniteNumber } from '../http.js';

/** 京东金融代销的银行积存金 SKU */
const BANK_SKUS = {
  zsjcg: '1961543816',
  msjcg: '21001001000001',
} as const;

const LATEST_PRICE_URL = 'https://api.jdjygold.com/gw2/generic/jrm/h5/m/stdLatestPrice';

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

export function parseJdGoldResponse(payload: JdGoldResponse, id: InstrumentId = 'zsjcg'): Quote | null {
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
    id,
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

async function fetchBankGoldQuote(id: InstrumentId, sku: string): Promise<Quote | null> {
  const payload = await fetchJson<JdGoldResponse>(`${LATEST_PRICE_URL}?productSku=${sku}`, {
    method: 'POST',
    headers: JD_GOLD_HEADERS,
    body: JSON.stringify({ reqData: { productSku: sku } }),
  });
  return parseJdGoldResponse(payload, id);
}

export function fetchZheshangGoldQuote(): Promise<Quote | null> {
  return fetchBankGoldQuote('zsjcg', BANK_SKUS.zsjcg);
}

export function fetchMinshengGoldQuote(): Promise<Quote | null> {
  return fetchBankGoldQuote('msjcg', BANK_SKUS.msjcg);
}
