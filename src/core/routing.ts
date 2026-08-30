// The routing field (CONTRACTS.md §6): reverse Dijkstra from the set of exits, turned into
// split shares over the out-edges of every node.

import { IndexedMinHeap } from './heap.ts';
import { DEFAULTS, ttSec } from './params.ts';
import type { City, Field, SimState } from './types.ts';

const EPS = 1e-9;

type Scratch = {
  heap: IndexedMinHeap;
  uFree: Float32Array;
  wFree: Float32Array;
  uObs: Float32Array;
  wObs: Float32Array;
  /** Node potential the candidate set descends; see the gate note in buildField. */
  gate: Float32Array;
  edgeMix: Float32Array;
};

// Keyed by city so a second city in the same tab does not reuse buffers of the wrong length.
// buildField runs every reoptSec simulated seconds, never inside a tick, so a WeakMap here
// is not on any hot path.
const scratchOf = new WeakMap<City, Scratch>();

function scratchFor(city: City): Scratch {
  let s = scratchOf.get(city);
  if (!s) {
    s = {
      heap: new IndexedMinHeap(city.V),
      uFree: new Float32Array(city.maxOutDeg),
      wFree: new Float32Array(city.maxOutDeg),
      uObs: new Float32Array(city.maxOutDeg),
      wObs: new Float32Array(city.maxOutDeg),
      gate: new Float32Array(city.V),
      edgeMix: new Float32Array(city.E),
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
    costObs: new Float32Array(city.V),
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
    cost[e] = ttSec(city.lenM[e], city.speedKmh[e]);
  }
  return cost;
}

/**
 * What drivers who can see the traffic believe an edge costs: free-flow time plus the time
 * needed to discharge the queue already standing at its exit, smoothed exponentially.
 * Smoothing is what keeps the informed share from oscillating between two routes (§2).
 */
export function observedCost(sim: SimState, prev: Float32Array, smoothing: number, out?: Float32Array): Float32Array {
  const E = sim.city.E;
  const cost = out && out.length === E ? out : new Float32Array(E);
  for (let e = 0; e < E; e++) {
    const raw = sim.ttSec[e] + sim.ready[e] / Math.max(sim.cap[e], EPS);
    cost[e] = smoothing * raw + (1 - smoothing) * prev[e];
  }
  return cost;
}

/** Reverse Dijkstra over the unblocked edges, writing seconds-to-exit into `cost`. */
function dijkstra(
  city: City,
  exits: Uint32Array,
  edgeCostSec: Float32Array,
  blocked: Uint8Array,
  heap: IndexedMinHeap,
  cost: Float32Array,
): void {
  const { V, inOff, inEdge, edgeFrom } = city;

  cost.fill(Number.POSITIVE_INFINITY);
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
}

/** Logit weights of §6.2 over the usable slots of one node, normalised to sum 1. */
function logit(u: Float32Array, w: Float32Array, deg: number, theta: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < deg; i++) if (u[i] < best) best = u[i];
  if (best === Number.POSITIVE_INFINITY) return 0;

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
      w[i] = u[i] === Number.POSITIVE_INFINITY ? 0 : Math.exp(-theta * (u[i] - best));
      sum += w[i];
    }
  }
  if (sum <= EPS) return 0;
  for (let i = 0; i < deg; i++) w[i] /= sum;
  return 1;
}

export type FieldOptions = {
  out?: Field;
  splitEpsilon?: number;
  /** Share of flow routing on `edgeCostObs` instead of free-flow cost, 0..1. */
  informed?: number;
  /** Required when `informed > 0`; ignored otherwise. */
  edgeCostObs?: Float32Array;
};

/**
 * Reverse Dijkstra from `exits`, then split shares per node (§6.2).
 *
 * `edgeCostFree` is the free-flow price of an edge and it does double duty: it prices the
 * routes of the uninformed share, and its node potential defines which out-edges are
 * candidates at all. Congestion reweights the candidates; it never changes the set.
 */
