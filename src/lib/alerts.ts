export interface TargetBounds {
  low: number | null;
  high: number | null;
}

export interface TargetRange extends TargetBounds {
  enabled: boolean;
}

type PositionState = 'inside' | 'above' | 'below' | 'unset';

export const ALERT_COOLDOWN_MS = 60 * 1000;

export function normalizeRange(range: TargetBounds | null | undefined): TargetBounds | null {
  if (!range) return null;
  const low = isPositive(range.low) ? range.low : null;
  const high = isPositive(range.high) ? range.high : null;
  if (low === null && high === null) return null;
  if (low !== null && high !== null && low > high) {
    return { low: high, high: low };
  }
  return { low, high };
}

export function isInRange(bounds: TargetBounds, price: number): boolean {
  if (!Number.isFinite(price)) return false;
  if (bounds.low !== null && price < bounds.low) return false;
  if (bounds.high !== null && price > bounds.high) return false;
  return true;
}

export function positionState(bounds: TargetBounds | null, price: number): PositionState {
  if (!bounds) return 'unset';
  if (!Number.isFinite(price)) return 'unset';
  if (isInRange(bounds, price)) return 'inside';
  if (bounds.high !== null && price > bounds.high) return 'above';
  if (bounds.low !== null && price < bounds.low) return 'below';
  return 'inside';
}

export function shouldTrigger(params: {
  bounds: TargetBounds;
  price: number;
  wasInside: boolean;
  lastTriggeredAt: number;
  now: number;
  cooldownMs?: number;
}): boolean {
  const { bounds, price, wasInside, lastTriggeredAt, now } = params;
  const cooldown = params.cooldownMs ?? ALERT_COOLDOWN_MS;
  if (!isInRange(bounds, price)) return false;
  if (wasInside) return false;
  return now - lastTriggeredAt >= cooldown;
}

type BoundsParseResult =
  | { ok: true; low: number | null; high: number | null }
  | { ok: false; error: string };

export function parseBounds(lowRaw: string, highRaw: string): BoundsParseResult {
  const low = parsePriceInput(lowRaw);
  if (!low.ok) return { ok: false, error: '下限格式不正确' };
  const high = parsePriceInput(highRaw);
  if (!high.ok) return { ok: false, error: '上限格式不正确' };
  if (low.value !== null && high.value !== null && low.value > high.value) {
    return { ok: false, error: '下限应小于或等于上限' };
  }
  return { ok: true, low: low.value, high: high.value };
}

function parsePriceInput(raw: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = raw.trim().replaceAll(',', '').replaceAll('，', '');
  if (trimmed === '') return { ok: true, value: null };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0 || value >= 1_000_000) return { ok: false };
  return { ok: true, value: Math.round(value * 100) / 100 };
}

function isPositive(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
