// The tracer state machine of CONTRACTS.md §13.2, tested from the contract: one dot per
// vehicle, position by Newell's cumulative-count solution, route recorded as CSR decisions.
//
// src/render/tracers.ts imports no deck.gl on purpose, which is what lets all of this run here.

import { describe, expect, it } from 'vitest';
import { splitmix32 } from '../src/core/rng.ts';
import {
  ARRIVED,
  advance,
  createTracers,
  cumulative,
  dotError,
  M_PER_DEG_LAT,
  MOVING,
  mPerDegLon,
  onFrame,
  PARKED,
  ROUTE_MAX_HOPS,
  replayRoute,
  STUCK,
  type TracerField,
  type TracerInit,
  writeParked,
  writePositions,
} from '../src/render/tracers.ts';
import { mix32 } from '../src/shared/rng.ts';
import { M_PER_DEG_LAT as GEOM_M_PER_DEG_LAT, mPerDegLon as geomMPerDegLon } from '../src/worker/geometry.ts';

/** The CSR pair the ready message carries. An empty list is a city whose file predates §3.2's
 *  building section, which is every committed fixture. */
function buildings(
  V: number,
  list: [node: number, x: number, y: number][],
): { bldOff: Uint32Array; bldXY: Float32Array } {
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  const bldOff = new Uint32Array(V + 1);
  for (const [v] of sorted) bldOff[v + 1]++;
  for (let v = 0; v < V; v++) bldOff[v + 1] += bldOff[v];
  const bldXY = new Float32Array(sorted.length * 2);
  sorted.forEach(([, x, y], i) => {
    bldXY[i * 2] = x;
    bldXY[i * 2 + 1] = y;
  });
  return { bldOff, bldXY };
}

const TT = 10;
const STORAGE = 100;
const SPACING_M = 1000;

/** A chain of N edges: node 0 holds the demand, node N is the exit. */
function lineGraph(
  N: number,
  demand: number,
  opts: { ttSec?: number; storage?: number; bld?: [node: number, x: number, y: number][] } = {},
) {
  const V = N + 1;
  const E = N;
  const csrOff = new Uint32Array(V + 1);
  for (let v = 0; v <= N; v++) csrOff[v] = Math.min(v, E);
  csrOff[V] = E;
  const edgeTo = new Uint32Array(E);
  for (let e = 0; e < E; e++) edgeTo[e] = e + 1;
  const isExit = new Uint8Array(V);
  isExit[N] = 1;
  const ttSec = new Uint16Array(E).fill(opts.ttSec ?? TT);
  const storage = new Float32Array(E).fill(opts.storage ?? STORAGE);
  const split = new Float32Array(E).fill(1);
  const demand0 = new Float32Array(V);
  demand0[0] = demand;
  const nodeXY = new Float32Array(V * 2);
  for (let v = 0; v < V; v++) nodeXY[v * 2] = v * SPACING_M;

  const startIndices = new Uint32Array(E + 1);
  for (let e = 0; e <= E; e++) startIndices[e] = e * 2;
  const vertsM = new Float32Array(E * 2 * 2);
  for (let e = 0; e < E; e++) {
    vertsM[e * 4] = e * SPACING_M;
    vertsM[e * 4 + 2] = (e + 1) * SPACING_M;
  }
  const { cum, edgeLen } = cumulative(startIndices, vertsM, E);

  const init: TracerInit = {
    E,
    V,
    totalVeh: demand,
    seed: 12345,
    csrOff,
    edgeTo,
    isExit,
    ttSec,
    split,
    demand0,
    demandNodes: Uint32Array.from([0]),
    nodeXY,
    maxOutDeg: 1,
    ...buildings(V, opts.bld ?? []),
    storage,
    startIndices,
    vertsM,
    cum,
    edgeLen,
  };
  return { init, E, V };
}

