// Max-flow and the minimum cut (CONTRACTS.md §12). Computed once per scenario, next to the
// simulation but never inside it: this is the theoretical ceiling the simulation is measured
// against, and the cut is the part that gives an address rather than a number.

import { classOf } from './city.ts';
import { capVehS } from './params.ts';
import type { City, Params } from './types.ts';

// Capacities are whole veh/h (§12): integers make Dinic terminate and make the
// Ford-Fulkerson equality exact, with no epsilon tuned to look good in a demo.
const INF = 1 << 29;

export type MaxFlowResult = {
  valueVehH: number;
  cutEdges: Uint32Array;
  cutSideS: Uint8Array;
  flow: Int32Array;
};

class Network {
  readonly head: Int32Array;
  readonly nxt: Int32Array;
  readonly to: Int32Array;
  readonly cap: Int32Array;
  private m = 0;

  constructor(n: number, maxArcs: number) {
    this.head = new Int32Array(n).fill(-1);
    this.nxt = new Int32Array(2 * maxArcs);
    this.to = new Int32Array(2 * maxArcs);
    this.cap = new Int32Array(2 * maxArcs);
  }

  add(u: number, v: number, c: number): number {
    const a = this.m;
    this.to[a] = v;
    this.cap[a] = c;
    this.nxt[a] = this.head[u];
    this.head[u] = a;
    this.to[a + 1] = u;
    this.cap[a + 1] = 0;
    this.nxt[a + 1] = this.head[v];
    this.head[v] = a + 1;
    this.m += 2;
    return a;
  }
}

/**
 * `lanes` defaults to the city's own, but an edited run must pass the simulation's: §9.3 lets
 * `lanes` and `contraflow` change the width of a road, and a ceiling computed off the
 * untouched city would sit below the flow the simulation then achieves -- efficiency above
 * one, and sanity check 9 broken by a metric rather than by the physics.
 */
export function maxFlow(
  city: City,
  params: Params,
  blocked: Uint8Array,
  lanes: Uint8Array = city.lanes,
): MaxFlowResult {
  const { V, E } = city;
  const SRC = V;
  const SNK = V + 1;
  const N = V + 2;

  const net = new Network(N, E + city.S + city.X);
  const arcOf = new Int32Array(E).fill(-1);
  const capVehH = new Int32Array(E);

  for (let e = 0; e < E; e++) {
    // Exits absorb: their out-edges are left out of the network, or flow would leave town
    // and come back in, inflating the answer (REVIEW B2).
    if (city.isExit[city.edgeFrom[e]]) continue;
    const c = blocked[e]
      ? 0
      : Math.round(capVehS(lanes[e], classOf(city.flags[e]), params.satFlowPerLane) * 3600);
    capVehH[e] = c;
    arcOf[e] = net.add(city.edgeFrom[e], city.edgeTo[e], c);
  }

  // Source arcs carry +inf, not the population: capacity equal to the population mixes a
  // stock with a rate and drags the min cut into residential blocks (REVIEW B1).
  for (let i = 0; i < city.S; i++) net.add(SRC, city.srcNode[i], INF);
  for (let i = 0; i < city.X; i++) net.add(city.exitNode[i], SNK, INF);

  const { head, nxt, to, cap } = net;
  const level = new Int32Array(N);
  const iter = new Int32Array(N);
  const queue = new Int32Array(N);
  const path = new Int32Array(N + 1);

  const bfs = (): boolean => {
    level.fill(-1);
    level[SRC] = 0;
    let qh = 0;
    let qt = 0;
    queue[qt++] = SRC;
    while (qh < qt) {
      const u = queue[qh++];
      for (let a = head[u]; a !== -1; a = nxt[a]) {
        const v = to[a];
        if (cap[a] > 0 && level[v] < 0) {
          level[v] = level[u] + 1;
          queue[qt++] = v;
        }
      }
    }
    return level[SNK] >= 0;
  };

  // Iterative blocking flow: the level graph can be thousands of nodes deep on a road
  // network, which is more recursion than a JS stack is willing to give.
  const augment = (): number => {
    let u = SRC;
    let len = 0;
    for (;;) {
      if (u === SNK) {
        let f = INF;
        for (let i = 0; i < len; i++) if (cap[path[i]] < f) f = cap[path[i]];
        for (let i = 0; i < len; i++) {
          cap[path[i]] -= f;
          cap[path[i] ^ 1] += f;
        }
        let k = 0;
        while (k < len && cap[path[k]] > 0) k++;
        u = to[path[k] ^ 1];
        return f;
      }

      let advanced = false;
      for (; iter[u] !== -1; iter[u] = nxt[iter[u]]) {
        const a = iter[u];
        if (cap[a] > 0 && level[to[a]] === level[u] + 1) {
          path[len++] = a;
          u = to[a];
          advanced = true;
          break;
        }
      }
      if (advanced) continue;

      level[u] = -1;
      if (len === 0) return 0;
      len--;
      u = to[path[len] ^ 1];
      iter[u] = nxt[iter[u]];
    }
  };

  let value = 0;
  while (bfs()) {
    for (let v = 0; v < N; v++) iter[v] = head[v];
    for (;;) {
      const f = augment();
      if (f === 0) break;
      value += f;
    }
  }

  // The cut: reachable in the residual network from the source.
  const cutSideS = new Uint8Array(V);
  const seen = new Uint8Array(N);
  seen[SRC] = 1;
  let qh = 0;
  let qt = 0;
  queue[qt++] = SRC;
  while (qh < qt) {
    const u = queue[qh++];
    for (let a = head[u]; a !== -1; a = nxt[a]) {
      const v = to[a];
      if (cap[a] > 0 && !seen[v]) {
        seen[v] = 1;
        queue[qt++] = v;
      }
    }
  }
  for (let v = 0; v < V; v++) cutSideS[v] = seen[v];

  const flow = new Int32Array(E);
  const cut: number[] = [];
  for (let e = 0; e < E; e++) {
    const a = arcOf[e];
    if (a < 0) continue;
    flow[e] = capVehH[e] - cap[a];
    if (capVehH[e] > 0 && seen[city.edgeFrom[e]] && !seen[city.edgeTo[e]]) cut.push(e);
  }

  return { valueVehH: value, cutEdges: Uint32Array.from(cut), cutSideS, flow };
}