export function buildField(
  city: City,
  exits: Uint32Array,
  edgeCostFree: Float32Array,
  blocked: Uint8Array,
  theta: number,
  opts: FieldOptions = {},
): Field {
  const splitEpsilon = opts.splitEpsilon ?? DEFAULTS.splitEpsilon;
  // A hand-written scenario can carry anything; a negative mix would hand out negative
  // shares, which the splitEpsilon cutoff would silently swallow.
  const informed = Math.min(1, Math.max(0, opts.informed ?? 0));
  const edgeCostObs = opts.edgeCostObs;
  const useObs = informed > 0 && edgeCostObs !== undefined;
  const obsCost = edgeCostObs ?? edgeCostFree;

  const field = ensureField(city, opts.out);
  const { cost, costObs, split, next } = field;
  const { V, csrOff, edgeTo } = city;
  const { heap, uFree, wFree, uObs, wObs, gate, edgeMix } = scratchFor(city);

  split.fill(0);
  next.fill(-1);

  dijkstra(city, exits, edgeCostFree, blocked, heap, cost);
  if (useObs) dijkstra(city, exits, obsCost, blocked, heap, costObs);

  // The gate potential. Not one of the two above: switching the candidate set from one to the
  // other the instant anybody becomes informed makes this parameter a step rather than a dial.
  // Measured on Mercer Island at a jammed moment, total variation of the split against
  // informed=0: 109.5 at informed=0.001 and 134.5 at informed=1 -- four fifths of the whole
  // effect delivered by the first tenth of a percent. Pricing the gate on the blended edge
  // cost moves it with the dial instead.
  let descent = cost;
  if (informed >= 1) {
    descent = costObs;
  } else if (useObs) {
    for (let e = 0; e < city.E; e++) {
      edgeMix[e] = (1 - informed) * edgeCostFree[e] + informed * obsCost[e];
    }
    dijkstra(city, exits, edgeMix, blocked, heap, gate);
    descent = gate;
  }

  for (let v = 0; v < V; v++) {
    const a = csrOff[v];
    const deg = csrOff[v + 1] - a;
    if (deg === 0) continue;

    const cv = descent[v];
    for (let i = 0; i < deg; i++) {
      const e = a + i;
      const to = edgeTo[e];
      // Strictly descending towards an exit, so no set of used arcs can form a cycle. §6.2
      // does not ask for it, and on 200 m synthetic edges it changes nothing -- the backward
      // option costs 2*ttSec more and the logit kills it anyway. On real geometry, where the
      // median edge is 92 m and the tenth percentile is 30 m, the backward option costs 7 s
      // more, keeps a third of the share, and both directions of one street get told to
      // drive. That deadlocks the network for good.
      //
      // Descent is measured on ONE potential -- whichever is in force -- and that is what
      // keeps the blend below acyclic. Mixing the shares of a free-flow field and an observed
      // field would not be: the two disagree about direction the moment a jam reverses a
      // preference, and flow would go on A->B and B->A at once.
      //
      // The potential in force is the observed one whenever anybody can see the traffic.
      // Measuring it on free-flow cost instead leaves the informed share nothing to be
      // informed about: on Mercer Island 1065 of 1210 nodes then have exactly one permitted
      // direction, and reroutes the observed cost rates as better -- 991 s against 1003 s at
      // node 837 -- are refused because they are 20 s longer at free flow.
      const cTo = descent[to];
      const usable = !blocked[e] && cTo !== Number.POSITIVE_INFINITY && cTo < cv;
      uFree[i] = usable ? edgeCostFree[e] + cost[to] : Number.POSITIVE_INFINITY;
      if (useObs) uObs[i] = usable ? obsCost[e] + costObs[to] : Number.POSITIVE_INFINITY;
    }

    if (logit(uFree, wFree, deg, theta) === 0) continue;
    // A node whose observed prices all came back infinite is routed as if nobody could see
    // the traffic, rather than as NaN.
    const mix = useObs && logit(uObs, wObs, deg, theta) === 1 ? informed : 0;

    // Zeroing tiny shares is not cosmetic: under the FIFO rule of §7.4 any non-zero share
    // pointed at a jammed edge stalls the whole node, and the logit hands out 1e-6 shares
    // to hopeless directions. Without this the informed share deadlocks the network.
    let kept = 0;
    for (let i = 0; i < deg; i++) {
      const share = mix === 0 ? wFree[i] : (1 - mix) * wFree[i] + mix * wObs[i];
      wFree[i] = share < splitEpsilon ? 0 : share;
      kept += wFree[i];
    }
    if (kept <= EPS) continue;

    let bestShare = 0;
    for (let i = 0; i < deg; i++) {
      const share = wFree[i] / kept;
      split[a + i] = share;
      if (share > bestShare) {
        bestShare = share;
        next[v] = a + i;
      }
    }
  }

  return field;
}
