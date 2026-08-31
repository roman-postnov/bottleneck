// Edge polylines flattened for deck.gl's binary PathLayer (§13.1).
// Built here rather than in src/render, because §15 keeps the renderer away from src/core:
// the renderer is handed vertices, not a graph.
//
// What comes out is the polyline as DRAWN: already one lane right of the direction of travel
// (§13.1). The centreline stays in city.bin, where src/core/graph.ts reads it. Offsetting here and
// not in a shader is what puts the cars on their own line: the PathLayer, the dot placement math,
// the trail and the closure dashes are then all reading one geometry.

import { GEOM_SCALE } from '../core/city.ts';
import type { City } from '../core/types.ts';
import {
  LANE_OFFSET_M,
  type MeterOffsets,
  meterOffsets,
  projectX,
  projectY,
  unprojectLat,
  unprojectLon,
} from '../shared/geo.ts';

export type EdgeGeometry = {
  positions: Float64Array;
  startIndices: Uint32Array;
};

/**
 * How far a miter may run, in offsets. |miter| = 1/cos(half-angle), so 4 clamps from a 151-degree
 * turn on -- a hairpin, where the true miter runs off to infinity. Clamped, never bevelled: a
 * bevel adds a vertex, and startIndices, the ready message's vertex count and every consumer of
 * `cum` are built on one output vertex per input vertex.
 */
const MITER_LIMIT = 4;

/**
 * Node coordinates as metre offsets from `center`, for the tracer layer's METER_OFFSETS
 * coordinate system (§13.2). Float32 metres, not Float64 degrees: deck.gl splits a Float64
 * getPosition into hi/lo Float32 attributes on the CPU every frame under LNGLAT, and a
 * quarter-million dots make that a cost nobody can see in a profiler.
 *
 * No lateral offset here, unlike the edges: a junction has no direction of travel.
 */
export function buildNodeXY(city: City, center: [lat: number, lon: number]): Float32Array {
  const out = new Float32Array(city.V * 2);
  const p = meterOffsets(center);
  for (let v = 0; v < city.V; v++) {
    const y = projectY(p, city.lat[v] / 1e7);
    out[v * 2] = projectX(p, city.lon[v] / 1e7, y);
    out[v * 2 + 1] = y;
  }
  return out;
}

/** Building centroids in the same metre offsets as buildNodeXY. Empty when the file has no
 *  building section (§3.1). */
export function buildBuildingXY(city: City, center: [lat: number, lon: number]): Float32Array {
  const out = new Float32Array(city.B * 2);
  const p = meterOffsets(center);
  for (let v = 0; v < city.V; v++) {
    for (let b = city.bldOff[v]; b < city.bldOff[v + 1]; b++) {
      const lat = city.lat[v] + city.bldPts[b * 2] * GEOM_SCALE;
      const lon = city.lon[v] + city.bldPts[b * 2 + 1] * GEOM_SCALE;
      const y = projectY(p, lat / 1e7);
      out[b * 2] = projectX(p, lon / 1e7, y);
      out[b * 2 + 1] = y;
    }
  }
  return out;
}

/**
 * Shifts a polyline `offsetM` metres to the right of its own direction of travel, in place, in the
 * metre offsets of §13.2 (x east, y north, so the right of a heading (dx, dy) is (dy, -dx)).
 *
 * Interior vertices take the MITER -- where the two offset segments actually meet -- so the result
 * is a parallel curve rather than a chain of segments with gaps at every bend. The caller owns
 * `nx`/`ny` so that a city's worth of edges allocates once.
 *
 * Exported for the test that pins the right-hand convention and the degenerate cases.
 */
