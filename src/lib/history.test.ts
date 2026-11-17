import { describe, expect, it } from 'vitest';
import type { HistoryPoint } from '../../shared/types';
import { mergePoints, samplePoints } from './history';

const point = (t: number, p: number): HistoryPoint => ({ t, p });

describe('mergePoints', () => {
  it('deduplicates by timestamp, letting incoming points win', () => {
    const merged = mergePoints([point(1, 100), point(2, 101)], [point(2, 102), point(3, 103)]);
    expect(merged).toEqual([point(1, 100), point(2, 102), point(3, 103)]);
  });

  it('sorts by time regardless of input order', () => {
    expect(mergePoints([point(3, 103), point(1, 100)], [])).toEqual([
      point(1, 100),
      point(3, 103),
    ]);
  });

  it('drops invalid samples and keeps the newest ones', () => {
    const merged = mergePoints(
      [point(1, 100), point(2, Number.NaN), point(3, -5)],
      [point(4, 104), point(5, 105)],
      2,
    );
    expect(merged).toEqual([point(4, 104), point(5, 105)]);
  });
});

describe('samplePoints', () => {
  it('returns a copy when under the limit', () => {
    const input = [point(1, 100), point(2, 101)];
    const output = samplePoints(input, 10);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
  });

  it('always keeps the latest point when downsampling', () => {
    const input = Array.from({ length: 1000 }, (_, index) => point(index, 100 + index));
    const output = samplePoints(input, 120);
    expect(output).toHaveLength(120);
    expect(output[0]).toEqual(input[0]);
    expect(output[output.length - 1]).toEqual(input[input.length - 1]);
    const times = output.map((item) => item.t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});
