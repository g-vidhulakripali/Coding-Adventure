import { describe, expect, it } from 'vitest';
import { resizePair } from './resize';

const base = { widthA: 400, widthB: 400, weightA: 1, weightB: 1, minA: 100, minB: 100 };

describe('resizePair', () => {
  it('moves the boundary and conserves total weight', () => {
    const { weightA, weightB } = resizePair(base, 100);
    expect(weightA).toBeCloseTo(1.25);
    expect(weightB).toBeCloseTo(0.75);
    expect(weightA + weightB).toBeCloseTo(2);
  });

  it('respects minimum widths on both sides', () => {
    expect(resizePair(base, 10_000).weightA).toBeCloseTo((2 * 700) / 800);
    expect(resizePair(base, -10_000).weightA).toBeCloseTo((2 * 100) / 800);
  });

  it('is a no-op for zero-sized pairs', () => {
    expect(resizePair({ ...base, widthA: 0, widthB: 0 }, 50)).toEqual({ weightA: 1, weightB: 1 });
  });
});
