import type { HistoryPoint } from '../../shared/types.js';
import type { InstrumentId } from '../../shared/instruments.js';
import { HISTORY_MAX_POINTS } from '../config.js';
import { fetchText, SINA_HEADERS, toFiniteNumber } from '../http.js';
import { parseBeijingDateTime } from './sina.js';

/** 外盘期货分时（伦敦金 XAU） */
const GLOBAL_URL =
  'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/' +
  'GlobalFuturesService.getGlobalFuturesMinLine?symbol=XAU';

/** 内盘期货分时（沪金主力连续 AU0，作为上金所两个品种的备源） */
const INNER_URL =
  'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/' +
  'InnerFuturesNewService.getMinLine?symbol=AU0';

/** 外汇分时（XAU/USD 现货，作为伦敦金的第三方来源） */
const FOREX_URL =
  'https://vip.stock.finance.sina.com.cn/forex/api/jsonp.php/var%20t=/' +
  'NewForexService.getMinKLine?symbol=fx_sxauusd&scale=1&datalen=1440';

export interface SinaHistory {
  points: HistoryPoint[];
  prevClose: number | null;
}

/** 从 JSONP 包裹中取出 JSON 主体 */
function extractJsonpBody(text: string): string | null {
  const match = /var\s+t\s*=\s*\(([\s\S]*?)\)\s*;?\s*$/.exec(text);
  return match ? match[1] : null;
}

function capPoints(points: HistoryPoint[]): HistoryPoint[] {
  return points.length > HISTORY_MAX_POINTS ? points.slice(points.length - HISTORY_MAX_POINTS) : points;
}

/**
 * 解析外盘分时：`{ minLine_1d: [...] }`
 * 首行是表头（含日期、昨收、交易所），其余为 `[HH:mm, 价格, ..., 完整时间]`
 */
export function parseGlobalMinLine(text: string): SinaHistory | null {
  const body = extractJsonpBody(text);
  if (!body) return null;

  let payload: { minLine_1d?: unknown };
  try {
    payload = JSON.parse(body) as { minLine_1d?: unknown };
  } catch {
    return null;
  }
  const rows = payload?.minLine_1d;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const byTime = new Map<number, number>();
  let prevClose: number | null = null;

  for (const raw of rows) {
    if (!Array.isArray(raw) || raw.length < 2) continue;
    const cells = raw.map((cell) => String(cell));
    const isHeader = cells.length >= 10;
    const stamp = cells[cells.length - 1];
    const price = toFiniteNumber(isHeader ? cells[5] : cells[1]);

    const stampMatch = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(stamp);
    if (!stampMatch) continue;
    const time = parseBeijingDateTime(stampMatch[1], stampMatch[2]);
    if (time === null || price === null || price <= 0) continue;

    if (isHeader) {
      const close = toFiniteNumber(cells[1]);
      if (close !== null && close > 0) prevClose = close;
    }
    byTime.set(time, price);
  }

  if (byTime.size === 0) return null;
  const points = [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, p]) => ({ t, p }));
  return { points: capPoints(points), prevClose };
}

/**
 * 解析内盘分时：`[[HH:mm, 价格, 均价, 成交量, 持仓], ...]`
 * 首行末尾附带交易日，夜盘 21:00 起的行属于前一日历日，需要跨零点补日期
 */
export function parseInnerMinLine(text: string): SinaHistory | null {
  const body = extractJsonpBody(text);
  if (!body) return null;

  let rows: unknown;
  try {
    rows = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const first = Array.isArray(rows[0]) ? (rows[0] as unknown[]).map(String) : null;
  if (!first) return null;
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(first[first.length - 1]);
  if (!dateMatch) return null;

  const timeOf = (cells: string[]): { hh: number; mm: number } | null => {
    const match = /^(\d{2}):(\d{2})$/.exec(cells[0]);
    if (!match) return null;
    return { hh: Number(match[1]), mm: Number(match[2]) };
  };

  const firstTime = timeOf(first);
  if (!firstTime) return null;

  // 交易日 D 的夜盘从 D-1 的 21:00 开始，此时行的日历日应为 D-1
  let dayStart = Date.parse(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T00:00:00+08:00`);
  if (!Number.isFinite(dayStart)) return null;
  if (firstTime.hh * 60 + firstTime.mm >= 18 * 60) dayStart -= 24 * 60 * 60 * 1000;

  const byTime = new Map<number, number>();
  let previousMinute = -1;

  for (const raw of rows) {
    if (!Array.isArray(raw)) continue;
    const cells = raw.map((cell) => String(cell));
    const time = timeOf(cells);
    const price = toFiniteNumber(cells[1]);
    if (!time || price === null || price <= 0) continue;

    const minuteOfDay = time.hh * 60 + time.mm;
    // 时间回绕说明跨过零点
    if (previousMinute >= 0 && minuteOfDay < previousMinute) {
      dayStart += 24 * 60 * 60 * 1000;
    }
    previousMinute = minuteOfDay;

    const t = dayStart + (time.hh * 3600 + time.mm * 60) * 1000;
    byTime.set(t, price);
  }

  if (byTime.size === 0) return null;
  const points = [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, p]) => ({ t, p }));
  return { points: capPoints(points), prevClose: null };
}

/** 备用分时源：东财不可用时按品种选择新浪对应合约 */
export async function fetchSinaHistory(id: InstrumentId): Promise<SinaHistory | null> {
  if (id === 'xauusd') {
    const text = await fetchText(GLOBAL_URL, { headers: SINA_HEADERS });
    return parseGlobalMinLine(text);
  }
  if (id === 'au9999' || id === 'autd') {
    const text = await fetchText(INNER_URL, { headers: SINA_HEADERS });
    return parseInnerMinLine(text);
  }
  return null;
}

/**
 * 解析新浪外汇分时：`[{ d: "2026-11-19 07:07:00", o,l,h,c,... }, ...]`，取收盘价 c
 */
export function parseForexMinKline(text: string): SinaHistory | null {
  const body = extractJsonpBody(text);
  if (!body) return null;

  let rows: unknown;
  try {
    rows = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;

  const byTime = new Map<number, number>();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const stamp = String(row.d ?? '');
    const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(stamp);
    if (!match) continue;
    const time = parseBeijingDateTime(match[1], match[2]);
    const close = row.c;
    const price =
      typeof close === 'number' ? close : typeof close === 'string' ? toFiniteNumber(close) : null;
    if (time === null || price === null || price <= 0) continue;
    byTime.set(time, price);
  }

  if (byTime.size === 0) return null;
  const points = [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, p]) => ({ t, p }));
  return { points: capPoints(points), prevClose: null };
}

/** 新浪外汇分时（XAU/USD 现货） */
export async function fetchSinaForexHistory(): Promise<SinaHistory | null> {
  const text = await fetchText(FOREX_URL, { headers: SINA_HEADERS });
  return parseForexMinKline(text);
}
