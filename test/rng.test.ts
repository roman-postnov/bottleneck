// From CONTRACTS.md §10: one seeded generator, no Math.random anywhere in core.

import { describe, it, expect } from 'vitest';
import { createRng } from '../src/core/rng.ts';

describe('rng', () => {
  it('the same seed replays the same sequence', () => {
    const a = createRng(20261101);
    const b = createRng(20261101);
    for (let i = 0; i < 10000; i++) expect(a.nextU32()).toBe(b.nextU32());
  });

  it('different seeds diverge', () => {
    const a = createRng(1);
    const b = createRng(2);
    let same = 0;
    for (let i = 0; i < 1000; i++) if (a.nextU32() === b.nextU32()) same++;
    expect(same).toBeLessThan(5);
  });

  it('next() stays in [0, 1)', () => {
    const r = createRng(7);
    for (let i = 0; i < 100000; i++) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('is roughly uniform: mean and octile counts', () => {
    const r = createRng(99);
    const n = 200000;
    const bins = new Int32Array(8);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = r.next();
      sum += x;
      bins[Math.min(7, (x * 8) | 0)]++;
    }
    expect(sum / n).toBeCloseTo(0.5, 2);
    for (const b of bins) expect(Math.abs(b - n / 8) / (n / 8)).toBeLessThan(0.05);
  });

  it('does not collapse to a fixed point on a zero seed', () => {
    const r = createRng(0);
    const seen = new Set<number>();
    for (let i = 0; i < 100; i++) seen.add(r.nextU32());
    expect(seen.size).toBeGreaterThan(90);
  });
});
