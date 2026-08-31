// The only source of randomness in the project (docs/CONTRACTS.md §10).
// Math.random() is forbidden in src/core and src/worker and is checked by test/boundaries.

import { splitmix32 } from '../shared/rng.ts';

/**
 * xorshift128+ over 32-bit halves. JavaScript has no 64-bit integers outside BigInt, and
 * BigInt in a hot loop is an order of magnitude slower, so each 64-bit word is carried as
 * a (hi, lo) pair and every shift is written out by hand.
 */
export type Rng = {
  /** Uniform in [0, 2^32). */
  nextU32: () => number;
  /** Uniform in [0, 1), 53 significant bits. */
  next: () => number;
};

/** §7.2 names splitmix32 as part of this module's API; the mixer itself lives in src/shared. */
// biome-ignore lint/performance/noBarrelFile: §16.6 -- the contract file re-exports its declared API, so the split stays invisible from outside
export { splitmix32 } from '../shared/rng.ts';

export function createRng(seed: number): Rng {
  const mix = splitmix32(seed);
  let s0h = mix();
  let s0l = mix();
  let s1h = mix();
  let s1l = mix();
  // All-zero state is a fixed point of xorshift; it can only arise from a pathological seed.
  if ((s0h | s0l | s1h | s1l) === 0) s0h = 1;

  let resHi = 0;
  let resLo = 0;

  // The reference generator returns s[0] + s[1] taken BEFORE the state update; taking it
  // after would still be a usable stream, but it would not be xorshift128+.
  function step(): void {
    const xh = s0h;
    const xl = s0l;
    const yh = s1h;
    const yl = s1l;

    resLo = (xl + yl) >>> 0;
    resHi = (xh + yh + (xl + yl > 0xffffffff ? 1 : 0)) >>> 0;

    s0h = yh;
    s0l = yl;

    // x ^= x << 23
    const a23h = ((xh << 23) | (xl >>> 9)) >>> 0;
    const a23l = (xl << 23) >>> 0;
    const ph = (xh ^ a23h) >>> 0;
    const pl = (xl ^ a23l) >>> 0;

    // s[1] = x ^ y ^ (x >>> 18) ^ (y >>> 5)
    const p18h = ph >>> 18;
    const p18l = ((pl >>> 18) | (ph << 14)) >>> 0;
    const y5h = yh >>> 5;
    const y5l = ((yl >>> 5) | (yh << 27)) >>> 0;

    s1h = (ph ^ yh ^ p18h ^ y5h) >>> 0;
    s1l = (pl ^ yl ^ p18l ^ y5l) >>> 0;
  }

  return {
    nextU32(): number {
      step();
      // The low bits of xorshift128+ are the weak ones; the high word is what you use.
      return resHi;
    },
    next(): number {
      step();
      // 53 bits: 26 from the high word, 27 from the low word.
      return ((resHi >>> 6) * 0x8000000 + (resLo >>> 5)) / 0x20000000000000;
    },
  };
}
