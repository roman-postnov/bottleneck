// The sanity checks of CONTRACTS.md §14. A red test here means the merge is reverted.
// Written from the contract; where a check cannot hold literally, the deviation is stated
// in the test name and argued in a comment rather than quietly relaxed.

import { describe, expect, it } from 'vitest';
import { classOf, FLAG } from '../src/core/city.ts';
import { maxFlow } from '../src/core/maxflow.ts';
import { nodeTransfer } from '../src/core/nodeModel.ts';
import { CLASS_CODE, capVehS } from '../src/core/params.ts';
import { createRng } from '../src/core/rng.ts';
import { applyEdits, createSim, metrics, snapshot, tick } from '../src/core/sim.ts';
import type { SimState } from '../src/core/types.ts';
import { loadFixture, massInSystem, params, publicCity, run, tinyCity } from './helpers.ts';

const HOUR = 3600;

const exitEdgesOf = (c: { E: number; flags: Uint8Array }): number[] =>
  [...new Array(c.E).keys()].filter((e) => c.flags[e] & FLAG.EXIT_EDGE);

// -------------------------------------------------------------------- 1

describe('check 1: mass is conserved', () => {
  // The contract asks for +-1e-6 absolute. The state lives in Float32 arrays, so rounding
  // alone drifts by ~1e-6 RELATIVE over thousands of ticks; demanding 1e-6 absolute on
  // 9091 vehicles would be demanding exact Float32 arithmetic. Same argument as REVIEW A4.
  it('notDeparted + enRoute + evacuated stays totalVeh on every tick', () => {
    const c = loadFixture('grid20');
    const s = createSim(c, params('grid20'));
    let worst = 0;
    for (let i = 0; i < 6000; i++) {
      tick(s);
      worst = Math.max(worst, Math.abs(massInSystem(s) - s.totalVeh));
    }
    expect(worst / s.totalVeh).toBeLessThan(1e-5);
  });

  it('holds through a hot close as well (§9.3: vehicles do not vanish)', () => {
    const c = loadFixture('island8');
    const s = createSim(c, params('island8'));
    run(s, HOUR);
    const before = massInSystem(s);
    applyEdits(s, [{ op: 'close', edgeId: exitEdgesOf(c)[0] }]);
    expect(massInSystem(s)).toBeCloseTo(before, 3);
    for (let i = 0; i < 600; i++) tick(s);
    expect(Math.abs(massInSystem(s) - s.totalVeh) / s.totalVeh).toBeLessThan(1e-5);
  });
});

// -------------------------------------------------------------------- 2

describe('check 2: an empty network takes the free-flow time', () => {
  it('the last vehicle arrives at cost[src], within 5%', () => {
    const c = loadFixture('line10');
    const s = createSim(
      c,
      params('line10', {
        demand: { participation: 1e-4, mobilizationHalfMin: 0 },
        routing: { logitTheta: 0 },
      }),
    );
    let expected = 0;
    for (let i = 0; i < c.S; i++) expected = Math.max(expected, s.field.cost[c.srcNode[i]]);

    run(s, 6 * HOUR);
    expect(s.t100Sec).toBeGreaterThan(0);
    expect(s.t100Sec).toBeGreaterThanOrEqual(expected * 0.95);
    expect(s.t100Sec).toBeLessThanOrEqual(expected * 1.05 + 2);
  });
});

// -------------------------------------------------------------------- 3

describe('check 3: one edge, two lanes, unbounded demand', () => {
  // §14.3 wants exactly 3600 veh/h, but §2 defaults srcInjectLanes to 1, which caps the
  // driveway feed at 1800 veh/h -- the check as written cannot pass on its own defaults.
  // What it is really testing is the capacity of the EDGE, so the injection is widened
  // until it stops being the binding constraint. Reported to the contract owner.
  it('delivers exactly 3600 veh/h, no epsilon', () => {
    const c = loadFixture('single');
    const s = createSim(
      c,
      params('single', {
        demand: { mobilizationHalfMin: 0 },
        supply: { srcInjectLanes: 2 },
      }),
    );
    for (let i = 0; i < HOUR; i++) tick(s);
    const a = s.evacuated;
    for (let i = 0; i < HOUR; i++) tick(s);
    expect(s.evacuated - a).toBe(3600);
  });

  it('with the default one injection lane the driveway is what binds, at 1800 veh/h', () => {
    const c = loadFixture('single');
    const s = createSim(c, params('single', { demand: { mobilizationHalfMin: 0 } }));
    for (let i = 0; i < HOUR; i++) tick(s);
    const a = s.evacuated;
    for (let i = 0; i < HOUR; i++) tick(s);
    expect(s.evacuated - a).toBe(1800);
  });
});