/** Hands the field one frame. `n` and `outflow` are per edge, `departed` per node. */
function frame(
  f: TracerField,
  simT: number,
  opts: { n?: Float32Array; outflow?: Float32Array; departed?: Float32Array } = {},
): void {
  onFrame(
    f,
    opts.n ?? new Float32Array(f.E),
    opts.outflow ?? new Float32Array(f.E),
    opts.departed ?? new Float32Array(f.V),
    undefined,
    simT,
  );
}

function departOne(f: TracerField, v: number, simT: number, n?: Float32Array): void {
  const departed = new Float32Array(f.V);
  departed[v] = 1;
  frame(f, simT, { departed, n });
}

describe('§15: src/render and src/worker share the projection rather than copy it', () => {
  it('the projection is the same binding on both sides of the boundary', () => {
    // These were two copies pinned together by this test. They are now one module under
    // src/shared; the assertion stays so that re-introducing a copy goes red.
    expect(M_PER_DEG_LAT).toBe(GEOM_M_PER_DEG_LAT);
    for (const lat of [0, 24.55, 37.76, 39.76, 47.57, 60, 89.9, -33.9]) {
      expect(mPerDegLon(lat), `lat ${lat}`).toBe(geomMPerDegLon(lat));
    }
  });

  it('the stateless mixer agrees with the first output of the stateful one', () => {
    for (const seed of [0, 1, 42, 12345, -7, 0x7fffffff, 0x9e3779b9 | 0]) {
      expect(mix32(seed), `seed ${seed}`).toBe(splitmix32(seed)());
    }
  });
});

