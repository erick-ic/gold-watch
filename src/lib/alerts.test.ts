import { describe, expect, it } from 'vitest';
import {
  ALERT_COOLDOWN_MS,
  isInRange,
  normalizeRange,
  parseBounds,
  positionState,
  shouldTrigger,
} from './alerts';

describe('normalizeRange', () => {
  it('treats missing and non-positive bounds as null', () => {
    expect(normalizeRange(null)).toBeNull();
    expect(normalizeRange({ low: null, high: null })).toBeNull();
    expect(normalizeRange({ low: 0, high: -1 })).toBeNull();
    expect(normalizeRange({ low: Number.NaN, high: 100 })).toEqual({ low: null, high: 100 });
  });

  it('swaps inverted bounds', () => {
    expect(normalizeRange({ low: 900, high: 800 })).toEqual({ low: 800, high: 900 });
  });
});

describe('isInRange', () => {
  it('is inclusive on both edges', () => {
    expect(isInRange({ low: 100, high: 200 }, 100)).toBe(true);
    expect(isInRange({ low: 100, high: 200 }, 200)).toBe(true);
    expect(isInRange({ low: 100, high: 200 }, 99.99)).toBe(false);
    expect(isInRange({ low: 100, high: 200 }, 200.01)).toBe(false);
  });

  it('supports open-ended ranges', () => {
    expect(isInRange({ low: 100, high: null }, 9999)).toBe(true);
    expect(isInRange({ low: 100, high: null }, 99)).toBe(false);
    expect(isInRange({ low: null, high: 100 }, 1)).toBe(true);
    expect(isInRange({ low: null, high: 100 }, 101)).toBe(false);
  });

  it('rejects non-finite prices', () => {
    expect(isInRange({ low: 100, high: 200 }, Number.NaN)).toBe(false);
    expect(isInRange({ low: 100, high: 200 }, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('positionState', () => {
  const bounds = { low: 100, high: 200 };

  it('reports position relative to the range', () => {
    expect(positionState(null, 150)).toBe('unset');
    expect(positionState(bounds, 150)).toBe('inside');
    expect(positionState(bounds, 201)).toBe('above');
    expect(positionState(bounds, 99)).toBe('below');
    expect(positionState(bounds, Number.NaN)).toBe('unset');
  });
});

describe('shouldTrigger', () => {
  const bounds = { low: 100, high: 200 };
  const now = 1_700_000_000_000;

  it('uses a one-minute cooldown', () => {
    expect(ALERT_COOLDOWN_MS).toBe(60_000);
  });

  it('fires only when price crosses into the range', () => {
    expect(
      shouldTrigger({ bounds, price: 150, wasInside: false, lastTriggeredAt: 0, now }),
    ).toBe(true);
    expect(
      shouldTrigger({ bounds, price: 150, wasInside: true, lastTriggeredAt: 0, now }),
    ).toBe(false);
    expect(
      shouldTrigger({ bounds, price: 250, wasInside: false, lastTriggeredAt: 0, now }),
    ).toBe(false);
  });

  it('fires on the range edge', () => {
    expect(
      shouldTrigger({ bounds, price: 200, wasInside: false, lastTriggeredAt: 0, now }),
    ).toBe(true);
  });

  it('respects the cooldown window', () => {
    expect(
      shouldTrigger({
        bounds,
        price: 150,
        wasInside: false,
        lastTriggeredAt: now - 1000,
        now,
      }),
    ).toBe(false);
    expect(
      shouldTrigger({
        bounds,
        price: 150,
        wasInside: false,
        lastTriggeredAt: now - ALERT_COOLDOWN_MS,
        now,
      }),
    ).toBe(true);
  });
});

describe('parseBounds', () => {
  it('accepts empty inputs as unbounded', () => {
    expect(parseBounds('', '  ')).toEqual({ ok: true, low: null, high: null });
  });

  it('strips thousands separators and rounds to cents', () => {
    expect(parseBounds('3,850.555', '3,900')).toEqual({
      ok: true,
      low: 3850.56,
      high: 3900,
    });
  });

  it('rejects inverted bounds', () => {
    const result = parseBounds('900', '800');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('下限');
  });

  it('rejects malformed and out-of-range values', () => {
    expect(parseBounds('abc', '')).toMatchObject({ ok: false });
    expect(parseBounds('', '1e9')).toMatchObject({ ok: false });
    expect(parseBounds('-1', '')).toMatchObject({ ok: false });
  });
});