// -------------------------------------------------------------------- 4

describe('check 4: the node model, the three cases of §7.4', () => {
  /** A -> C, B -> C, C -> X. Capacities chosen so demand and capacity are NOT proportional. */
  function merge() {
    const c = tinyCity({
      V: 4,
      edges: [
        { from: 0, to: 2, lanes: 2, cls: 0, lenM: 1000, speedKmh: 50 }, // cap 1.0 veh/s
        { from: 1, to: 2, lanes: 6, cls: 0, lenM: 1000, speedKmh: 50 }, // cap 3.0 veh/s
        { from: 2, to: 3, lanes: 2, cls: 0, lenM: 1000, speedKmh: 50 }, // cap 1.0 veh/s
      ],
      sources: [
        { node: 0, pop: 10 },
        { node: 1, pop: 10 },
      ],
      exits: [3],
    });
    const s = createSim(c, params('tiny'));
    const [ac, bc, cx] = [0, 1, 2];
    expect(s.cap[ac]).toBeCloseTo(1, 9);
    expect(s.cap[bc]).toBeCloseTo(3, 9);
    return { s, ac, bc, cx };
  }

  it('a merge splits by incoming capacity, not by demand and not evenly', () => {
    const { s, ac, bc, cx } = merge();
    s.demand[ac] = 1;
    s.demand[bc] = 1; // equal demands...
    s.supply[cx] = 1;
    s.field.split[cx] = 1;
    s.queued[2] = 0;

    nodeTransfer(s, 2);

    // ...but capacities are 1:3, and that is the ratio Daganzo's rule must produce.
    expect(s.moveOut[ac]).toBeCloseTo(0.25, 9);
    expect(s.moveOut[bc]).toBeCloseTo(0.75, 9);
    expect(s.moveOut[ac] + s.moveOut[bc]).toBeCloseTo(1, 9);
  });

  it('a saturated participant does not take more than it asked for', () => {
    const { s, ac, bc, cx } = merge();
    s.demand[ac] = 0.1; // far below its proportional share
    s.demand[bc] = 3;
    s.supply[cx] = 1;
    s.field.split[cx] = 1;
    s.queued[2] = 0;

    nodeTransfer(s, 2);

    // 7 digits, not 9: demand[] is a Float32 array, and 0.1 is not exact there.
    expect(s.moveOut[ac]).toBeCloseTo(0.1, 7);
    expect(s.moveOut[bc]).toBeCloseTo(0.9, 7);
  });

  it('a diverge is FIFO: one blocked direction stalls the whole edge', () => {
    const c = tinyCity({
      V: 5,
      edges: [
        { from: 0, to: 1, lanes: 2, cls: 0, lenM: 1000, speedKmh: 50 }, // A -> C
        { from: 1, to: 2, lanes: 2, cls: 0, lenM: 1000, speedKmh: 50 }, // C -> D, has room
        { from: 1, to: 3, lanes: 2, cls: 0, lenM: 1000, speedKmh: 50 }, // C -> E, full
        { from: 2, to: 4, lanes: 2, cls: 0, lenM: 1000, speedKmh: 50 },
        { from: 3, to: 4, lanes: 2, cls: 0, lenM: 1000, speedKmh: 50 },
      ],
      sources: [{ node: 0, pop: 10 }],
      exits: [4],
    });
    const s = createSim(c, params('tiny'));
    const ac = 0;
    const cd = 1;
    const ce = 2;
    s.demand[ac] = 1;
    s.supply[cd] = 10;
    s.supply[ce] = 0; // E is jammed solid
    s.field.split[cd] = 0.5;
    s.field.split[ce] = 0.5;
    s.queued[1] = 0;

    nodeTransfer(s, 1);

    expect(s.moveOut[ac]).toBe(0);
    expect(s.inflow[cd]).toBe(0);
  });

  it('a crossroads gives the same answer whichever way the node is walked', () => {
    const build = () => {
      const c = tinyCity({
        V: 5,
        edges: [
          { from: 0, to: 2, lanes: 2, cls: 0, lenM: 1000, speedKmh: 50 },
          { from: 1, to: 2, lanes: 3, cls: 0, lenM: 1000, speedKmh: 50 },
          { from: 2, to: 3, lanes: 2, cls: 0, lenM: 1000, speedKmh: 50 },
          { from: 2, to: 4, lanes: 2, cls: 0, lenM: 1000, speedKmh: 50 },
        ],
        sources: [
          { node: 0, pop: 10 },
          { node: 1, pop: 10 },
        ],
        exits: [3, 4],
      });
      const s = createSim(c, params('tiny'));
      s.demand[0] = 0.8;
      s.demand[1] = 1.4;
      s.supply[2] = 0.9;
      s.supply[3] = 1.1;
      s.field.split[2] = 0.4;
      s.field.split[3] = 0.6;
      s.queued[2] = 0;
      return s;
    };
    const a = build();
    const b = build();
    nodeTransfer(a, 2);
    nodeTransfer(b, 2);
    expect([...b.moveOut]).toEqual([...a.moveOut]);
    expect([...b.inflow]).toEqual([...a.inflow]);
  });
});

