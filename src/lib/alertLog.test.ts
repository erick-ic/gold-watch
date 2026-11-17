import { describe, expect, it } from 'vitest';
import type { AlertLogEntry } from './storage';
import { groupAlertLog } from './alertLog';

const base = 1_700_000_000_000;

function entry(overrides: Partial<AlertLogEntry> = {}): AlertLogEntry {
  return {
    id: `e-${overrides.at ?? base}`,
    instrument: 'xauusd',
    price: 3867,
    low: null,
    high: 3868,
    at: base,
    ...overrides,
  };
}

describe('groupAlertLog', () => {
  it('merges consecutive alerts for the same range within the window', () => {
    const groups = groupAlertLog([
      entry({ id: 'latest', at: base + 3000, price: 3867.2 }),
      entry({ id: 'first', at: base, price: 3866.9 }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: 'latest',
      count: 2,
      price: 3867.2,
      at: base + 3000,
      firstAt: base,
    });
  });

  it('does not merge across different ranges or instruments', () => {
    const groups = groupAlertLog([
      entry({ at: base + 3000, high: 3870 }),
      entry({ at: base, high: 3868 }),
      entry({ at: base - 1000, instrument: 'au9999', low: null, high: 3868 }),
    ]);

    expect(groups).toHaveLength(3);
    expect(groups.every((group) => group.count === 1)).toBe(true);
  });

  it('does not merge beyond the grouping window', () => {
    const groups = groupAlertLog([
      entry({ at: base + 121_000 }),
      entry({ at: base }),
    ]);

    expect(groups).toHaveLength(2);
  });

  it('does not mutate the input entries', () => {
    const entries = [entry({ at: base + 1000 }), entry({ at: base })];
    const snapshot = entries.map((item) => ({ ...item }));

    groupAlertLog(entries);

    expect(entries).toEqual(snapshot);
  });
});
