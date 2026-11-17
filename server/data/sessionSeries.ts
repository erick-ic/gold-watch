import type { HistoryPoint } from '../../shared/types.js';

/** 时间戳相同的点覆盖价格，乱序的旧点忽略，超出上限裁掉最旧的点。 */
export function appendSample(
  points: readonly HistoryPoint[],
  sample: HistoryPoint,
  max: number,
): HistoryPoint[] {
  const last = points[points.length - 1];
  if (last && sample.t <= last.t) {
    if (sample.t !== last.t || sample.p === last.p) return [...points];
    return [...points.slice(0, -1), { t: last.t, p: sample.p }];
  }
  const next = [...points, sample];
  return next.length > max ? next.slice(next.length - max) : next;
}
