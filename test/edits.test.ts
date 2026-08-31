// Interventions, docs/CONTRACTS.md §9.1 and §9.3: hot application, and the schedule that makes a
// closure made mid-run reproducible from the permalink.

import { describe, expect, it } from 'vitest';
import { FLAG } from '../src/core/city.ts';
import { maxFlow } from '../src/core/maxflow.ts';
import { resolveParams } from '../src/core/scenario.ts';
import { createSim, metrics, snapshot } from '../src/core/sim.ts';
import type { Edit } from '../src/core/types.ts';
import { loadFixture, params, run, scenario } from './helpers.ts';

const HOUR = 3600;

const exitEdgesOf = (c: { E: number; flags: Uint8Array }): number[] =>
  [...new Array(c.E).keys()].filter((e) => c.flags[e] & FLAG.EXIT_EDGE);

function sim(city: string, edits: Edit[]) {
  const c = loadFixture(city);
  const s = createSim(c, resolveParams(scenario(city, { edits })), edits);
  return { c, s };
}

describe('§9.1: an edit without atMin lands before the first tick', () => {
  it('closing every exit up front strands everyone', () => {
    const c = loadFixture('line10');
    const edits: Edit[] = exitEdgesOf(c).map((e) => ({ op: 'close', edgeId: e }));
    const s = createSim(c, params('line10'), edits);
    run(s, 6 * HOUR);
    expect(metrics(s).t90Sec).toBeNull();
    expect(s.evacuated).toBe(0);
  });
});

describe('§9.1: atMin is honoured to the second', () => {
  it('does not act a tick early and does act on the minute', () => {
    const c = loadFixture('line10');
    const e = exitEdgesOf(c)[0];
    const { s } = sim('line10', [{ op: 'close', edgeId: e, atMin: 30 }]);

    run(s, 30 * 60 - 1);
    expect(s.blocked[e]).toBe(0);
    expect(s.scheduleCursor).toBe(0);

    run(s, 30 * 60 + 1);
    expect(s.blocked[e]).toBe(1);
    expect(s.cap[e]).toBe(0);
    expect(s.scheduleCursor).toBe(1);
  });

  it('leaves the vehicles already on the closed edge where they are (§9.3)', () => {
    const c = loadFixture('line10');
    const e = exitEdgesOf(c)[0];
    const { s } = sim('line10', [{ op: 'close', edgeId: e, atMin: 20 }]);
    run(s, 20 * 60);
    const before = s.n[e];
    expect(before).toBeGreaterThan(0);
    run(s, 20 * 60 + 1); // the tick that fires the closure
    expect(s.blocked[e]).toBe(1);
    expect(s.n[e]).toBe(before);
  });
});

describe('§9.1: order of application', () => {
  // Two edits on the same minute leave a different cap depending on which lands last, so the
  // sort has to be stable. Array.prototype.sort is, and this pins it.
  it('ties keep the order they have in the scenario', () => {
    const e = 0;
    const { s } = sim('grid20', [
      { op: 'lanes', edgeId: e, lanes: 4, atMin: 10 },
      { op: 'lanes', edgeId: e, lanes: 1, atMin: 10 },
    ]);
    run(s, 10 * 60 + 1);
    expect(s.lanes[e]).toBe(1);
  });

  it('an earlier atMin fires first however the scenario lists them', () => {
    const e = 0;
    const { s } = sim('grid20', [
      { op: 'lanes', edgeId: e, lanes: 4, atMin: 20 },
      { op: 'lanes', edgeId: e, lanes: 1, atMin: 5 },
    ]);
    run(s, 6 * 60);
    expect(s.lanes[e]).toBe(1);
    run(s, 21 * 60);
    expect(s.lanes[e]).toBe(4);
  });
});