// -------------------------------------------------------------------- 5

describe('check 5: symmetric demand gives a symmetric picture', () => {
  it('the two corner exits of the grid carry the same share', () => {
    const c = loadFixture('grid20');
    const s = createSim(c, params('grid20'));
    const exits = exitEdgesOf(c);
    expect(exits.length).toBe(2);
    const through = new Float64Array(exits.length);
    while (s.t < 24 * HOUR && s.evacuated < s.totalVeh * (1 - 1e-6)) {
      tick(s);
      exits.forEach((e, i) => {
        through[i] += s.moveOut[e];
      });
    }
    expect(through[0] / s.totalVeh).toBeCloseTo(0.5, 3);
    expect(through[1] / s.totalVeh).toBeCloseTo(0.5, 3);
  });
});

// -------------------------------------------------------------------- 6

describe('check 6: a wedge does not dissolve on its own', () => {
  it('once the island jams it stays jammed while demand is left', () => {
    const c = loadFixture('island8');
    const s = createSim(c, params('island8'));
    const jammed = (): number => {
      let k = 0;
      for (let e = 0; e < c.E; e++) if (s.n[e] / s.storage[e] > 0.9) k++;
      return k;
    };
    run(s, HOUR);
    const atOneHour = jammed();
    expect(atOneHour).toBeGreaterThan(5);

    // Demand still far from exhausted, so the queue has no honest reason to clear.
    let low = 0;
    while (s.t < 5 * HOUR) {
      tick(s);
      if (jammed() < atOneHour / 2) low++;
    }
    expect(s.evacuated / s.totalVeh).toBeLessThan(0.9);
    expect(low).toBe(0);
  });
});

// -------------------------------------------------------------------- 7

describe('check 7: doubling the population', () => {
  it('t90 grows by 1.7x to 2.5x, not by 1.05x and not by 12x', () => {
    const t90 = (occupancy: number): number => {
      const c = loadFixture('island8');
      const s = createSim(c, params('island8', { demand: { occupancy } }));
      while (s.t < 48 * HOUR && s.t90Sec < 0) tick(s);
      return s.t90Sec;
    };
    const base = t90(2.2);
    const doubled = t90(1.1); // half the occupancy is twice the vehicles
    expect(base).toBeGreaterThan(0);
    expect(doubled / base).toBeGreaterThan(1.7);
    expect(doubled / base).toBeLessThan(2.5);
  });
});

// -------------------------------------------------------------------- 8

