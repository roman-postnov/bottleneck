// Graph reading over a parsed City: the geometry decoder and Tarjan's SCC (§3.3.8).
// Neither knows the byte layout -- they work on the arrays the parser already produced.

import { GEOM_SCALE } from './format.ts';
import type { City, EdgeIdx } from './types.ts';

/**
 * An edge polyline in degrees: tail node, intermediate points, head node.
 * Deltas accumulate in quantised units, so the decoder lands exactly where the
 * encoder did, without drift.
 */
export function edgePolyline(city: City, e: EdgeIdx): [number, number][] {
  const from = city.edgeFrom[e];
  const to = city.edgeTo[e];
  const pts: [number, number][] = [[city.lat[from] / 1e7, city.lon[from] / 1e7]];
  let lat = city.lat[from];
  let lon = city.lon[from];
  for (let k = city.geomOff[e]; k < city.geomOff[e + 1]; k++) {
    lat += city.geomPts[k * 2] * GEOM_SCALE;
    lon += city.geomPts[k * 2 + 1] * GEOM_SCALE;
    pts.push([lat / 1e7, lon / 1e7]);
  }
  pts.push([city.lat[to] / 1e7, city.lon[to] / 1e7]);
  return pts;
}

/** Strongly connected components of G' -- exit out-edges suppressed (§3.3.8). */
export function stronglyConnectedComponents(city: Pick<City, 'V' | 'csrOff' | 'edgeTo' | 'isExit'>): {
  comp: Int32Array;
  nComp: number;
} {
  const { V, csrOff, edgeTo, isExit } = city;
  const index = new Int32Array(V).fill(-1);
  const low = new Int32Array(V);
  const onStack = new Uint8Array(V);
  const comp = new Int32Array(V).fill(-1);
  const stack = new Int32Array(V);
  const frameV = new Int32Array(V + 1);
  const frameE = new Uint32Array(V + 1);
  let sp = 0;
  let idx = 0;
  let nComp = 0;

  const endOf = (v: number): number => (isExit[v] ? csrOff[v] : csrOff[v + 1]);

  for (let s = 0; s < V; s++) {
    if (index[s] !== -1) continue;
    let top = 0;
    frameV[0] = s;
    frameE[0] = csrOff[s];
    index[s] = idx;
    low[s] = idx;
    idx++;
    stack[sp++] = s;
    onStack[s] = 1;
    while (top >= 0) {
      const v = frameV[top];
      if (frameE[top] < endOf(v)) {
        const w = edgeTo[frameE[top]++];
        if (index[w] === -1) {
          index[w] = idx;
          low[w] = idx;
          idx++;
          stack[sp++] = w;
          onStack[w] = 1;
          top++;
          frameV[top] = w;
          frameE[top] = csrOff[w];
        } else if (onStack[w] && index[w] < low[v]) {
          low[v] = index[w];
        }
      } else {
        if (low[v] === index[v]) {
          for (;;) {
            const w = stack[--sp];
            onStack[w] = 0;
            comp[w] = nComp;
            if (w === v) break;
          }
          nComp++;
        }
        top--;
        if (top >= 0 && low[v] < low[frameV[top]]) low[frameV[top]] = low[v];
      }
    }
  }
  return { comp, nComp };
}
