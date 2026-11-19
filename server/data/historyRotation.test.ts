import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearHistoryCooldowns,
  markHistoryProviderFailure,
  pickHistoryProviders,
} from './service.js';
import type { InstrumentId } from '../../shared/instruments.js';

const keysAt = (id: InstrumentId, now = Date.now()): string[] =>
  pickHistoryProviders(id, now).map((provider) => provider.key);

beforeEach(() => {
  clearHistoryCooldowns();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearHistoryCooldowns();
});

describe('pickHistoryProviders 来源池', () => {
  it('伦敦金保持三个来源：东财 / 新浪期货 / 新浪外汇', () => {
    const keys = keysAt('xauusd');
    expect(keys).toHaveLength(3);
    expect(new Set(keys)).toEqual(new Set(['eastmoney', 'sina-futures', 'sina-forex']));
  });

  it('沪金两个品种保持三个来源：东财 / 新浪沪金主力 / 上金所', () => {
    for (const id of ['au9999', 'autd'] as const) {
      const keys = keysAt(id);
      expect(keys).toHaveLength(3);
      expect(new Set(keys)).toEqual(new Set(['eastmoney', 'sina-futures', 'sge']));
    }
  });

  it('无分时来源的品种返回空数组', () => {
    expect(keysAt('zsjcg')).toEqual([]);
    expect(keysAt('msjcg')).toEqual([]);
  });

  it('返回结果无重复', () => {
    const keys = keysAt('xauusd');
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('pickHistoryProviders 随机排序', () => {
  it('随机值接近 1 时保持池内原始顺序', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    expect(keysAt('xauusd')).toEqual(['eastmoney', 'sina-futures', 'sina-forex']);
  });

  it('随机值接近 0 时产生不同的排列', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(keysAt('xauusd')).toEqual(['sina-futures', 'sina-forex', 'eastmoney']);
  });

  it('多次调用能覆盖多种排列', () => {
    const orders = new Set<string>();
    for (let i = 0; i < 120; i += 1) orders.add(keysAt('xauusd').join(','));
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe('pickHistoryProviders 冷却排除', () => {
  it('冷却期内的来源被排除，到期后恢复', () => {
    const now = 1_000_000;
    const until = markHistoryProviderFailure('eastmoney', now);

    const during = keysAt('xauusd', now + 1000);
    expect(during).toHaveLength(2);
    expect(during).not.toContain('eastmoney');

    const after = keysAt('xauusd', until + 1);
    expect(after).toHaveLength(3);
    expect(after).toContain('eastmoney');
  });

  it('全部来源都在冷却时回退到完整候选池，不会返回空', () => {
    const now = 2_000_000;
    for (const key of ['eastmoney', 'sina-futures', 'sge']) {
      markHistoryProviderFailure(key, now);
    }
    const keys = keysAt('au9999', now + 1000);
    expect(keys).toHaveLength(3);
    expect(new Set(keys)).toEqual(new Set(['eastmoney', 'sina-futures', 'sge']));
  });

  it('冷却按来源隔离，不影响其他来源', () => {
    const now = 3_000_000;
    markHistoryProviderFailure('sge', now);
    const keys = keysAt('au9999', now + 1000);
    expect(keys).not.toContain('sge');
    expect(keys).toContain('eastmoney');
    expect(keys).toContain('sina-futures');
  });

  it('连续失败时冷却时间指数增长并封顶', () => {
    const now = 4_000_000;
    const first = markHistoryProviderFailure('eastmoney', now);
    expect(first - now).toBe(60_000);

    const second = markHistoryProviderFailure('eastmoney', now);
    expect(second - now).toBe(120_000);

    let last = second;
    for (let i = 0; i < 10; i += 1) last = markHistoryProviderFailure('eastmoney', now);
    expect(last - now).toBe(10 * 60_000);
  });
});
