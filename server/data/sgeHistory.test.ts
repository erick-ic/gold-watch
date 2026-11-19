import { describe, expect, it } from 'vitest';
import { parseSgeQuotations } from './sgeHistory.js';

describe('parseSgeQuotations', () => {
  const payload = JSON.stringify({
    times: ['20:00', '20:01', '23:59', '00:00', '09:00', '15:30'],
    data: ['810.79', '810.00', '811.00', '811.20', '809.00', '808.50'],
    now: '09:00',
    delaystr: '2026年11月19日 09:00:12',
  });

  it('夜盘跨零点补日期，并裁掉未发生的点位', () => {
    const result = parseSgeQuotations(payload, Date.parse('2026-11-19T10:00:00+08:00'));
    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(5);
    expect(result!.points[0].t).toBe(Date.parse('2026-11-18T20:00:00+08:00'));
    expect(result!.points[2].t).toBe(Date.parse('2026-11-18T23:59:00+08:00'));
    expect(result!.points[3].t).toBe(Date.parse('2026-11-19T00:00:00+08:00'));
    expect(result!.points[4].t).toBe(Date.parse('2026-11-19T09:00:00+08:00'));
    expect(result!.points[4].p).toBeCloseTo(809, 2);
  });

  it('非 JSON 或缺少日期时返回 null', () => {
    expect(parseSgeQuotations('<html>403</html>')).toBeNull();
    expect(parseSgeQuotations(JSON.stringify({ times: ['09:00'], data: ['1'] }))).toBeNull();
  });
});
