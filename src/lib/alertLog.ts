import type { InstrumentId } from '../../shared/instruments';
import type { AlertLogEntry } from './storage';

interface AlertLogGroup {
  id: string;
  instrument: InstrumentId;
  price: number;
  low: number | null;
  high: number | null;
  at: number;
  firstAt: number;
  count: number;
}

const ALERT_LOG_GROUP_WINDOW_MS = 2 * 60 * 1000;

/** 输入按时间倒序；仅合并相邻且区间相同的提醒 */
export function groupAlertLog(
  entries: readonly AlertLogEntry[],
  windowMs = ALERT_LOG_GROUP_WINDOW_MS,
): AlertLogGroup[] {
  const groups: AlertLogGroup[] = [];

  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (
      last &&
      last.instrument === entry.instrument &&
      last.low === entry.low &&
      last.high === entry.high &&
      last.firstAt - entry.at <= windowMs
    ) {
      last.count += 1;
      last.firstAt = entry.at;
      continue;
    }
    groups.push({
      id: entry.id,
      instrument: entry.instrument,
      price: entry.price,
      low: entry.low,
      high: entry.high,
      at: entry.at,
      firstAt: entry.at,
      count: 1,
    });
  }

  return groups;
}
