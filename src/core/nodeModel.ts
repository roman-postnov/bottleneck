// The Daganzo node model (docs/CONTRACTS.md §7.4). This is the physics of the project.
//
// It stays non-iterative because split shares belong to the node, not to an
// (incoming, outgoing) pair: every incoming edge faces the same set of constraints, so a
// single scalar per node is enough.

import type { SimState } from './types.ts';

const EPS = 1e-9;

/**
 * Weighted proportional division of a budget F among participants that each have a ceiling.
 * Pass one reads only (rem, W), which are fixed for the whole pass -- that is what makes the
 * outcome independent of traversal order (§14.12).
 */
function allocate(s: SimState, P: number, F: number): void {
  const { ndDemand: d, ndWeight: w, ndOut: out, ndActive, ndSat } = s;
  for (let p = 0; p < P; p++) {
    out[p] = 0;
    ndActive[p] = d[p] > EPS ? 1 : 0;
  }
  let rem = F;

  for (;;) {
    let W = 0;
    for (let p = 0; p < P; p++) if (ndActive[p]) W += w[p];
    if (W <= EPS || rem <= EPS) break;

    let anySat = false;
    for (let p = 0; p < P; p++) {
      if (!ndActive[p]) continue;
      if ((rem * w[p]) / W >= d[p] - EPS) {
        ndSat[p] = 1;
        anySat = true;
      } else {
        ndSat[p] = 0;
      }
    }

    if (!anySat) {
      for (let p = 0; p < P; p++) if (ndActive[p]) out[p] = (rem * w[p]) / W;
      break;
    }

    for (let p = 0; p < P; p++) {
      if (!(ndSat[p] && ndActive[p])) continue;
      out[p] = d[p];
      rem -= d[p];
      ndActive[p] = 0;
    }
  }
}

/** Writes only into moveOut, inflow and moveSrc. State itself is moved by phase 6. */
export function nodeTransfer(s: SimState, v: number): void {
  const { city, demand, supply, moveOut, inflow, moveSrc, cap, blocked, queued } = s;
  const { csrOff, inOff, inEdge, isExit } = city;
  const split = s.field.split;

  if (isExit[v]) {
    for (let k = inOff[v]; k < inOff[v + 1]; k++) {
      const i = inEdge[k];
      moveOut[i] = demand[i];
      s.evacuated += demand[i];
    }
    moveSrc[v] = queued[v];
    s.evacuated += queued[v];
    return;
  }

  const a = csrOff[v];
  const b = csrOff[v + 1];

  // FIFO: the node moves at the pace of the tightest direction it needs. Any share aimed at
  // a full edge holds up the ENTIRE node -- this is spillback, and it is the effect the
  // whole project exists to show. Relaxing it here quietly removes the physics.
  let F = Number.POSITIVE_INFINITY;
  let hasO = false;
  for (let o = a; o < b; o++) {
    if (split[o] <= 0 || blocked[o]) continue;
    hasO = true;
    const lim = supply[o] / split[o];
    if (lim < F) F = lim;
  }
  if (!hasO) return;

  let P = 0;
  let Fmax = 0;
  for (let k = inOff[v]; k < inOff[v + 1]; k++) {
    const i = inEdge[k];
    s.ndDemand[P] = demand[i];
    s.ndWeight[P] = cap[i];
    Fmax += demand[i];
    P++;
  }
  const fromYard = Math.min(queued[v], s.srcInjectCapVehS);
  s.ndDemand[P] = fromYard;
  s.ndWeight[P] = s.srcInjectCapVehS;
  Fmax += fromYard;
  P++;

  if (Fmax <= EPS) return;
  if (F > Fmax) F = Fmax;

  if (F >= Fmax - EPS) {
    for (let p = 0; p < P; p++) s.ndOut[p] = s.ndDemand[p];
  } else {
    allocate(s, P, F);
  }

  let Fout = 0;
  for (let p = 0; p < P; p++) Fout += s.ndOut[p];

  let p = 0;
  for (let k = inOff[v]; k < inOff[v + 1]; k++) moveOut[inEdge[k]] = s.ndOut[p++];
  moveSrc[v] = s.ndOut[P - 1];

  for (let o = a; o < b; o++) {
    if (split[o] <= 0 || blocked[o]) continue;
    inflow[o] += split[o] * Fout;
  }
}
