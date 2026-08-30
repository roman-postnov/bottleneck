// Edge polylines flattened for deck.gl's binary PathLayer (§13.1).
// Built here rather than in src/render, because §15 keeps the renderer away from src/core:
// the renderer is handed vertices, not a graph.

import { GEOM_SCALE } from '../core/city.ts';
import type { City } from '../core/types.ts';
import { M_PER_DEG_LAT, mPerDegLon } from '../shared/geo.ts';

// biome-ignore lint/performance/noBarrelFile: §16.6 -- buildNodeXY's callers read the projection from here; only its source moved
export { M_PER_DEG_LAT, mPerDegLon } from '../shared/geo.ts';

export type EdgeGeometry = {
  positions: Float64Array;
  startIndices: Uint32Array;
};

/**
 * Node coordinates as metre offsets from `center`, for the tracer layer's METER_OFFSETS
 * coordinate system (§13.2). Float32 metres, not Float64 degrees: deck.gl splits a Float64
 * getPosition into hi/lo Float32 attributes on the CPU every frame under LNGLAT, and a
 * quarter-million dots make that a cost nobody can see in a profiler.
 */
export function buildNodeXY(city: City, center: [lat: number, lon: number]): Float32Array {
  const out = new Float32Array(city.V * 2);
  const lat0 = center[0];
  const lon0 = center[1];
  const mPerLon = mPerDegLon(lat0);
  for (let v = 0; v < city.V; v++) {
    out[v * 2] = (city.lon[v] / 1e7 - lon0) * mPerLon;
    out[v * 2 + 1] = (city.lat[v] / 1e7 - lat0) * M_PER_DEG_LAT;
  }
  return out;
}

/** Building centroids in the same metre offsets as buildNodeXY. Empty when the file has no
 *  building section (§3.1). */
export function buildBuildingXY(city: City, center: [lat: number, lon: number]): Float32Array {
  const out = new Float32Array(city.B * 2);
  const lat0 = center[0];
  const lon0 = center[1];
  const mPerLon = mPerDegLon(lat0);
  for (let v = 0; v < city.V; v++) {
    for (let b = city.bldOff[v]; b < city.bldOff[v + 1]; b++) {
      const lat = city.lat[v] + city.bldPts[b * 2] * GEOM_SCALE;
      const lon = city.lon[v] + city.bldPts[b * 2 + 1] * GEOM_SCALE;
      out[b * 2] = (lon / 1e7 - lon0) * mPerLon;
      out[b * 2 + 1] = (lat / 1e7 - lat0) * M_PER_DEG_LAT;
    }
  }
  return out;
}

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
