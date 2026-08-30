// The routing field, from CONTRACTS.md §6.

import { describe, it, expect } from 'vitest';
import { buildField, freeFlowCost } from '../src/core/routing.ts';
import { DEFAULTS } from '../src/core/params.ts';
import { loadFixture, tinyCity } from './helpers.ts';

describe('buildField: cost', () => {
  it('an exit costs zero and every source can reach one', () => {
    const c = loadFixture('grid20');
    const f = buildField(c, c.exitNode, freeFlowCost(c), new Uint8Array(c.E), 0);
    for (let i = 0; i < c.X; i++) expect(f.cost[c.exitNode[i]]).toBe(0);
    for (let i = 0; i < c.S; i++) expect(f.cost[c.srcNode[i]]).toBeLessThan(Infinity);
  });

  it('cost equals the free-flow time along the chain', () => {
    const c = loadFixture('line10');
    const cost = freeFlowCost(c);
    const f = buildField(c, c.exitNode, cost, new Uint8Array(c.E), 0);
    // Walking from any node along its own best out-edge must spend exactly cost[v].
    for (let v = 0; v < c.V; v++) {
      if (f.cost[v] === Infinity || c.isExit[v]) continue;
      let spent = 0;
      let cur = v;
      for (let guard = 0; guard < c.V + 2 && !c.isExit[cur]; guard++) {
        const e = f.next[cur];
        expect(e).toBeGreaterThanOrEqual(0);
        spent += cost[e];
        cur = c.edgeTo[e];
      }
      expect(c.isExit[cur]).toBe(1);
      expect(spent).toBeCloseTo(f.cost[v], 4);
    }
  });

  it('an unreachable node costs +Infinity and gets no split', () => {
    const c = tinyCity({
      V: 4,
      // 0 -> 1 -> exit(2); node 3 is a dead end with no way out
      edges: [
        { from: 0, to: 1, lanes: 1, cls: 5, lenM: 100, speedKmh: 30 },
        { from: 1, to: 2, lanes: 1, cls: 5, lenM: 100, speedKmh: 30 },
        { from: 3, to: 3, lanes: 1, cls: 5, lenM: 100, speedKmh: 30 },
      ],
      sources: [{ node: 0, pop: 100 }],
      exits: [2],
    });
    const f = buildField(c, c.exitNode, freeFlowCost(c), new Uint8Array(c.E), 0);
    expect(f.cost[3]).toBe(Infinity);
    expect(f.next[3]).toBe(-1);
    for (let e = c.csrOff[3]; e < c.csrOff[4]; e++) expect(f.split[e]).toBe(0);
  });

  it('a blocked edge is never routed through', () => {
    const c = loadFixture('grid20');
    const blocked = new Uint8Array(c.E);
    for (let e = 0; e < c.E; e++) if (c.edgeTo[e] === c.exitNode[0]) blocked[e] = 1;
    const f = buildField(c, c.exitNode, freeFlowCost(c), blocked, 0);
    for (let e = 0; e < c.E; e++) if (blocked[e]) expect(f.split[e]).toBe(0);
  });
});