describe('check 8: Mercer Island', () => {
  // §14 calls this the most important check, and it is the only one tied to the world rather
  // than to a fixture this repository generated itself. An hour would mean the model lets a
  // city out through a road that is not there; a day would mean it lets nobody out at all.
  it('t90 lands between 2 and 8 hours', () => {
    const c = publicCity('mercer');
    const s = createSim(c, params('mercer'));
    run(s, 24 * HOUR);
    const m = metrics(s);
    expect(m.stranded).toBeLessThan(1);
    expect(m.t90Sec).not.toBeNull();
    expect(m.t90Sec! / HOUR).toBeGreaterThanOrEqual(2);
    expect(m.t90Sec! / HOUR).toBeLessThanOrEqual(8);
  });

  // The physical claim of §14.8 is "one highway out". If a residential street ever fed an
  // exit, cars would be leaving the island through a cul-de-sac and t90 would look wonderful.
  it('every exit is fed by I-90 or its ramps, never by a side street', () => {
    const c = publicCity('mercer');
    expect(c.X).toBeLessThanOrEqual(4);
    for (let e = 0; e < c.E; e++) {
      if (!c.isExit[c.edgeTo[e]]) continue;
      const cls = classOf(c.flags[e]);
      expect(cls <= CLASS_CODE.primary || cls === CLASS_CODE.link, `${c.nameOf(e) || 'unnamed'} feeds an exit`).toBe(
        true,
      );
    }
  });
});

// -------------------------------------------------------------------- 9

