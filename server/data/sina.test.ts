import { describe, expect, it } from 'vitest';
import { parseBeijingDateTime, parseSinaResponse } from './sina.js';

function line(symbol: string, fields: string[]): string {
  return `var hq_str_${symbol}="${fields.join(',')}";`;
}

function goldFields(overrides: Record<number, string> = {}): string[] {
  const fields = new Array(18).fill('');
  fields[0] = '2650.55';
  fields[2] = '2650.45';
  fields[3] = '2650.65';
  fields[4] = '2661.20';
  fields[5] = '2639.80';
  fields[6] = '15:30:05';
  fields[7] = '2648.05';
  fields[8] = '2649.10';
  fields[12] = '2026-11-17';
  for (const [index, value] of Object.entries(overrides)) fields[Number(index)] = value;
  return fields;
}

describe('parseBeijingDateTime', () => {
  it('interprets Sina timestamps as UTC+8', () => {
    const parsed = parseBeijingDateTime('2026-11-17', '15:30:05');
    expect(parsed).toBe(Date.parse('2026-11-17T15:30:05+08:00'));
    expect(parseBeijingDateTime('2026-11-17', '09:31')).toBe(
      Date.parse('2026-11-17T09:31:00+08:00'),
    );
  });

  it('returns null for malformed input', () => {
    expect(parseBeijingDateTime(undefined, '15:30:05')).toBeNull();
    expect(parseBeijingDateTime('2026/11/17', '15:30:05')).toBeNull();
    expect(parseBeijingDateTime('2026-11-17', '25:99')).toBeNull();
  });
});

describe('parseSinaResponse', () => {
  it('parses London gold, SGE contracts and the USD/CNY mid price', () => {
    const text = [
      line('hf_XAU', goldFields()),
      line('gds_AU9999', goldFields({ 0: '612.30', 7: '610.00', 6: '15:30:03' })),
      line('gds_AUTD', goldFields({ 0: '611.80', 7: '609.50' })),
      line('fx_susdcny', ['美元人民币', '7.1080', '7.1120', '', '', '', '', '', '']),
    ].join('\n');

    const snapshot = parseSinaResponse(text);

    expect(snapshot.quotes).toHaveLength(3);
    expect(snapshot.usdcny).toBeCloseTo(7.11, 6);

    const [xau, au9999, autd] = snapshot.quotes;
    expect(xau).toMatchObject({
      id: 'xauusd',
      price: 2650.55,
      bid: 2650.45,
      ask: 2650.65,
      high: 2661.2,
      low: 2639.8,
      prevClose: 2648.05,
      open: 2649.1,
      source: 'sina',
      derived: false,
      stale: false,
    });
    expect(xau.change).toBeCloseTo(2.5, 6);
    expect(xau.changePct).toBeCloseTo((2.5 / 2648.05) * 100, 6);
    expect(xau.quoteTime).toBe(Date.parse('2026-11-17T15:30:05+08:00'));

    expect(au9999.id).toBe('au9999');
    expect(au9999.price).toBe(612.3);
    expect(autd.id).toBe('autd');
    expect(autd.change).toBeCloseTo(2.3, 6);
  });

  it('skips malformed quotes but keeps valid ones', () => {
    const text = line('hf_XAU', goldFields({ 0: '0' })) + line('gds_AUTD', goldFields());
    const snapshot = parseSinaResponse(text);
    expect(snapshot.quotes.map((quote) => quote.id)).toEqual(['autd']);
  });

  it('ignores an implausible exchange rate and missing previous close', () => {
    const text =
      line('hf_XAU', goldFields({ 7: '0' })) +
      line('fx_susdcny', ['美元人民币', '0.01', '0.02']);
    const snapshot = parseSinaResponse(text);
    expect(snapshot.usdcny).toBeNull();
    expect(snapshot.quotes[0].prevClose).toBeNull();
    expect(snapshot.quotes[0].change).toBeNull();
    expect(snapshot.quotes[0].changePct).toBeNull();
  });

  it('throws when no recognizable quote is present', () => {
    expect(() => parseSinaResponse('var hq_str_unknown="1,2,3";')).toThrow('新浪行情返回为空');
  });
});