describe('buildField: split', () => {
  // Sanity check 16.
  it.each(['grid20', 'line10', 'island8'])(
    'on %s the split of every node sums to 1 or 0',
    (name) => {
      const c = loadFixture(name);
      for (const theta of [0, DEFAULTS.logitTheta, 1.0]) {
        const f = buildField(c, c.exitNode, freeFlowCost(c), new Uint8Array(c.E), theta);
        for (let v = 0; v < c.V; v++) {
          let sum = 0;
          for (let e = c.csrOff[v]; e < c.csrOff[v + 1]; e++) sum += f.split[e];
          const ok = Math.abs(sum - 1) < 1e-6 || Math.abs(sum) < 1e-6;
          expect(ok, `node ${v}, theta ${theta}, sum ${sum}`).toBe(true);
        }
      }
    },
  );

  it('theta = 0 puts everything on one edge, ties going to the lower index', () => {
    const c = tinyCity({
      V: 4,
      edges: [
        // two identical ways out of node 0
        { from: 0, to: 1, lanes: 1, cls: 5, lenM: 300, speedKmh: 30 },
        { from: 0, to: 2, lanes: 1, cls: 5, lenM: 300, speedKmh: 30 },
        { from: 1, to: 3, lanes: 1, cls: 5, lenM: 300, speedKmh: 30 },
        { from: 2, to: 3, lanes: 1, cls: 5, lenM: 300, speedKmh: 30 },
      ],
      sources: [{ node: 0, pop: 100 }],
      exits: [3],
    });
    const f = buildField(c, c.exitNode, freeFlowCost(c), new Uint8Array(c.E), 0);
    expect(f.split[c.csrOff[0]]).toBe(1);
    expect(f.split[c.csrOff[0] + 1]).toBe(0);
  });

  it('theta > 0 spreads across equal alternatives', () => {
    const c = tinyCity({
      V: 4,
      edges: [
        { from: 0, to: 1, lanes: 1, cls: 5, lenM: 300, speedKmh: 30 },
        { from: 0, to: 2, lanes: 1, cls: 5, lenM: 300, speedKmh: 30 },
        { from: 1, to: 3, lanes: 1, cls: 5, lenM: 300, speedKmh: 30 },
        { from: 2, to: 3, lanes: 1, cls: 5, lenM: 300, speedKmh: 30 },
      ],
      sources: [{ node: 0, pop: 100 }],
      exits: [3],
    });
    const f = buildField(c, c.exitNode, freeFlowCost(c), new Uint8Array(c.E), 0.15);
    expect(f.split[c.csrOff[0]]).toBeCloseTo(0.5, 6);
    expect(f.split[c.csrOff[0] + 1]).toBeCloseTo(0.5, 6);
  });

  // §6.2: without this the FIFO rule of §7.4 deadlocks the reactive mode.
  it('shares below splitEpsilon are dropped, not merely small', () => {
    const c = tinyCity({
      V: 4,
      edges: [
        { from: 0, to: 1, lanes: 1, cls: 5, lenM: 100, speedKmh: 30 },
        { from: 0, to: 2, lanes: 1, cls: 5, lenM: 30000, speedKmh: 30 }, // hopeless detour
        { from: 1, to: 3, lanes: 1, cls: 5, lenM: 100, speedKmh: 30 },
        { from: 2, to: 3, lanes: 1, cls: 5, lenM: 100, speedKmh: 30 },
      ],
      sources: [{ node: 0, pop: 100 }],
      exits: [3],
    });
    const f = buildField(c, c.exitNode, freeFlowCost(c), new Uint8Array(c.E), 0.15, { splitEpsilon: 0.01 });
    expect(f.split[c.csrOff[0]]).toBe(1);
    expect(f.split[c.csrOff[0] + 1]).toBe(0);
  });

  // On 200 m synthetic edges the backward option costs 2*ttSec more and the logit kills it on
  // its own. On real OSM geometry the median edge is 92 m and the tenth percentile is 30 m --
  // there the backward option is 7 s dearer, keeps a third of the share, and both directions
  // of one street get told to drive. Mercer Island deadlocked at 8% evacuated because of it.
  it('never sends a share to a node that is no closer to an exit', () => {
    const c = tinyCity({
      V: 3,
      edges: [
        { from: 0, to: 1, lanes: 1, cls: 5, lenM: 30, speedKmh: 30 },
        { from: 1, to: 0, lanes: 1, cls: 5, lenM: 30, speedKmh: 30 },
        { from: 1, to: 2, lanes: 1, cls: 5, lenM: 30, speedKmh: 30 },
      ],
      sources: [{ node: 0, pop: 100 }],
      exits: [2],
    });
    const f = buildField(c, c.exitNode, freeFlowCost(c), new Uint8Array(c.E), 0.15);
    for (let v = 0; v < c.V; v++) {
      for (let e = c.csrOff[v]; e < c.csrOff[v + 1]; e++) {
        if (f.split[e] > 0) expect(f.cost[c.edgeTo[e]]).toBeLessThan(f.cost[v]);
      }
    }
    // The way back from node 1 to node 0 is 60 s of detour on a 30 m street; the plain logit
    // would hand it exp(-0.15 * 2 * 3.6) = 0.34 of the flow.
    expect(f.split[c.csrOff[1]]).toBe(0);
  });

  it('reuses the buffer it is handed', () => {
    const c = loadFixture('line10');
    const first = buildField(c, c.exitNode, freeFlowCost(c), new Uint8Array(c.E), 0);
    const again = buildField(c, c.exitNode, freeFlowCost(c), new Uint8Array(c.E), 0, { out: first });
    expect(again).toBe(first);
    expect(again.split).toBe(first.split);
  });
});

// -------------------------------------------------------------- §6.2 the informed share

/** True if the arcs carrying flow contain a directed cycle. */
function hasCycle(c: ReturnType<typeof loadFixture>, split: Float32Array): boolean {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Uint8Array(c.V);
  const stack: number[] = [];

  for (let root = 0; root < c.V; root++) {
    if (colour[root] !== WHITE) continue;
    stack.push(root);
    while (stack.length > 0) {
      const v = stack[stack.length - 1];
      if (colour[v] === WHITE) colour[v] = GREY;
      let descended = false;
      for (let e = c.csrOff[v]; e < c.csrOff[v + 1]; e++) {
        if (split[e] <= 0) continue;
        const to = c.edgeTo[e];
        if (colour[to] === GREY) return true;
        if (colour[to] === WHITE) {
          stack.push(to);
          descended = true;
          break;
        }
      }
      if (!descended) {
        colour[v] = BLACK;
        stack.pop();
      }
    }
  }
  return false;
}

