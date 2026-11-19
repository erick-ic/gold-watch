import type { HistoryPoint } from '../../shared/types.js';
import type { InstrumentId } from '../../shared/instruments.js';
import { HISTORY_MAX_POINTS } from '../config.js';
import { fetchText, toFiniteNumber } from '../http.js';

const SGE_URL = 'https://www.sge.com.cn/graph/quotations?instid=';

const SGE_HEADERS = {
  Referer: 'https://www.sge.com.cn/sjzx/yshqbg',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/javascript, */*; q=0.01',
};

export interface SgeHistory {
  points: HistoryPoint[];
  prevClose: number | null;
}

function parseClock(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * 解析上金所官网分时：`{ times: ["20:00", ...], data: ["810.79", ...], delaystr: "2026年11月19日 15:24:56" }`
 * 夜盘 20:00 起的行属于前一自然日，跨零点需要补日期；末尾未发生的点位按当前时间裁掉。
 */
export function parseSgeQuotations(text: string, now = Date.now()): SgeHistory | null {
  let payload: { times?: unknown; data?: unknown; delaystr?: unknown };
  try {
    payload = JSON.parse(text) as { times?: unknown; data?: unknown; delaystr?: unknown };
  } catch {
    return null;
  }

  const times = payload.times;
  const data = payload.data;
  if (!Array.isArray(times) || !Array.isArray(data) || times.length === 0) return null;

  const dateMatch = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(String(payload.delaystr ?? ''));
  if (!dateMatch) return null;
  const tradeDate = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;

  const firstMinute = parseClock(String(times[0]));
  if (firstMinute === null) return null;

  let dayStart = Date.parse(`${tradeDate}T00:00:00+08:00`);
  if (!Number.isFinite(dayStart)) return null;
  // 夜盘 20:00 起算，属于交易日的前一日历日
  if (firstMinute >= 18 * 60) dayStart -= 24 * 60 * 60 * 1000;

  const byTime = new Map<number, number>();
  let previousMinute = -1;

  for (let index = 0; index < Math.min(times.length, data.length); index += 1) {
    const minute = parseClock(String(times[index]));
    const price = toFiniteNumber(data[index]);
    if (minute === null || price === null || price <= 0) continue;

    if (previousMinute >= 0 && minute < previousMinute) {
      dayStart += 24 * 60 * 60 * 1000;
    }
    previousMinute = minute;

    const t = dayStart + minute * 60 * 1000;
    if (t > now + 60_000) continue; // 未发生的点位（官网会补到收盘时间）
    byTime.set(t, price);
  }

  if (byTime.size === 0) return null;
  const points = [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, p]) => ({ t, p }));
  return {
    points: points.length > HISTORY_MAX_POINTS ? points.slice(points.length - HISTORY_MAX_POINTS) : points,
    prevClose: null,
  };
}

/** 上金所官网分时（Au99.99 / Au(T+D)），作为东财与新浪之外的第三来源 */
export async function fetchSgeHistory(id: InstrumentId): Promise<SgeHistory | null> {
  const instid = id === 'au9999' ? 'Au99.99' : id === 'autd' ? 'Au(T+D)' : null;
  if (!instid) return null;
  const text = await fetchText(`${SGE_URL}${instid}`, { headers: SGE_HEADERS });
  return parseSgeQuotations(text);
}