export function laneOffset(
  mx: Float64Array,
  my: Float64Array,
  n: number,
  offsetM: number,
  nx: Float64Array,
  ny: Float64Array,
): void {
  // Unit right-normal of the segment STARTING at vertex i. (0, 0) marks "no direction here": a
  // unit normal is never (0, 0), and §3.2's deltas quantise to 1e-6 deg, so two OSM points 5 cm
  // apart land on one vertex -- seven times in San Francisco's 171 807.
  let first = -1;
  for (let i = 0; i + 1 < n; i++) {
    const dx = mx[i + 1] - mx[i];
    const dy = my[i + 1] - my[i];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) {
      nx[i] = 0;
      ny[i] = 0;
      continue;
    }
    nx[i] = dy / len;
    ny[i] = -dx / len;
    if (first < 0) first = i;
  }
  // Every vertex identical, which splitLongArcs can produce on an arc with no intermediate
  // geometry. There is nothing to be perpendicular to, so leave the polyline where it is.
  if (first < 0) return;
  for (let i = 0; i < first; i++) {
    nx[i] = nx[first];
    ny[i] = ny[first];
  }
  for (let i = first + 1; i + 1 < n; i++) {
    if (nx[i] === 0 && ny[i] === 0) {
      nx[i] = nx[i - 1];
      ny[i] = ny[i - 1];
    }
  }

  // The normals were read off the ORIGINAL vertices, so the displacement can be written back in
  // place in any order.
  for (let i = 0; i < n; i++) {
    const a = i === 0 ? 0 : i - 1;
    const b = i === n - 1 ? n - 2 : i;
    const ux = nx[a] + nx[b];
    const uy = ny[a] + ny[b];
    // 1 + n1.n2 = 2cos^2(half), and |(n1 + n2) / (1 + n1.n2)| = 1/cos(half), so the miter is
    // inside the limit exactly while denom >= 2 / MITER_LIMIT^2. A straight run has denom = 2 and
    // therefore a displacement of exactly offsetM, with nothing accumulating along the polyline.
    const denom = 1 + (nx[a] * nx[b] + ny[a] * ny[b]);
    let sx: number;
    let sy: number;
    if (denom > 2 / (MITER_LIMIT * MITER_LIMIT)) {
      sx = ux / denom;
      sy = uy / denom;
    } else {
      const ulen = Math.sqrt(ux * ux + uy * uy);
      if (ulen > 0) {
        sx = (ux / ulen) * MITER_LIMIT;
        sy = (uy / ulen) * MITER_LIMIT;
      } else {
        // An exact 180-degree reversal: the normals cancel and there is no miter direction left.
        // The segment behind is as good an answer as any, and it is finite.
        sx = nx[a];
        sy = ny[a];
      }
    }
    mx[i] += sx * offsetM;
    my[i] += sy * offsetM;
  }
}

export function buildEdgeGeometry(city: City, center: [lat: number, lon: number]): EdgeGeometry {
  const { E, geomOff } = city;
  const vertices = 2 * E + geomOff[E];
  const positions = new Float64Array(vertices * 2);
  const startIndices = new Uint32Array(E + 1);
  const p = meterOffsets(center);

  // One edge at a time in metre offsets, because a parallel curve needs the whole polyline in
  // hand. Sized to the longest edge and allocated once: this runs at configure time, but ninety
  // thousand small allocations is still ninety thousand small allocations.
  let maxV = 2;
  for (let e = 0; e < E; e++) {
    const nv = geomOff[e + 1] - geomOff[e] + 2;
    if (nv > maxV) maxV = nv;
  }
  const mx = new Float64Array(maxV);
  const my = new Float64Array(maxV);
  const nx = new Float64Array(maxV);
  const ny = new Float64Array(maxV);

  let k = 0;
  for (let e = 0; e < E; e++) {
    startIndices[e] = k;
    const from = city.edgeFrom[e];
    const to = city.edgeTo[e];
    let n = 0;

    let lat = city.lat[from];
    let lon = city.lon[from];
    n = push(p, mx, my, n, lat, lon);

    for (let g = geomOff[e]; g < geomOff[e + 1]; g++) {
      lat += city.geomPts[g * 2] * GEOM_SCALE;
      lon += city.geomPts[g * 2 + 1] * GEOM_SCALE;
      n = push(p, mx, my, n, lat, lon);
    }

    n = push(p, mx, my, n, city.lat[to], city.lon[to]);

    laneOffset(mx, my, n, LANE_OFFSET_M, nx, ny);

    for (let i = 0; i < n; i++, k++) {
      positions[k * 2] = unprojectLon(p, mx[i], my[i]);
      positions[k * 2 + 1] = unprojectLat(p, my[i]);
    }
  }
  startIndices[E] = k;
  return { positions, startIndices };
}

/** One decoded vertex, projected. y first: projectX reads it. */
function push(p: MeterOffsets, mx: Float64Array, my: Float64Array, n: number, lat: number, lon: number): number {
  const y = projectY(p, lat / 1e7);
  my[n] = y;
  mx[n] = projectX(p, lon / 1e7, y);
  return n + 1;
}
