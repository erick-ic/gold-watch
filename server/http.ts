import { FETCH_TIMEOUT_MS } from './config.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

export const SINA_HEADERS = {
  'User-Agent': USER_AGENT,
  Referer: 'https://finance.sina.com.cn/',
} as const;

export const EASTMONEY_HEADERS = {
  'User-Agent': USER_AGENT,
  Referer: 'https://quote.eastmoney.com/',
} as const;

export const JD_GOLD_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'User-Agent': USER_AGENT,
  Origin: 'https://www.jd.com',
  Referer: 'https://www.jd.com/',
} as const;

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Accept-Language': 'zh-CN,zh;q=0.9', ...init.headers },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  }
  return response;
}

export async function fetchText(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<string> {
  const response = await fetchWithTimeout(url, init, timeoutMs);
  const buffer = await response.arrayBuffer();
  const contentType = response.headers.get('content-type') ?? '';
  const encoding = /gb18030|gbk|gb2312/i.test(contentType) ? 'gb18030' : 'utf-8';
  return new TextDecoder(encoding).decode(buffer);
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<T> {
  const response = await fetchWithTimeout(url, init, timeoutMs);
  return (await response.json()) as T;
}

export function toFiniteNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function positiveOrNull(value: number | null): number | null {
  return value !== null && value > 0 ? value : null;
}