describe('check 9: the simulation never beats the theory', () => {
  it('peak outflow stays under max-flow', () => {
    const c = loadFixture('grid20');
    const p = params('grid20');
    const s = createSim(c, p);
    s.maxFlowVehH = maxFlow(c, p, new Uint8Array(c.E)).valueVehH;
    run(s, 24 * HOUR);
    const m = metrics(s);
    expect(m.maxFlowVehH).toBeGreaterThan(0);
    expect(m.peakOutflowVehH).toBeLessThanOrEqual(m.maxFlowVehH * 1.02);
    expect(m.efficiency).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------- 10

describe('check 10: determinism', () => {
  it('two runs of the same scenario agree bit for bit', () => {
    const go = () => {
      const c = loadFixture('grid20');
      const s = createSim(c, params('grid20'));
      run(s, 3 * HOUR, { frameEvery: 60 });
      const frame = { n: new Float32Array(c.E) };
      snapshot(s, frame);
      return { m: metrics(s), n: frame.n };
    };
    const a = go();
    const b = go();
    expect(b.m).toEqual(a.m);
    expect([...b.n]).toEqual([...a.n]);
  });
});

// -------------------------------------------------------------------- 11

describe('check 11: every exit closed', () => {
  it('nobody leaves, nothing is NaN, and t90 is null', () => {
    const c = loadFixture('line10');
    const s = createSim(c, params('line10'));
    applyEdits(
      s,
      exitEdgesOf(c).map((e) => ({ op: 'close' as const, edgeId: e })),
    );
    run(s, 4 * HOUR);
    const m = metrics(s);
    expect(m.t90Sec).toBeNull();
    expect(m.t100Sec).toBeNull();
    expect(m.evacuatedVeh).toBe(0);
    expect(m.stranded).toBeCloseTo(m.totalVeh, 6);
    for (let e = 0; e < c.E; e++) expect(Number.isNaN(s.n[e])).toBe(false);
    for (let v = 0; v < c.V; v++) expect(Number.isNaN(s.queued[v])).toBe(false);
  });
});

// -------------------------------------------------------------------- 12

describe('check 12: independence from traversal order', () => {
  // Kept apart from check 10 on purpose: Float32 addition is not associative, so bitwise
  // equality here would be a demand for the impossible (REVIEW A4).
  it('walking the nodes in a shuffled order changes nothing beyond 1e-5', () => {
    const prepare = (s: SimState): void => {
      for (let e = 0; e < s.city.E; e++) {
        s.moveOut[e] = 0;
        s.inflow[e] = 0;
        if (s.blocked[e]) {
          s.demand[e] = 0;
          s.supply[e] = 0;
          continue;
        }
        s.demand[e] = Math.min(s.cap[e], s.ready[e]);
        s.supply[e] = Math.min(s.cap[e], Math.max(0, s.storage[e] - s.n[e]));
      }
      for (let v = 0; v < s.city.V; v++) s.moveSrc[v] = 0;
    };

    const c = loadFixture('grid20');
    const ascending = createSim(c, params('grid20'));
    const shuffled = createSim(loadFixture('grid20'), params('grid20'));
    run(ascending, 2 * HOUR);
    run(shuffled, 2 * HOUR);

    prepare(ascending);
    for (let v = 0; v < c.V; v++) nodeTransfer(ascending, v);

    const order = [...new Array(c.V).keys()];
    const rng = createRng(4242);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    prepare(shuffled);
    for (const v of order) nodeTransfer(shuffled, v);

    let scale = 0;
    for (let e = 0; e < c.E; e++) scale = Math.max(scale, Math.abs(ascending.inflow[e]));
    for (let e = 0; e < c.E; e++) {
      expect(Math.abs(shuffled.inflow[e] - ascending.inflow[e])).toBeLessThan(1e-5 * (scale + 1));
      expect(Math.abs(shuffled.moveOut[e] - ascending.moveOut[e])).toBeLessThan(1e-5 * (scale + 1));
    }
    expect(Math.abs(shuffled.evacuated - ascending.evacuated)).toBeLessThan(1e-5 * (ascending.evacuated + 1));
  });
});

// -------------------------------------------------------------------- 13

describe('check 13: the ring buffer', () => {
  it('a vehicle entering at t matures at t + ttSec, not a tick earlier', () => {
    const c = loadFixture('line10');
    const s = createSim(
      c,
      params('line10', {
        demand: { participation: 1e-3, mobilizationHalfMin: 0 },
        routing: { logitTheta: 0 },
      }),
    );
    // The edge that node 0 actually feeds.
    const e = s.field.next[0];
    expect(e).toBeGreaterThanOrEqual(0);
    const tt = s.ttSec[e];
    expect(tt).toBeGreaterThan(3);

    tick(s); // t: 0 -> 1, vehicles entered edge e during tick 0
    expect(s.n[e]).toBeGreaterThan(0);

    for (let k = 1; k < tt; k++) {
      tick(s);
      expect(s.moveOut[e], `matured early at t=${s.t}`).toBe(0);
    }
    tick(s); // this is tick number tt
    expect(s.moveOut[e]).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------- 14 and 15

describe('checks 14 and 15: max-flow and the min cut', () => {
  it.each(['grid20', 'island8', 'line10', 'single'])('on %s the cut capacity equals the flow exactly', (name) => {
    const c = loadFixture(name);
    const p = params(name);
    const r = maxFlow(c, p, new Uint8Array(c.E));
    let sum = 0;
    for (const e of r.cutEdges) {
      sum += Math.round(capVehS(c.lanes[e], classOf(c.flags[e]), p.satFlowPerLane) * 3600);
    }
    expect(r.valueVehH).toBeGreaterThan(0);
    expect(sum).toBe(r.valueVehH);
  });

  it('the cut is made of roads, never of source or sink arcs', () => {
    const c = loadFixture('island8');
    const r = maxFlow(c, params('island8'), new Uint8Array(c.E));
    expect(r.cutEdges.length).toBeGreaterThan(0);
    for (const e of r.cutEdges) {
      expect(e).toBeLessThan(c.E);
      // A cut edge runs from the source side to the sink side, and both ends are real nodes.
      expect(r.cutSideS[c.edgeFrom[e]]).toBe(1);
      expect(r.cutSideS[c.edgeTo[e]]).toBe(0);
    }
  });

  it('closing an edge can only lower the ceiling', () => {
    const c = loadFixture('grid20');
    const p = params('grid20');
    const open = maxFlow(c, p, new Uint8Array(c.E));
    const blocked = new Uint8Array(c.E);
    blocked[open.cutEdges[0]] = 1;
    expect(maxFlow(c, p, blocked).valueVehH).toBeLessThan(open.valueVehH);
  });
});

// -------------------------------------------------------------------- 17

describe('check 17: no leak', () => {
  it('10 000 ticks do not grow the heap by 5 MB', () => {
    const c = loadFixture('grid20');
    const s = createSim(c, params('grid20'));
    for (let i = 0; i < 500; i++) tick(s);
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 10000; i++) tick(s);
    globalThis.gc?.();
    const after = process.memoryUsage().heapUsed;
    expect(after - before).toBeLessThan(5e6);
  });
});
