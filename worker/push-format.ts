import { INSTRUMENT_MAP, type InstrumentId } from '../shared/instruments';

/**
 * 格式化到价推送通知
 * Worker 端独立实现，与前端 App.tsx 中的 formatRangeLabel / formatPrice 保持一致
 */
export function formatPushNotification(
  instrument: InstrumentId,
  price: number,
  bounds: { low: number | null; high: number | null },
): { title: string; body: string; tag: string } {
  const meta = INSTRUMENT_MAP[instrument];
  const decimals = meta.decimals;

  const priceStr = price.toFixed(decimals);
  const rangeStr = formatBounds(bounds, decimals);

  const title = '金价到达目标区间';
  const body = `${meta.name} ${priceStr} ${meta.unitLabel}，目标 ${rangeStr}`;
  const tag = `goldwatch-${instrument}-${Math.floor(price)}`;

  return { title, body, tag };
}

function formatBounds(
  bounds: { low: number | null; high: number | null },
  decimals: number,
): string {
  if (bounds.low !== null && bounds.high !== null) {
    return `${bounds.low.toFixed(decimals)}–${bounds.high.toFixed(decimals)}`;
  }
  if (bounds.low !== null) return `≥ ${bounds.low.toFixed(decimals)}`;
  if (bounds.high !== null) return `≤ ${bounds.high.toFixed(decimals)}`;
  return '';
}

export function formatPriceValue(price: number, decimals: number): string {
  return price.toFixed(decimals);
}
