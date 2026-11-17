import type { HistoryPoint } from '../../shared/types';

export function mergePoints(
  base: readonly HistoryPoint[],
  incoming: readonly HistoryPoint[],
  max = 1400,
): HistoryPoint[] {
  const map = new Map<number, number>();
  for (const point of base) {
    if (Number.isFinite(point.t) && Number.isFinite(point.p) && point.p > 0) {
      map.set(point.t, point.p);
    }
  }
  for (const point of incoming) {
    if (Number.isFinite(point.t) && Number.isFinite(point.p) && point.p > 0) {
      map.set(point.t, point.p);
    }
  }
  const sorted = [...map.entries()].sort((a, b) => a[0] - b[0]);
  const trimmed = sorted.length > max ? sorted.slice(sorted.length - max) : sorted;
  return trimmed.map(([t, p]) => ({ t, p }));
}

export function samplePoints(points: readonly HistoryPoint[], max: number): HistoryPoint[] {
  if (points.length <= max) return [...points];
  const stride = points.length / max;
  const sampled: HistoryPoint[] = [];
  for (let i = 0; i < max; i += 1) {
    sampled.push(points[Math.min(points.length - 1, Math.floor(i * stride))]);
  }
  const last = points[points.length - 1];
  if (sampled[sampled.length - 1]?.t !== last.t) sampled[sampled.length - 1] = last;
  return sampled;
}
