import { fetchJson, positiveOrNull, toFiniteNumber } from '../http.js';

interface GoldApiResponse {
  price?: number | string;
}

interface ErApiResponse {
  result?: string;
  rates?: Record<string, number>;
}

export async function fetchGoldSpotUsd(): Promise<number | null> {
  const response = await fetchJson<GoldApiResponse>('https://api.gold-api.com/price/XAU', {
    headers: { Accept: 'application/json' },
  });
  const price = positiveOrNull(toFiniteNumber(response.price));
  if (price === null || price < 100 || price > 100_000) return null;
  return price;
}

export async function fetchUsdCny(): Promise<number | null> {
  const response = await fetchJson<ErApiResponse>('https://open.er-api.com/v6/latest/USD', {
    headers: { Accept: 'application/json' },
  });
  if (response.result !== 'success') return null;
  const rate = positiveOrNull(toFiniteNumber(response.rates?.CNY));
  if (rate === null || rate < 3 || rate > 15) return null;
  return rate;
}
