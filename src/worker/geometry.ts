// Edge polylines flattened for deck.gl's binary PathLayer (§13.1).
// Built here rather than in src/render, because §15 keeps the renderer away from src/core:
// the renderer is handed vertices, not a graph.

import { GEOM_SCALE } from '../core/city.ts';
import type { City } from '../core/types.ts';

export type EdgeGeometry = {
  positions: Float64Array;
  startIndices: Uint32Array;
};

export function buildEdgeGeometry(city: City): EdgeGeometry {
  const { E, geomOff } = city;
  const vertices = 2 * E + geomOff[E];
  const positions = new Float64Array(vertices * 2);
  const startIndices = new Uint32Array(E + 1);

  let k = 0;
  for (let e = 0; e < E; e++) {
    startIndices[e] = k;
    const from = city.edgeFrom[e];
    const to = city.edgeTo[e];

    let lat = city.lat[from];
    let lon = city.lon[from];
    positions[k * 2] = lon / 1e7;
    positions[k * 2 + 1] = lat / 1e7;
    k++;

    for (let g = geomOff[e]; g < geomOff[e + 1]; g++) {
      lat += city.geomPts[g * 2] * GEOM_SCALE;
      lon += city.geomPts[g * 2 + 1] * GEOM_SCALE;
      positions[k * 2] = lon / 1e7;
      positions[k * 2 + 1] = lat / 1e7;
      k++;
    }

    positions[k * 2] = city.lon[to] / 1e7;
    positions[k * 2 + 1] = city.lat[to] / 1e7;
    k++;
  }
  startIndices[E] = k;
  return { positions, startIndices };
}