describe('§10: a scheduled run is still bit-for-bit reproducible', () => {
  // This is the whole reason atMin exists. Without it the closure lives in the worker and the
  // permalink reproduces a different evacuation from the one that was on screen.
  it('two runs of the same schedule agree exactly', () => {
    const edits: Edit[] = [
      { op: 'close', edgeId: 3, atMin: 15 },
      { op: 'lanes', edgeId: 7, lanes: 3, atMin: 40 },
    ];
    const go = () => {
      const { c, s } = sim('grid20', edits);
      run(s, 3 * HOUR, { frameEvery: 60 });
      const frame = { n: new Float32Array(c.E) };
      snapshot(s, frame);
      return { m: metrics(s), n: [...frame.n] };
    };
    const a = go();
    const b = go();
    expect(b.m).toEqual(a.m);
    expect(b.n).toEqual(a.n);
  });

  // This compares two long grid20 runs; constrained CI runners can need more than Vitest's
  // five-second default even when the reproducibility assertion itself passes.
  it('a closure at minute 15 is not the same run as the same closure at minute 0', () => {
    const exit = exitEdgesOf(loadFixture('grid20'))[0];
    const at = (atMin: number | undefined) => {
      const { s } = sim('grid20', [{ op: 'close', edgeId: exit, atMin }]);
      run(s, 8 * HOUR);
      return metrics(s).t90Sec;
    };
    const late = at(15);
    const upFront = at(undefined);
    expect(late).not.toBeNull();
    expect(upFront).not.toBeNull();
    // Only that the moment matters, not which way. Measured, the late closure comes out
    // slightly worse (24297 s against 24208 s) -- traffic that already committed to the
    // doomed road has to back out of it -- but that direction was observed, not predicted,
    // and asserting it here would be fitting the test to the number.
    expect(late).not.toBe(upFront);
  }, 30_000);
});

describe('§9.3: contraflow', () => {
  it('moves the twin lanes across and blocks the twin', () => {
    const c = loadFixture('grid20');
    const e = 0;
    const twin = c.twin[e];
    expect(twin).not.toBe(0xffffffff);
    const before = c.lanes[e] + c.lanes[twin];
    const { s } = sim('grid20', [{ op: 'contraflow', edgeId: e, atMin: 5 }]);
    run(s, 5 * 60 + 1);
    expect(s.lanes[e]).toBe(before);
    expect(s.lanes[twin]).toBe(0);
    expect(s.blocked[twin]).toBe(1);
    expect(s.contraflow[twin]).toBe(1);
  });

  it('keeps an ordinary closure distinct from a contraflow closure', () => {
    const { s } = sim('line10', [
      { op: 'close', edgeId: 0, cause: 'contraflow' },
      { op: 'close', edgeId: 1 },
    ]);

    expect(s.contraflow[0]).toBe(1);
    expect(s.contraflow[1]).toBe(0);
  });
});

describe('§12: the ceiling follows the edited network', () => {
  // Max-flow must use edited lanes so efficiency remains bounded by the current network.
  it('widening the roads out raises maxFlowVehH', () => {
    const c = loadFixture('grid20');
    const p = params('grid20');
    const bare = createSim(c, p);
    const wide = createSim(
      c,
      p,
      exitEdgesOf(c).map((e) => ({ op: 'lanes' as const, edgeId: e, lanes: 8 })),
    );
    expect(maxFlow(c, p, wide.blocked, wide.lanes).valueVehH).toBeGreaterThan(
      maxFlow(c, p, bare.blocked, bare.lanes).valueVehH,
    );
  });
});

describe('§9.3: addRoad is refused, not silently ignored', () => {
  it('createSim throws rather than pretending the road is there', () => {
    const c = loadFixture('line10');
    expect(() =>
      createSim(c, params('line10'), [
        {
          op: 'addRoad',
          id: 1_000_000_000,
          from: [0, 0],
          to: [0, 1],
          lanes: 2,
          speedKmh: 50,
          bidirectional: false,
        },
      ]),
    ).toThrow(/addRoad/);
  });
});