/**
 * Observed prices that disagree with free-flow ones about direction. Multiplying every other
 * edge is enough: on a grid it reverses the preference at most nodes, which is exactly the
 * input on which mixing the shares of two fields would put flow on both sides of a street.
 */
function contraryObserved(free: Float32Array): Float32Array {
  const obs = Float32Array.from(free);
  for (let e = 0; e < obs.length; e += 2) obs[e] *= 20;
  return obs;
}

const MIXES = [0, 0.1, 0.33, 0.5, 0.9, 1];

describe('buildField: the informed share', () => {
  it('never builds a cycle, however the two costs disagree', () => {
    for (const id of ['grid20', 'island8', 'line10']) {
      const c = loadFixture(id);
      const free = freeFlowCost(c);
      const obs = contraryObserved(free);
      for (const informed of MIXES) {
        const f = buildField(c, c.exitNode, free, new Uint8Array(c.E), DEFAULTS.logitTheta, {
          informed,
          edgeCostObs: obs,
        });
        expect(hasCycle(c, f.split), `${id} at informed=${informed}`).toBe(false);
      }
    }
  });

  // Sanity check 16, restated: the blend of two distributions is a distribution.
  it('keeps every node summing to 1 or 0', () => {
    const c = loadFixture('grid20');
    const free = freeFlowCost(c);
    const obs = contraryObserved(free);
    for (const informed of MIXES) {
      const f = buildField(c, c.exitNode, free, new Uint8Array(c.E), DEFAULTS.logitTheta, {
        informed,
        edgeCostObs: obs,
      });
      for (let v = 0; v < c.V; v++) {
        let sum = 0;
        for (let e = c.csrOff[v]; e < c.csrOff[v + 1]; e++) sum += f.split[e];
        if (c.csrOff[v + 1] === c.csrOff[v]) continue;
        expect(Math.min(Math.abs(sum - 1), Math.abs(sum))).toBeLessThan(1e-6);
      }
    }
  });

  // §6.2 step 1 again: the blend can land a share below the cutoff even when neither field did,
  // and under FIFO any non-zero share pointed at a jammed edge stalls the whole node.
  it('leaves no share between zero and splitEpsilon', () => {
    const c = loadFixture('grid20');
    const free = freeFlowCost(c);
    const obs = contraryObserved(free);
    for (const informed of [0.005, 0.1, 0.5, 0.995]) {
      const f = buildField(c, c.exitNode, free, new Uint8Array(c.E), DEFAULTS.logitTheta, {
        informed,
        edgeCostObs: obs,
        splitEpsilon: DEFAULTS.splitEpsilon,
      });
      for (let e = 0; e < c.E; e++) {
        expect(f.split[e] === 0 || f.split[e] >= DEFAULTS.splitEpsilon).toBe(true);
      }
    }
  });

  it('prices the uninformed share by the map even where the traffic says turn back', () => {
    const c = tinyCity({
      V: 4,
      edges: [
        { from: 0, to: 1, lanes: 1, cls: 5, lenM: 300, speedKmh: 30 },
        { from: 1, to: 0, lanes: 1, cls: 5, lenM: 300, speedKmh: 30 },
        { from: 1, to: 3, lanes: 1, cls: 5, lenM: 300, speedKmh: 30 },
        { from: 0, to: 3, lanes: 1, cls: 5, lenM: 6000, speedKmh: 30 },
      ],
      sources: [{ node: 0, pop: 100 }],
      exits: [3],
    });
    const free = freeFlowCost(c);
    // The short way out is jammed solid, so the observed field wants everyone at node 1 to
    // drive back to node 0 and take the long way. That is the arc that would close the loop.
    const obs = Float32Array.from(free);
    obs[2] *= 400;

    const f = buildField(c, c.exitNode, free, new Uint8Array(c.E), DEFAULTS.logitTheta, {
      informed: 0.5,
      edgeCostObs: obs,
    });
    expect(f.split[1]).toBe(0);
    expect(hasCycle(c, f.split)).toBe(false);
  });

  it('does not price the observed field at all when nobody can see it', () => {
    const c = loadFixture('grid20');
    const free = freeFlowCost(c);
    const f = buildField(c, c.exitNode, free, new Uint8Array(c.E), DEFAULTS.logitTheta, {
      informed: 0,
      edgeCostObs: contraryObserved(free),
    });
    for (let v = 0; v < c.V; v++) expect(f.costObs[v]).toBe(0);
  });
});