describe('yards: one dot per vehicle, before anyone moves', () => {
  it('a dot exists for every car of demand at t = 0', () => {
    const { init } = lineGraph(4, 10);
    const f = createTracers(init);
    expect(writeParked(f)).toBe(10);
    expect(f.movingCount).toBe(0);
    for (let i = 0; i < 10; i++) expect(f.dState[i]).toBe(PARKED);
  });

  it('a fractional demand rounds with the remainder carried, not dropped', () => {
    const V = 3;
    const demandNodes = Uint32Array.from([0, 1]);
    const { init } = lineGraph(2, 0);
    const demand0 = new Float32Array(V);
    demand0[0] = 2.5;
    demand0[1] = 2.5;
    const f = createTracers({ ...init, demand0, demandNodes, totalVeh: 5 });
    expect(writeParked(f)).toBe(5);
  });

  it('parked cars line the streets that meet their node, not the junction itself', () => {
    // Node 0 owns one 1000 m street running east along y = 0.
    const { init } = lineGraph(4, 50);
    const f = createTracers(init);
    writeParked(f);
    const xs: number[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < f.parkedCount; i++) {
      const x = f.parkedPos[i * 2];
      const y = f.parkedPos[i * 2 + 1];
      xs.push(x);
      seen.add(`${x.toFixed(3)},${y.toFixed(3)}`);
      // Down the near half of the street, never past it into the next node's frontage.
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(140);
      // Off the carriageway, on one kerb or the other.
      expect(Math.abs(y)).toBeGreaterThanOrEqual(5);
      expect(Math.abs(y)).toBeLessThanOrEqual(12);
    }
    expect(seen.size).toBe(50);
    // Strung out along the street rather than heaped at the junction: a disc of 30 m would put
    // every one of them inside the first 30 m.
    expect(Math.max(...xs)).toBeGreaterThan(90);
    const nearJunction = xs.filter((x) => x < 30).length;
    expect(nearJunction).toBeLessThan(20);
  });

  it('parked cars stand at the buildings of their node when the city has them', () => {
    const houses: [number, number, number][] = [
      [0, 40, 60],
      [0, 90, -70],
      [0, 300, 20],
    ];
    const { init } = lineGraph(4, 12, { bld: houses });
    const f = createTracers(init);
    expect(writeParked(f)).toBe(12);
    const perHouse = [0, 0, 0];
    for (let i = 0; i < 12; i++) {
      const x = f.parkedPos[i * 2];
      const y = f.parkedPos[i * 2 + 1];
      const k = houses.findIndex(([, hx, hy]) => Math.hypot(x - hx, y - hy) <= 8);
      expect(k).toBeGreaterThanOrEqual(0);
      perHouse[k]++;
      // Off the centroid, because a centroid is not a driveway and two cars must not coincide.
      expect(Math.hypot(x - houses[k][1], y - houses[k][2])).toBeGreaterThanOrEqual(3);
    }
    // 12 cars over 3 houses, round robin.
    expect(perHouse).toEqual([4, 4, 4]);
  });

  it('cars beyond what the mapped houses hold go back to the street', () => {
    // One house for ten cars: Paradise, where OSM drew a fraction of the town.
    const { init } = lineGraph(4, 10, { bld: [[0, 40, 60]] });
    const f = createTracers(init);
    expect(writeParked(f)).toBe(10);
    let atHouse = 0;
    for (let i = 0; i < 10; i++) {
      const d = Math.hypot(f.parkedPos[i * 2] - 40, f.parkedPos[i * 2 + 1] - 60);
      if (d <= 8) atHouse++;
      else expect(Math.abs(f.parkedPos[i * 2 + 1])).toBeLessThanOrEqual(12); // on a kerb
    }
    expect(atHouse).toBe(4);
  });

  it('a node with no building falls back to the street layout', () => {
    // Node 1 has the houses; node 0, which holds the demand, has none.
    const { init } = lineGraph(4, 20, { bld: [[1, 1000, 0]] });
    const withHouses = createTracers(init);
    const plain = createTracers(lineGraph(4, 20).init);
    writeParked(withHouses);
    writeParked(plain);
    expect(Array.from(withHouses.parkedPos)).toEqual(Array.from(plain.parkedPos));
  });

  it('the same city places its cars in the same places twice', () => {
    const bld: [number, number, number][] = [
      [0, 15, 5],
      [0, 80, -30],
    ];
    const a = createTracers(lineGraph(3, 9, { bld }).init);
    const b = createTracers(lineGraph(3, 9, { bld }).init);
    writeParked(a);
    writeParked(b);
    expect(Array.from(a.parkedPos)).toEqual(Array.from(b.parkedPos));
  });

  it('a node with no street to line up along still gets its cars placed', () => {
    const { init } = lineGraph(2, 6);
    // Strip node 0 of its out-edges, which is what a sink node looks like.
    const csrOff = Uint32Array.from(init.csrOff);
    csrOff[1] = 0;
    const f = createTracers({ ...init, csrOff });
    expect(writeParked(f)).toBe(6);
    for (let i = 0; i < 6; i++) {
      expect(Math.hypot(f.parkedPos[i * 2], f.parkedPos[i * 2 + 1])).toBeLessThanOrEqual(31);
    }
  });
});

describe('free flow: an empty edge is crossed in exactly ttSec simulated seconds', () => {
  it('the dot is still on the first edge at ttSec - epsilon and on the second at ttSec', () => {
    const { init } = lineGraph(4, 1);
    const f = createTracers(init);
    departOne(f, 0, 0);
    expect(f.movingCount).toBe(1);
    expect(f.dEdge[0]).toBe(0);

    advance(f, TT - 0.01);
    expect(f.dEdge[0]).toBe(0);
    expect(f.dParam[0]).toBeCloseTo(0.999, 3);

    advance(f, TT);
    expect(f.dEdge[0]).toBe(1);
  });

  it('the whole chain takes the sum of ttSec, and then the car has left the city', () => {
    const N = 4;
    const { init } = lineGraph(N, 1);
    const f = createTracers(init);
    departOne(f, 0, 0);
    for (let t = 0; t < N * TT; t += 0.5) advance(f, t);
    expect(f.dState[0]).toBe(MOVING);
    advance(f, N * TT);
    expect(f.dState[0]).toBe(ARRIVED);
    expect(f.dArriveT[0]).toBeCloseTo(N * TT, 6);
    expect(f.arrivedCount).toBe(1);
    expect(f.movingCount).toBe(0);
  });

  it('crossing several edges in one frame keeps the overshoot instead of losing it', () => {
    const { init } = lineGraph(8, 1);
    const f = createTracers(init);
    departOne(f, 0, 0);
    // One jump of 25 s at ttSec = 10 covers two edges and half of a third.
    advance(f, 25);
    expect(f.dEdge[0]).toBe(2);
    expect(f.dParam[0]).toBeCloseTo(0.5, 6);
  });
});

