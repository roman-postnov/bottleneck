// Departure curve and staged release (CONTRACTS.md §7.5).

import type { SimState } from './types.ts';

const SQRT_2LN2 = Math.sqrt(2 * Math.LN2);

/** Rayleigh sigma such that exactly half the demand has left by halfTimeMin. */
export function rayleighSigmaSec(halfTimeMin: number): number {
  return (halfTimeMin * 60) / SQRT_2LN2;
}

/**
 * Phase 1 of the tick. Evaluated from the closed form rather than by increments: a
 * per-tick increment accumulates drift over tens of thousands of ticks, and the mass
 * balance check of §14.1 is where that drift would surface.
 */
export function mobilize(s: SimState): void {
  const { city, demand0, waiting, queued, releaseAt, moveSrc } = s;
  const sigma = s.mobilizationSigmaSec;
  const twoSigmaSq = 2 * sigma * sigma;
  const t = s.t;

  for (let v = 0; v < city.V; v++) {
    moveSrc[v] = 0;
    const total = demand0[v];
    if (total === 0) continue;

    const tau = t - releaseAt[v];
    if (tau < 0) continue;

    const left = sigma > 0 ? total * Math.exp((-tau * tau) / twoSigmaSq) : 0;
    queued[v] += waiting[v] - left;
    waiting[v] = left;
  }
}
