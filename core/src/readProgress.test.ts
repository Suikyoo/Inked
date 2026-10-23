import { describe, expect, it } from 'vitest';
import { checkpointOf, preferRead, readCoverage, shownProgress } from './readProgress';

describe('readProgress', () => {
  it('shows 0 without a mark and 100 for a fully read note', () => {
    expect(shownProgress(null, 100)).toBe(0);
    expect(shownProgress(undefined, 100)).toBe(0);
    expect(shownProgress({ pct: 100, size: 4000 }, 4000)).toBe(100);
  });
  it('drops when the note grows', () => {
    expect(shownProgress({ pct: 100, size: 4000 }, 8000)).toBe(50);
  });
  it('absorbs small size noise with slack', () => {
    expect(shownProgress({ pct: 100, size: 4000 }, 4100)).toBe(100);
    expect(shownProgress({ pct: 100, size: 4000 }, 4400)).toBe(75);
  });
  it('caps coverage when the note shrinks', () => {
    expect(shownProgress({ pct: 50, size: 4000 }, 1000)).toBe(100);
    expect(shownProgress({ pct: 100, size: 10 }, 0)).toBe(100);
  });
  it('maps fractions to checkpoints', () => {
    expect(checkpointOf(0.24)).toBe(0);
    expect(checkpointOf(0.25)).toBe(25);
    expect(checkpointOf(0.999)).toBe(75);
    expect(checkpointOf(1)).toBe(100);
    expect(checkpointOf(1.7)).toBe(100);
    expect(checkpointOf(-1)).toBe(0);
  });
  it('computes coverage capped at the current size', () => {
    expect(readCoverage({ pct: 50, size: 4000 }, 10000)).toBe(2000);
    expect(readCoverage({ pct: 100, size: 4000 }, 1000)).toBe(1000);
  });
  it('preferRead keeps the larger coverage', () => {
    expect(preferRead({ pct: 100, size: 500 }, { pct: 25, size: 500 }, 500)).toEqual({ pct: 100, size: 500 });
    expect(preferRead({ pct: 100, size: 1000 }, { pct: 100, size: 2000 }, 2000)).toEqual({ pct: 100, size: 2000 });
    expect(preferRead({ pct: 100, size: 1000 }, { pct: 100, size: 800 }, 800)).toEqual({ pct: 100, size: 800 });
    expect(preferRead({ pct: 100, size: 2000 }, { pct: 100, size: 1000 }, 2000)).toEqual({ pct: 100, size: 2000 });
    expect(preferRead(null, { pct: 25, size: 10 }, 10)).toEqual({ pct: 25, size: 10 });
  });
});