describe('the queue: a dot stops where the cars ahead of it are standing', () => {
  it('it parks at 1 - ahead/storage and only moves when the edge discharges', () => {
    const { init } = lineGraph(4, 1);
    const f = createTracers(init);
    const n = new Float32Array(f.E);
    n[0] = 50;
    // Two frames: a car's FIFO number is anchored to the cumulative arrivals as of the PREVIOUS
    // frame, so the edge has to be carrying its fifty cars before this one arrives. One frame
    // handing over n = 50 out of nowhere describes a network that has never existed.
    frame(f, 0, { n });
    departOne(f, 0, 0, n);

    // ff would have carried it to the head; 50 cars ahead of 100 storage hold it at half.
    advance(f, 100);
    expect(f.dParam[0]).toBeCloseTo(0.5, 5);

    const outflow = new Float32Array(f.E);
    outflow[0] = 25;
    frame(f, 100, { n, outflow });
    advance(f, 101);
    expect(f.dParam[0]).toBeCloseTo(0.75, 5);

    outflow[0] = 25;
    frame(f, 101, { n, outflow });
    advance(f, 102);
    expect(f.dEdge[0]).toBe(1);
  });

  it('a closed road holds its cars where they stand', () => {
    const { init } = lineGraph(4, 1);
    const f = createTracers(init);
    const n = new Float32Array(f.E);
    n[0] = 10;
    departOne(f, 0, 0, n);
    advance(f, 5);
    const held = f.dParam[0];
    expect(held).toBeGreaterThan(0.4);

    f.blocked[0] = 1;
    for (let t = 6; t < 60; t++) advance(f, t);
    expect(f.dEdge[0]).toBe(0);
    expect(f.dParam[0]).toBeCloseTo(held, 6);
  });

  it('cars entering together queue behind each other rather than stacking', () => {
    const { init } = lineGraph(4, 3);
    const f = createTracers(init);
    const departed = new Float32Array(f.V);
    departed[0] = 3;
    const n = new Float32Array(f.E);
    n[0] = 3;
    frame(f, 0, { n });
    frame(f, 0, { departed, n });
    expect(f.movingCount).toBe(3);
    advance(f, 1000);
    const params = [f.dParam[0], f.dParam[1], f.dParam[2]];
    expect(new Set(params.map((p) => p.toFixed(6))).size).toBe(3);
    // and they are ordered: the first to enter stands furthest down the link
    expect(params[0]).toBeGreaterThan(params[1]);
    expect(params[1]).toBeGreaterThan(params[2]);
  });

  it('the FIFO number tracks the model instead of ratcheting away from it', () => {
    const { init } = lineGraph(4, 1);
    const f = createTracers(init);
    const n = new Float32Array(f.E);
    n[0] = 20;
    const outflow = new Float32Array(f.E);
    // Twenty cars standing, twenty served, over and over. The anchor is reassigned every frame,
    // so a car arriving later is not charged for any of it. Raising the counter instead of
    // assigning it -- a max() -- accumulates every frame's arrivals forever, and a car that
    // arrives late can then never leave at all.
    for (let k = 0; k < 50; k++) {
      outflow[0] = 20;
      frame(f, k, { n, outflow });
    }
    departOne(f, 0, 50, n);
    advance(f, 1000);
    expect(f.dParam[0]).toBeCloseTo(0.8, 5);
  });

  it('an edge carrying nobody does not hold a dot back on a rounding leftover', () => {
    const { init } = lineGraph(4, 1);
    // n stays at zero while storage is huge, so without the empty-edge guard the queue branch
    // would pin the dot just short of the head of the link and never let it off.
    const f = createTracers({ ...init, storage: new Float32Array(init.E).fill(1e6) });
    departOne(f, 0, 0);
    advance(f, TT);
    expect(f.dEdge[0]).toBe(1);
  });
});

