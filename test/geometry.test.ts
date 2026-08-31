// The drawn geometry of CONTRACTS.md §13.1: the polyline the PathLayer, the cars, the trail and
// the closure dashes all share, already one lane right of the direction of travel.

import { describe, expect, it } from 'vitest';
import { NO_TWIN } from '../src/core/city.ts';
import { LANE_OFFSET_M, meterOffsets, projectX, projectY } from '../src/shared/geo.ts';
import { buildEdgeGeometry, laneOffset } from '../src/worker/geometry.ts';
import { loadFixture } from './helpers.ts';

const CENTER: [lat: number, lon: number] = [37.77708708691077, -122.418386718173];

/** Runs laneOffset over a plain list of metre points and hands back the result as pairs. */
function offset(points: [x: number, y: number][], d = LANE_OFFSET_M): [number, number][] {
  const n = points.length;
  const mx = Float64Array.from(points.map((p) => p[0]));
  const my = Float64Array.from(points.map((p) => p[1]));
  laneOffset(mx, my, n, d, new Float64Array(n), new Float64Array(n));
  return Array.from({ length: n }, (_, i) => [mx[i], my[i]] as [number, number]);
}

describe('§13.1: the lane offset is baked into the polyline', () => {
  it('pushes an eastbound line south and a northbound line east', () => {
    // The whole convention in one assertion: right of the direction of TRAVEL, in a metre space
    // where x is east and y is north.
    const east = offset([
      [0, 0],
      [100, 0],
    ]);
    expect(east).toEqual([
      [0, -LANE_OFFSET_M],
      [100, -LANE_OFFSET_M],
    ]);

    const north = offset([
      [0, 0],
      [0, 100],
    ]);
    expect(north).toEqual([
      [LANE_OFFSET_M, 0],
      [LANE_OFFSET_M, 100],
    ]);
  });

  it('puts an interior vertex where the two offset segments actually meet', () => {
    // East then north, i.e. a left turn, so the right-hand offset runs round the OUTSIDE. The east
    // segment offsets to the line y = -d and the north one to x = 100 + d; the miter is their
    // intersection, which is the corner displaced by (d, -d) -- d*sqrt(2) out.
    const [, corner] = offset([
      [0, 0],
      [100, 0],
      [100, 100],
    ]);
    expect(corner[0]).toBeCloseTo(100 + LANE_OFFSET_M, 9);
    expect(corner[1]).toBeCloseTo(-LANE_OFFSET_M, 9);
    expect(Math.hypot(corner[0] - 100, corner[1])).toBeCloseTo(LANE_OFFSET_M * Math.SQRT2, 9);
  });

  it('holds the offset exactly along a straight run of many vertices', () => {
    const pts = Array.from({ length: 12 }, (_, i) => [i * 37, 0] as [number, number]);
    for (const [x, y] of offset(pts)) {
      expect(y).toBe(-LANE_OFFSET_M);
      expect(Number.isFinite(x)).toBe(true);
    }
  });

  it('gives a duplicated vertex the same displacement as its neighbour', () => {
    // §3.2 quantises geometry deltas to 1e-6 deg, so two OSM points 5 cm apart decode to one
    // vertex -- seven times in San Francisco. The pair must stay a zero-length segment, which the
    // consumers of `cum` already guard, rather than turn into a NaN.
    const out = offset([
      [0, 0],
      [50, 0],
      [50, 0],
      [100, 0],
    ]);
    expect(out[1]).toEqual(out[2]);
    for (const [, y] of out) expect(y).toBe(-LANE_OFFSET_M);
  });

  it('handles a duplicate at the very start, where there is no normal behind yet', () => {
    const out = offset([
      [0, 0],
      [0, 0],
      [100, 0],
    ]);
    expect(out[0]).toEqual([0, -LANE_OFFSET_M]);
    expect(out[1]).toEqual([0, -LANE_OFFSET_M]);
  });

  it('leaves an edge whose every vertex is identical alone', () => {
    // Reachable through splitLongArcs on an arc with no intermediate geometry. There is nothing to
    // be perpendicular to.
    expect(
      offset([
        [7, 9],
        [7, 9],
      ]),
    ).toEqual([
      [7, 9],
      [7, 9],
    ]);
  });

  it('clamps a hairpin instead of throwing the vertex to infinity', () => {
    const [, apex] = offset([
      [0, 0],
      [100, 0],
      [0, 0.001],
    ]);
    expect(Number.isFinite(apex[0])).toBe(true);
    expect(Number.isFinite(apex[1])).toBe(true);
    expect(Math.hypot(apex[0] - 100, apex[1])).toBeLessThanOrEqual(4 * LANE_OFFSET_M + 1e-6);
  });

  it('does not blow up just short of the clamp', () => {
    const eps = 1e-9;
    const [, apex] = offset([
      [0, 0],
      [100, 0],
      [200, 100 * eps],
    ]);
    expect(apex[1]).toBeCloseTo(-LANE_OFFSET_M, 6);
  });
});

describe('§13.1: buildEdgeGeometry over a real city file', () => {
  const city = loadFixture('grid20');
  const geo = buildEdgeGeometry(city, CENTER);

  it('emits exactly one vertex per input vertex', () => {
    // startIndices, the ready message's vertex count and every consumer of `cum` are built on
    // this. A bevelled corner would add a vertex and break all three at once.
    expect(geo.startIndices[city.E]).toBe(2 * city.E + city.geomOff[city.E]);
    expect(geo.positions.length).toBe(geo.startIndices[city.E] * 2);
    for (let e = 0; e < city.E; e++) {
      expect(geo.startIndices[e + 1] - geo.startIndices[e], `edge ${e}`).toBe(
        city.geomOff[e + 1] - city.geomOff[e] + 2,
      );
    }
  });

  it('is finite everywhere', () => {
    for (let k = 0; k < geo.positions.length; k++) {
      if (!Number.isFinite(geo.positions[k])) throw new Error(`vertex ${k} is not finite`);
    }
  });

  it('starts each edge one lane right of its own tail node', () => {
    const p = meterOffsets(CENTER);
    for (let e = 0; e < city.E; e++) {
      const v = city.edgeFrom[e];
      const ny = projectY(p, city.lat[v] / 1e7);
      const nx = projectX(p, city.lon[v] / 1e7, ny);
      const k = geo.startIndices[e];
      const y = projectY(p, geo.positions[k * 2 + 1]);
      const x = projectX(p, geo.positions[k * 2], y);
      expect(Math.hypot(x - nx, y - ny), `edge ${e}`).toBeCloseTo(LANE_OFFSET_M, 5);
    }
  });

  it('leaves the two directions of a street two lanes apart', () => {
    // «Каждое направление — своя линия» becomes a property of the data that can be checked, rather
    // than a shader flag that moved the line and left the cars behind.
    const p = meterOffsets(CENTER);
    let pairs = 0;
    for (let e = 0; e < city.E; e++) {
      const t = city.twin[e];
      if (t === NO_TWIN) continue;
      pairs++;
      const a = geo.startIndices[e];
      const b = geo.startIndices[t + 1] - 1;
      const ay = projectY(p, geo.positions[a * 2 + 1]);
      const ax = projectX(p, geo.positions[a * 2], ay);
      const by = projectY(p, geo.positions[b * 2 + 1]);
      const bx = projectX(p, geo.positions[b * 2], by);
      expect(Math.hypot(ax - bx, ay - by), `edge ${e} vs twin ${t}`).toBeCloseTo(2 * LANE_OFFSET_M, 4);
    }
    expect(pairs).toBeGreaterThan(0);
  });
});
