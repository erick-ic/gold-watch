import { describe, expect, it } from 'vitest';
import { appendSample } from './sessionSeries.js';

const point = (t: number, p: number) => ({ t, p });

describe('appendSample', () => {
  it('appends samples in chronological order', () => {
    expect(appendSample([point(1, 100)], point(2, 101), 10)).toEqual([point(1, 100), point(2, 101)]);
    expect(appendSample([], point(1, 100), 10)).toEqual([point(1, 100)]);
  });

  it('replaces the price for an identical timestamp', () => {
    expect(appendSample([point(1, 100), point(2, 101)], point(2, 102), 10)).toEqual([
      point(1, 100),
      point(2, 102),
    ]);
  });

  it('ignores samples older than the newest point', () => {
    expect(appendSample([point(2, 101)], point(1, 100), 10)).toEqual([point(2, 101)]);
  });

  it('keeps the newest samples up to the limit', () => {
    const existing = [point(1, 100), point(2, 101), point(3, 102)];
    expect(appendSample(existing, point(4, 103), 2)).toEqual([point(3, 102), point(4, 103)]);
  });
});