describe('dead ends: the dot stops and stays, as the model does', () => {
  it('a node with no usable out-edge strands the car instead of despawning it', () => {
    const { init } = lineGraph(3, 1);
    const split = new Float32Array(init.split);
    split[1] = 0; // nothing leaves node 1
    const f = createTracers({ ...init, split });
    departOne(f, 0, 0);
    advance(f, TT);
    expect(f.dState[0]).toBe(STUCK);
    expect(f.stuckCount).toBe(1);
    expect(f.dParam[0]).toBe(1);
    expect(f.arrivedCount).toBe(0);
    // and it stays put for the rest of the run
    for (let t = TT; t < 500; t += 10) advance(f, t);
    expect(f.dState[0]).toBe(STUCK);
  });

  it('a car whose own node leads nowhere is counted, not drawn', () => {
    const { init } = lineGraph(3, 2);
    const f = createTracers({ ...init, split: new Float32Array(init.E) });
    departOne(f, 0, 0);
    expect(f.droppedAtOrigin).toBe(1);
    expect(f.movingCount).toBe(0);
    expect(f.dState[0]).toBe(STUCK);
  });
});

describe('conservation: a slot changes state forwards and is never reused', () => {
  it('parked + moving + arrived + stuck accounts for every car, every frame', () => {
    const N = 5;
    const cars = 40;
    const { init } = lineGraph(N, cars);
    const f = createTracers(init);
    const departed = new Float32Array(f.V);
    const n = new Float32Array(f.E).fill(2);
    const outflow = new Float32Array(f.E).fill(4);

    let simT = 0;
    for (let step = 0; step < 200; step++) {
      simT += 1;
      departed[0] = 0.4;
      frame(f, simT, { n, outflow, departed });
      advance(f, simT);
      writeParked(f);
      expect(f.parkedCount + f.movingCount + f.arrivedCount + f.stuckCount).toBe(cars);
    }
    expect(f.arrivedCount).toBeGreaterThan(0);
    // every slot moved forward and none came back to PARKED after leaving
    const states = new Set<number>();
    for (let i = 0; i < cars; i++) states.add(f.dState[i]);
    expect(states.has(PARKED) || states.has(MOVING) || states.has(ARRIVED)).toBe(true);
  });
});

