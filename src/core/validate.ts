// The invariants of CONTRACTS.md §3.3. Build-time only: the preprocessor and the tests run it,
// the simulation never does.

import { MAX_EDGE_LEN_M, NO_TWIN } from './format.ts';
import { stronglyConnectedComponents } from './graph.ts';
import type { City } from './types.ts';

/**
 * Report the first offender and stop. A file that breaks an invariant usually breaks it
 * thousands of times, and the millionth message says nothing the first one did not.
 */
function scan(err: string[], n: number, bad: (i: number) => string | null): void {
  for (let i = 0; i < n; i++) {
    const m = bad(i);
    if (m !== null) {
      err.push(m);
      return;
    }
  }
}

/** An empty array means the file is valid. */
export function validateCity(city: City): string[] {
  const err: string[] = [];
  const { V, E, G, csrOff, edgeTo, twin, lenM, lanes, speedKmh, geomOff, srcNode, srcPop, srcNoCar, exitNode, isExit } =
    city;

  if (csrOff[0] !== 0 || csrOff[V] !== E) {
    err.push(`1: CSR_OFF[0]=${csrOff[0]}, CSR_OFF[V]=${csrOff[V]}, expected 0 and ${E}`);
  }
  scan(err, V, (v) => (csrOff[v + 1] < csrOff[v] ? `2: CSR_OFF decreases at node ${v}` : null));
  scan(err, E, (e) => (edgeTo[e] >= V ? `3: EDGE_TO[${e}]=${edgeTo[e]} >= V=${V}` : null));
  if (geomOff[0] !== 0 || geomOff[E] !== G) {
    err.push(`4: GEOM_OFF[0]=${geomOff[0]}, GEOM_OFF[E]=${geomOff[E]}, expected 0 and ${G}`);
  }
  scan(err, E, (e) => {
    const t = twin[e];
    if (t === NO_TWIN) return null;
    return t >= E || twin[t] !== e ? `5: EDGE_TWIN is not mutual at edge ${e} (twin=${t})` : null;
  });
  scan(err, E, (e) => (lanes[e] < 1 ? `6: lanes[${e}]=${lanes[e]} < 1` : null));
  scan(err, E, (e) => (speedKmh[e] < 5 ? `6: speedKmh[${e}]=${speedKmh[e]} < 5` : null));
  scan(err, E, (e) =>
    lenM[e] > MAX_EDGE_LEN_M ? `7: lenM[${e}]=${lenM[e]} > ${MAX_EDGE_LEN_M}, the edge must be split` : null,
  );

  scan(err, srcNode.length, (i) => (srcNode[i] >= V ? `11: SRC_NODE[${i}]=${srcNode[i]} >= V` : null));
  scan(err, exitNode.length, (i) => (exitNode[i] >= V ? `11: EXIT[${i}]=${exitNode[i]} >= V` : null));
  scan(err, srcNode.length, (i) =>
    srcNode[i] < V && isExit[srcNode[i]] ? `11: node ${srcNode[i]} is both a SRC and an EXIT` : null,
  );

  const { bldOff, bldPts } = city;
  if (bldOff[0] !== 0) err.push(`13: BLD_OFF[0]=${bldOff[0]}, expected 0`);
  scan(err, V, (v) => (bldOff[v + 1] < bldOff[v] ? `13: BLD_OFF decreases at node ${v}` : null));
  if (bldOff[V] * 2 !== bldPts.length) {
    err.push(`13: BLD_OFF[V]=${bldOff[V]}, BLD_PTS holds ${bldPts.length / 2} points`);
  }

  // Not a scan: the same pass has to total the population it is checking.
  let pop = 0;
  for (let i = 0; i < srcPop.length; i++) {
    pop += srcPop[i];
    if (!(srcNoCar[i] >= 0 && srcNoCar[i] <= srcPop[i])) {
      err.push(`10: SRC_NOCAR[${i}]=${srcNoCar[i]} outside [0, SRC_POP[${i}]=${srcPop[i]}]`);
      break;
    }
  }
  if (!(pop > 0)) err.push(`10: sum(SRC_POP)=${pop}, must be > 0`);

  // 8 and 9: connectivity. C is the component that holds the sources.
  if (err.length === 0 && srcNode.length > 0) {
    const { comp } = stronglyConnectedComponents(city);
    const C = comp[srcNode[0]];
    scan(err, srcNode.length, (i) =>
      i > 0 && comp[srcNode[i]] !== C
        ? `8: SRC ${srcNode[i]} outside the source component (comp=${comp[srcNode[i]]}, expected ${C})`
        : null,
    );
    scan(err, V, (v) =>
      comp[v] !== C && !isExit[v]
        ? `8: node ${v} is neither in the source component nor an exit; the preprocessor must drop it`
        : null,
    );
    let reachableExits = 0;
    for (let i = 0; i < exitNode.length; i++) {
      const x = exitNode[i];
      let ok = false;
      for (let k = city.inOff[x]; k < city.inOff[x + 1]; k++) {
        if (comp[city.edgeFrom[city.inEdge[k]]] === C) {
          ok = true;
          break;
        }
      }
      if (ok) reachableExits++;
      else err.push(`8: exit ${x} is unreachable from the source component`);
    }
    if (reachableExits === 0) err.push('9: no exit is reachable from the sources');
  }

  return err;
}
