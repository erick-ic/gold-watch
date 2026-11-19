import { describe, expect, it } from 'vitest';
import { parseForexMinKline, parseGlobalMinLine, parseInnerMinLine } from './sinaHistory.js';

const globalPayload =
  '/*<script>location.href=\'//sina.com\';</script>*/\n' +
  'var t=({"minLine_1d":[' +
  '["2026-11-19","3724.670","LIFFE","","07:00","3729.960","0","0","3729.815","2026-11-19 07:00:00"],' +
  '["07:01","3729.220","0","0","3729.929","2026-11-19 07:01:00"],' +
  '["07:02","3730.030","0","0","3730.000","2026-11-19 07:02:00"]' +
  ']});';

const innerPayload =
  '/*<script>location.href=\'//sina.com\';</script>*/\n' +
  'var t=([["21:00","808.060","807.985","1532","149562","814.320","2026-11-19"],' +
  '["23:59","809.100","808.500","120","149600"],' +
  '["09:00","803.500","808.200","300","152000"],' +
  '["09:01","803.800","808.180","210","152100"]]);';

describe('parseGlobalMinLine', () => {
  it('解析表头行与分钟行，并提取昨收', () => {
    const result = parseGlobalMinLine(globalPayload);
    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(3);
    expect(result!.prevClose).toBeCloseTo(3724.67, 2);
    expect(result!.points[0].p).toBeCloseTo(3729.96, 2);
    expect(result!.points[2].p).toBeCloseTo(3730.03, 2);
    expect(result!.points[0].t).toBe(
      Date.parse('2026-11-19T07:00:00+08:00'),
    );
  });

  it('非 JSONP 内容返回 null', () => {
    expect(parseGlobalMinLine('not jsonp')).toBeNull();
  });
});

describe('parseInnerMinLine', () => {
  it('夜盘起算并跨零点正确补日期', () => {
    const result = parseInnerMinLine(innerPayload);
    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(4);

    // 交易日 2026-11-19 的夜盘 21:00 属于前一日历日 11-18
    expect(result!.points[0].t).toBe(Date.parse('2026-11-18T21:00:00+08:00'));
    expect(result!.points[1].t).toBe(Date.parse('2026-11-18T23:59:00+08:00'));
    // 时间回绕后进入 11-19
    expect(result!.points[2].t).toBe(Date.parse('2026-11-19T09:00:00+08:00'));
    expect(result!.points[3].p).toBeCloseTo(803.8, 2);
  });

  it('首行不是夜盘时按交易日当天计算', () => {
    const payload =
      'var t=([["09:00","800.000","800.000","1","1","801.000","2026-11-19"],' +
      '["09:01","801.000","800.500","1","1"]]);';
    const result = parseInnerMinLine(payload);
    expect(result!.points[0].t).toBe(Date.parse('2026-11-19T09:00:00+08:00'));
  });
});

describe('parseForexMinKline', () => {
  it('取分钟收盘价并按时间升序', () => {
    const payload =
      'var t=([{"d":"2026-11-19 07:08:00","c":"3736.1000","o":"1","l":"1","h":"1"},' +
      '{"d":"2026-11-19 07:07:00","c":"3735.0500","o":"1","l":"1","h":"1"}]);';
    const result = parseForexMinKline(payload);
    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(2);
    expect(result!.points[0].t).toBe(Date.parse('2026-11-19T07:07:00+08:00'));
    expect(result!.points[0].p).toBeCloseTo(3735.05, 2);
    expect(result!.points[1].p).toBeCloseTo(3736.1, 2);
  });
});