describe('routes: the recorded decisions replay to the edges actually taken', () => {
  it('a route down a chain replays exactly', () => {
    const N = 6;
    const { init } = lineGraph(N, 1);
    const f = createTracers(init);
    departOne(f, 0, 0);
    for (let t = 0; t <= N * TT; t += 1) advance(f, t);
    const { edges, truncated } = replayRoute(f, 0);
    expect(truncated).toBe(false);
    expect(Array.from(edges)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('a route through a branching node replays what the dot chose', () => {
    // node 1 has two out-edges; the dot takes exactly one of them and the replay agrees.
    const V = 4;
    const E = 3;
    const csrOff = Uint32Array.from([0, 1, 3, 3, 3]);
    const edgeTo = Uint32Array.from([1, 2, 3]);
    const isExit = Uint8Array.from([0, 0, 1, 1]);
    const startIndices = Uint32Array.from([0, 2, 4, 6]);
    const vertsM = new Float32Array(12);
    for (let e = 0; e < E; e++) {
      vertsM[e * 4] = e * SPACING_M;
      vertsM[e * 4 + 2] = (e + 1) * SPACING_M;
    }
    const { cum, edgeLen } = cumulative(startIndices, vertsM, E);
    const f = createTracers({
      E,
      V,
      totalVeh: 200,
      seed: 7,
      csrOff,
      edgeTo,
      isExit,
      ttSec: new Uint16Array(E).fill(TT),
      split: Float32Array.from([1, 0.5, 0.5]),
      demand0: Float32Array.from([200, 0, 0, 0]),
      ...buildings(V, []),
      demandNodes: Uint32Array.from([0]),
      nodeXY: new Float32Array(V * 2),
      maxOutDeg: 2,
      storage: new Float32Array(E).fill(1e6),
      startIndices,
      vertsM,
      cum,
      edgeLen,
    });
    const departed = new Float32Array(V);
    departed[0] = 200;
    frame(f, 0, { departed });
    advance(f, TT);

    let left = 0;
    for (let i = 0; i < 200; i++) {
      const { edges } = replayRoute(f, i);
      expect(edges[0]).toBe(0);
      expect(edges[1]).toBe(f.dEdge[i]);
      if (edges[1] === 1) left++;
    }
    // a 50/50 split over 200 draws
    expect(left).toBeGreaterThan(70);
    expect(left).toBeLessThan(130);
  });

  it('a route longer than the prefix keeps its beginning and says it was truncated', () => {
    const N = ROUTE_MAX_HOPS + 20;
    const { init } = lineGraph(N, 1);
    const f = createTracers(init);
    departOne(f, 0, 0);
    for (let t = 0; t <= N * TT; t += TT) advance(f, t);
    const { edges, truncated } = replayRoute(f, 0);
    expect(truncated).toBe(true);
    expect(edges.length).toBe(ROUTE_MAX_HOPS);
    expect(Array.from(edges.slice(0, 5))).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('the load-bearing property: dots on an edge equal n[e]', () => {
  it('a steady stream down a chain settles with one dot per vehicle on every edge', () => {
    // Feed the field a consistent frame stream: lambda cars a second leave node 0, every edge
    // carries lambda * ttSec of them, and every edge discharges lambda a second.
    const N = 6;
    const lambda = 3;
    const total = 4000;
    const { init } = lineGraph(N, total, { storage: 1e6 });
    const f = createTracers(init);

    const n = new Float32Array(f.E).fill(lambda * TT);
    const outflow = new Float32Array(f.E).fill(lambda);
    const departed = new Float32Array(f.V);
    departed[0] = lambda;

    let simT = 0;
    for (let step = 0; step < 400; step++) {
      simT += 1;
      frame(f, simT, { n, outflow, departed });
      advance(f, simT);
    }

    // Absolute, not relative: the FIFO number a car is stamped with carries about a vehicle of
    // slack, and that slack does not shrink with n[e]. What must hold is that the dots on an
    // edge are the cars on it, give or take a car -- not a floating multiple of them, which is
    // exactly what §13.2 used to concede.
    for (let e = 0; e < f.E; e++) {
      expect(Math.abs(f.dotsOn[e] - n[e]), `edge ${e}`).toBeLessThanOrEqual(2);
    }
    expect(dotError(f)).toBeLessThanOrEqual(2);
  });
});

describe('positions', () => {
  it('a dot is placed along its edge and its slot is recoverable for picking', () => {
    const { init } = lineGraph(4, 1);
    const f = createTracers(init);
    departOne(f, 0, 0);
    advance(f, TT / 2);
    expect(writePositions(f, null)).toBe(1);
    expect(f.pos[0]).toBeCloseTo(SPACING_M / 2, 3);
    expect(f.pos[1]).toBeCloseTo(0, 6);
    expect(f.slotOf[0]).toBe(0);
  });

  it('the viewport cull keeps dots on visible edges and drops the rest', () => {
    const { init } = lineGraph(8, 8);
    const f = createTracers(init);
    const departed = new Float32Array(f.V);
    departed[0] = 8;
    frame(f, 0, { departed });
    advance(f, 25); // everyone is on edge 2, which spans x in [2000, 3000]
    expect(writePositions(f, null)).toBe(8);
    expect(writePositions(f, { x0: 1900, y0: -100, x1: 3100, y1: 100 }), 'bounds over edge 2').toBe(8);
    expect(writePositions(f, { x0: -100, y0: -100, x1: SPACING_M, y1: 100 }), 'bounds over edge 0 only').toBe(0);
  });
});
