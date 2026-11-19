import { describe, expect, it } from 'vitest';
import type { InstrumentId } from '../shared/instruments';
import type { PushSubscriptionRecord } from '../shared/push-types';
import type { MarketSession, MarketSnapshot, Quote } from '../shared/types';
import { evaluateAlertsForSubscription } from './push';

const NOW = Date.parse('2026-11-19T10:00:00+08:00');

function quote(id: InstrumentId, price: number, patch: Partial<Quote> = {}): Quote {
  return {
    id,
    price,
    bid: null,
    ask: null,
    prevClose: null,
    open: null,
    high: null,
    low: null,
    change: null,
    changePct: null,
    quoteTime: NOW,
    source: 'sina',
    derived: false,
    stale: false,
    ...patch,
  };
}

const OPEN: MarketSession = { phase: 'open', label: '交易中', detail: '' };
const CLOSED: MarketSession = { phase: 'closed', label: '已收盘', detail: '' };

function snapshot(quotes: Quote[], phase: MarketSession = OPEN): MarketSnapshot {
  return {
    fetchedAt: NOW,
    usdcny: null,
    quotes,
    sessions: Object.fromEntries(
      quotes.map((item) => [item.id, phase]),
    ) as Record<InstrumentId, MarketSession>,
    degraded: false,
  };
}

function record(
  targets: Partial<Record<InstrumentId, { low: number | null; high: number | null; enabled: boolean }>>,
  runtime: Partial<Record<InstrumentId, { zone: 'inside' | 'outside'; lastTriggeredAt: number }>> = {},
): PushSubscriptionRecord {
  return {
    endpoint: 'https://push.example/ep',
    p256dh: 'x',
    auth: 'y',
    targets: targets as PushSubscriptionRecord['targets'],
    runtime: runtime as PushSubscriptionRecord['runtime'],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('evaluateAlertsForSubscription', () => {
  it('价格从区间外进入区间时触发一次，并记录 zone 与时间', () => {
    const sub = record({ xauusd: { low: 3700, high: 3750, enabled: true } });
    const alerts = evaluateAlertsForSubscription(sub, snapshot([quote('xauusd', 3720)]), NOW);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].instrument).toBe('xauusd');
    expect(alerts[0].tag).toBe('goldwatch-xauusd');
    expect(sub.runtime.xauusd).toEqual({ zone: 'inside', lastTriggeredAt: NOW });
  });

  it('已处于区间内不会重复触发', () => {
    const sub = record(
      { xauusd: { low: 3700, high: 3750, enabled: true } },
      { xauusd: { zone: 'inside', lastTriggeredAt: NOW - 10_000 } },
    );
    expect(evaluateAlertsForSubscription(sub, snapshot([quote('xauusd', 3720)]), NOW)).toHaveLength(0);
  });

  it('60 秒冷却期内即使刚从外部进入也不触发，冷却结束后恢复', () => {
    const cooling = record(
      { xauusd: { low: 3700, high: 3750, enabled: true } },
      { xauusd: { zone: 'outside', lastTriggeredAt: NOW - 30_000 } },
    );
    expect(evaluateAlertsForSubscription(cooling, snapshot([quote('xauusd', 3720)]), NOW)).toHaveLength(0);

    const expired = record(
      { xauusd: { low: 3700, high: 3750, enabled: true } },
      { xauusd: { zone: 'outside', lastTriggeredAt: NOW - 61_000 } },
    );
    expect(evaluateAlertsForSubscription(expired, snapshot([quote('xauusd', 3720)]), NOW)).toHaveLength(1);
  });

  it('未开启、休市或行情延迟的品种不触发', () => {
    const disabled = record({ xauusd: { low: 3700, high: 3750, enabled: false } });
    expect(evaluateAlertsForSubscription(disabled, snapshot([quote('xauusd', 3720)]), NOW)).toHaveLength(0);

    const enabled = record({ xauusd: { low: 3700, high: 3750, enabled: true } });
    expect(
      evaluateAlertsForSubscription(enabled, snapshot([quote('xauusd', 3720)], CLOSED), NOW),
    ).toHaveLength(0);

    const staleSub = record({ xauusd: { low: 3700, high: 3750, enabled: true } });
    expect(
      evaluateAlertsForSubscription(
        staleSub,
        snapshot([quote('xauusd', 3720, { stale: true })]),
        NOW,
      ),
    ).toHaveLength(0);
  });

  it('多个品种同时到价时全部返回', () => {
    const sub = record({
      au9999: { low: 790, high: 810, enabled: true },
      msjcg: { low: 790, high: 810, enabled: true },
    });
    const alerts = evaluateAlertsForSubscription(
      sub,
      snapshot([quote('au9999', 800), quote('msjcg', 802)]),
      NOW,
    );

    expect(alerts.map((item) => item.instrument).sort()).toEqual(['au9999', 'msjcg']);
    expect(alerts.every((item) => item.title === '金价到达目标区间')).toBe(true);
  });

  it('只有单边阈值时按 ≥ / ≤ 判断', () => {
    const sub = record({ au9999: { low: 795, high: null, enabled: true } });
    expect(evaluateAlertsForSubscription(sub, snapshot([quote('au9999', 794.9)]), NOW)).toHaveLength(0);

    const alerts = evaluateAlertsForSubscription(sub, snapshot([quote('au9999', 795)]), NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body).toContain('≥ 795.00');
  });
});
