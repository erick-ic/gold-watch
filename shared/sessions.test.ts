import { describe, expect, it } from 'vitest';
import { bankGoldSession, getMarketSession, londonSession, sgeSession } from './sessions.js';

const at = (iso: string): number => Date.parse(iso);

describe('sgeSession', () => {
  it('opens for the day session and marks the lunch break', () => {
    expect(sgeSession(at('2026-11-17T10:00:00+08:00')).phase).toBe('open');
    expect(sgeSession(at('2026-11-17T12:00:00+08:00'))).toMatchObject({
      phase: 'break',
      label: '午间休市',
    });
    expect(sgeSession(at('2026-11-17T15:30:00+08:00'))).toMatchObject({
      phase: 'closed',
      label: '已收盘',
      detail: '夜盘 20:00 开始',
    });
  });

  it('opens the night session from 20:00 to 02:30', () => {
    expect(sgeSession(at('2026-11-17T21:00:00+08:00')).phase).toBe('open');
    expect(sgeSession(at('2026-11-18T01:00:00+08:00')).phase).toBe('open');
    expect(sgeSession(at('2026-11-18T02:30:00+08:00')).phase).toBe('closed');
  });

  it('closes on Friday night and over the weekend', () => {
    expect(sgeSession(at('2026-11-20T21:00:00+08:00'))).toMatchObject({
      phase: 'closed',
      detail: '下周一 09:00 开盘',
    });
    expect(sgeSession(at('2026-11-21T10:00:00+08:00')).phase).toBe('closed');
    expect(sgeSession(at('2026-11-22T21:00:00+08:00')).phase).toBe('closed');
    expect(sgeSession(at('2026-11-23T01:00:00+08:00')).phase).toBe('closed');
    expect(sgeSession(at('2026-11-23T10:00:00+08:00')).phase).toBe('open');
  });

  it('keeps the Friday early session open', () => {
    expect(sgeSession(at('2026-11-20T02:00:00+08:00')).phase).toBe('open');
  });
});

describe('londonSession', () => {
  it('opens Sunday evening in New York and closes Friday afternoon', () => {
    expect(londonSession(at('2026-11-16T07:00:00+08:00')).phase).toBe('open');
    expect(londonSession(at('2026-11-21T06:00:00+08:00')).phase).toBe('closed');
    expect(londonSession(at('2026-11-21T10:00:00+08:00')).phase).toBe('closed');
  });

  it('marks the daily New York settlement break', () => {
    expect(londonSession(at('2026-11-17T06:30:00+08:00'))).toMatchObject({
      phase: 'break',
      label: '结算暂停',
    });
    expect(londonSession(at('2026-11-17T07:00:00+08:00')).phase).toBe('open');
  });

  it('follows US daylight saving time', () => {
    expect(londonSession(at('2026-07-14T05:30:00+08:00')).phase).toBe('break');
    expect(londonSession(at('2026-07-14T06:30:00+08:00')).phase).toBe('open');
  });
});

describe('bankGoldSession', () => {
  it('keeps weekday trading open around the clock', () => {
    expect(bankGoldSession(at('2026-11-17T10:00:00+08:00')).phase).toBe('open');
    expect(bankGoldSession(at('2026-11-17T21:00:00+08:00')).phase).toBe('open');
    expect(bankGoldSession(at('2026-11-18T01:00:00+08:00')).phase).toBe('open');
  });

  it('marks the daily clearing window', () => {
    expect(bankGoldSession(at('2026-11-17T23:50:00+08:00'))).toMatchObject({
      phase: 'break',
      label: '系统清算',
    });
    expect(bankGoldSession(at('2026-11-18T00:05:00+08:00')).phase).toBe('break');
    expect(bankGoldSession(at('2026-11-18T00:10:00+08:00')).phase).toBe('open');
  });

  it('closes from Friday night through the weekend', () => {
    expect(bankGoldSession(at('2026-11-20T23:55:00+08:00'))).toMatchObject({
      phase: 'closed',
      detail: '周一 00:10 开盘',
    });
    expect(bankGoldSession(at('2026-11-21T10:00:00+08:00')).phase).toBe('closed');
    expect(bankGoldSession(at('2026-11-22T21:00:00+08:00')).phase).toBe('closed');
    expect(bankGoldSession(at('2026-11-23T00:05:00+08:00')).phase).toBe('break');
    expect(bankGoldSession(at('2026-11-23T00:10:00+08:00')).phase).toBe('open');
  });
});

describe('getMarketSession', () => {
  it('dispatches by instrument', () => {
    const now = at('2026-11-17T10:00:00+08:00');
    expect(getMarketSession('xauusd', now).phase).toBe('open');
    expect(getMarketSession('au9999', now).phase).toBe('open');
    expect(getMarketSession('autd', now).phase).toBe('open');
    expect(getMarketSession('zsjcg', now).phase).toBe('open');
  });
});
