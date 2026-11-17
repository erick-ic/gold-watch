import { describe, expect, it } from 'vitest';
import { parseJdGoldResponse } from './jdgold.js';

const SAMPLE = {
  success: true,
  resultCode: 0,
  resultData: {
    status: 'SUCCESS',
    datas: {
      price: '828.84',
      yesterdayPrice: '829.01',
      upAndDownAmt: '-0.17',
      time: '1794907367000',
    },
  },
};

describe('parseJdGoldResponse', () => {
  it('maps price, previous close and change', () => {
    const quote = parseJdGoldResponse(SAMPLE);
    expect(quote).toMatchObject({
      id: 'zsjcg',
      price: 828.84,
      prevClose: 829.01,
      open: null,
      high: null,
      low: null,
      source: 'jd',
      derived: false,
      stale: false,
    });
    expect(quote?.change).toBeCloseTo(-0.17, 6);
    expect(quote?.changePct).toBeCloseTo((-0.17 / 829.01) * 100, 6);
    expect(quote?.quoteTime).toBe(1794907367000);
  });

  it('promotes second timestamps to milliseconds', () => {
    const payload = {
      ...SAMPLE,
      resultData: { ...SAMPLE.resultData, datas: { ...SAMPLE.resultData.datas, time: '1794907367' } },
    };
    expect(parseJdGoldResponse(payload)?.quoteTime).toBe(1794907367000);
  });

  it('keeps the quote when the previous close is missing', () => {
    const payload = {
      ...SAMPLE,
      resultData: { ...SAMPLE.resultData, datas: { price: 828.84, time: '1794907367000' } },
    };
    const quote = parseJdGoldResponse(payload);
    expect(quote).toMatchObject({ price: 828.84, prevClose: null, change: null, changePct: null });
  });

  it('rejects empty and invalid payloads', () => {
    expect(parseJdGoldResponse({})).toBeNull();
    expect(parseJdGoldResponse({ resultData: null })).toBeNull();
    expect(parseJdGoldResponse({ resultData: { datas: null } })).toBeNull();
    expect(parseJdGoldResponse({ resultData: { datas: { price: '0' } } })).toBeNull();
    expect(parseJdGoldResponse({ resultData: { datas: { price: '--' } } })).toBeNull();
    expect(parseJdGoldResponse({ resultData: { datas: { price: '' } } })).toBeNull();
  });
});
