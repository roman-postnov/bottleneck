// The routing field (CONTRACTS.md §6): one reverse Dijkstra from the set of exits,
// turned into split shares over the out-edges of every node.

import { DEFAULTS } from './params.ts';
import { IndexedMinHeap } from './heap.ts';
import type { City, Field, SimState } from './types.ts';

const EPS = 1e-9;

type Scratch = { heap: IndexedMinHeap; u: Float32Array; w: Float32Array };

// Keyed by city so a second city in the same tab does not reuse buffers of the wrong length.
// buildField runs every reoptSec simulated seconds, never inside a tick, so a WeakMap here
// is not on any hot path.
const scratchOf = new WeakMap<City, Scratch>();

function scratchFor(city: City): Scratch {
  let s = scratchOf.get(city);
  if (!s) {
    s = {
      heap: new IndexedMinHeap(city.V),
      u: new Float32Array(city.maxOutDeg),
      w: new Float32Array(city.maxOutDeg),
    };
    scratchOf.set(city, s);
  }
  return s;
}

function ensureField(city: City, out: Field | undefined): Field {
  if (out && out.split.length === city.E && out.cost.length === city.V) return out;
  return {
    split: new Float32Array(city.E),
    cost: new Float32Array(city.V),
    next: new Int32Array(city.V),
  };
}

/**
 * Free-flow travel time per edge, seconds (§2). Speeds come straight from the file;
 * a scenario's speedFactor is applied by the simulation when it builds its own ttSec.
 */
export function freeFlowCost(city: City, out?: Float32Array): Float32Array {
  const cost = out && out.length === city.E ? out : new Float32Array(city.E);
  for (let e = 0; e < city.E; e++) {
    cost[e] = Math.max(1, Math.round(city.lenM[e] / ((city.speedKmh[e] * 1000) / 3600)));
  }
  return cost;
}

/**
 * What drivers who can see the traffic believe an edge costs: free-flow time plus the time
 * needed to discharge the queue already standing at its exit, smoothed exponentially.
 * Smoothing is what keeps the reactive mode from oscillating between two routes (§2).
 */
export function observedCost(
  sim: SimState,
  prev: Float32Array,
  smoothing: number,
  out?: Float32Array,
): Float32Array {
  const E = sim.city.E;
  const cost = out && out.length === E ? out : new Float32Array(E);
  for (let e = 0; e < E; e++) {
    const raw = sim.ttSec[e] + sim.ready[e] / Math.max(sim.cap[e], EPS);
    cost[e] = smoothing * raw + (1 - smoothing) * prev[e];
  }
  return cost;
}

/**
 * Reverse Dijkstra from `exits`, then split shares per node.
 *
 * splitEpsilon is a trailing optional argument: §6.2 requires the cutoff but the signature
 * in §6.1 has nowhere to pass it, and it is a scenario parameter, not a constant.
 */
export function buildField(
  city: City,
  exits: Uint32Array,
  edgeCostSec: Float32Array,
  blocked: Uint8Array,
  theta: number,
  out?: Field,
  splitEpsilon: number = DEFAULTS.splitEpsilon,
): Field {
  const field = ensureField(city, out);
  const { cost, split, next } = field;
  const { V, csrOff, edgeTo, inOff, inEdge, edgeFrom } = city;
  const { heap, u, w } = scratchFor(city);

  cost.fill(Infinity);
  split.fill(0);
  next.fill(-1);

  heap.reset(cost);
  for (let i = 0; i < exits.length; i++) {
    const x = exits[i];
    if (x < V && cost[x] !== 0) {
      cost[x] = 0;
      heap.pushOrDecrease(x);
    }
  }

  while (heap.size > 0) {
    const v = heap.pop();
    const cv = cost[v];
    for (let k = inOff[v]; k < inOff[v + 1]; k++) {
      const e = inEdge[k];
      if (blocked[e]) continue;
      const uNode = edgeFrom[e];
      const cand = cv + edgeCostSec[e];
      if (cand < cost[uNode]) {
        cost[uNode] = cand;
        heap.pushOrDecrease(uNode);
      }
    }
  }

  for (let v = 0; v < V; v++) {
    const a = csrOff[v];
    const b = csrOff[v + 1];
    const deg = b - a;
    if (deg === 0) continue;

    let best = Infinity;
    for (let i = 0; i < deg; i++) {
      const e = a + i;
      const cTo = cost[edgeTo[e]];
      // cTo < cost[v] keeps flow strictly descending towards an exit, so no set of used arcs
      // can form a cycle. §6.2 does not ask for it, and on 200 m synthetic edges it changes
      // nothing -- the backward option costs 2*ttSec more and the logit kills it anyway. On
      // real geometry, where the median edge is 92 m and the 10th percentile is 30 m, the
      // backward option costs 7 s more, keeps a third of the share, and the two directions of
      // one street are both told to drive. That deadlocks the network for good.
      const usable = !blocked[e] && cTo !== Infinity && cTo < cost[v];
      u[i] = usable ? edgeCostSec[e] + cTo : Infinity;
      if (u[i] < best) best = u[i];
    }
    if (best === Infinity) continue;

    let sum = 0;
    if (theta <= 0) {
      for (let i = 0; i < deg; i++) w[i] = 0;
      for (let i = 0; i < deg; i++) {
        if (u[i] === best) {
          w[i] = 1; // ties go to the lower index (§6.2)
          sum = 1;
          break;
        }
      }
    } else {
      for (let i = 0; i < deg; i++) {
        w[i] = u[i] === Infinity ? 0 : Math.exp(-theta * (u[i] - best));
        sum += w[i];
      }
    }
    if (sum <= EPS) continue;

    // Zeroing tiny shares is not cosmetic: under the FIFO rule of §7.4 any non-zero share
    // pointed at a jammed edge stalls the whole node, and the logit hands out 1e-6 shares
    // to hopeless directions. Without this the reactive mode deadlocks.
    let kept = 0;
    for (let i = 0; i < deg; i++) {
      const share = w[i] / sum;
      w[i] = share < splitEpsilon ? 0 : share;
      kept += w[i];
    }
    if (kept <= EPS) continue;

    let bestShare = 0;
    for (let i = 0; i < deg; i++) {
      const share = w[i] / kept;
      split[a + i] = share;
      if (share > bestShare) {
        bestShare = share;
        next[v] = a + i;
      }
    }
  }

  return field;
}
