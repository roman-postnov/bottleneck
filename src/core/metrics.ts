// Run statistics and the metric block of CONTRACTS.md §11.

import type { Metrics, SimState } from './types.ts';

const OUTFLOW_WINDOW_SEC = 300; // §11: peak outflow is a five-minute moving window
const GRIDLOCK_LOAD = 0.95;

type Dsu = { parent: Int32Array; len: Float64Array };
const dsuOf = new WeakMap<SimState, Dsu>();

/** Called once per tick, right after the state has moved. */
export function recordTickStats(s: SimState, evacuatedThisTick: number): void {
  const slot = s.t % OUTFLOW_WINDOW_SEC;
  s.outflowSum += evacuatedThisTick - s.outflowRing[slot];
  s.outflowRing[slot] = evacuatedThisTick;
  const vehH = (s.outflowSum / OUTFLOW_WINDOW_SEC) * 3600;
  if (vehH > s.peakOutflowVehH) s.peakOutflowVehH = vehH;

  if (s.totalVeh <= 0) return;
  const done = s.evacuated / s.totalVeh;
  if (s.t50Sec < 0 && done >= 0.5) s.t50Sec = s.t;
  if (s.t90Sec < 0 && done >= 0.9) s.t90Sec = s.t;
  if (s.t95Sec < 0 && done >= 0.95) s.t95Sec = s.t;
  if (s.t100Sec < 0 && done >= 1 - 1e-6) s.t100Sec = s.t;
}

/**
 * Called once per rendered frame, not once per tick: §11 defines maxSpillbackM over frames,
 * and a connected-components pass over every edge is too much to run 600 times a second.
 */
export function updateFrameStats(s: SimState): void {
  const { city } = s;
  const E = city.E;
  const thr = s.params.spillbackLoadThreshold;

  let dsu = dsuOf.get(s);
  if (!dsu) {
    dsu = { parent: new Int32Array(city.V), len: new Float64Array(city.V) };
    dsuOf.set(s, dsu);
  }
  const { parent, len } = dsu;
  for (let v = 0; v < city.V; v++) {
    parent[v] = v;
    len[v] = 0;
  }

  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const nxt = parent[x];
      parent[x] = r;
      x = nxt;
    }
    return r;
  };

  let gridlock = 0;
  for (let e = 0; e < E; e++) {
    const load = s.n[e] / s.storage[e];
    if (load > GRIDLOCK_LOAD) gridlock++;
    if (load <= thr) continue;
    const a = find(city.edgeFrom[e]);
    const b = find(city.edgeTo[e]);
    if (a !== b) parent[b] = a;
  }
  if (gridlock > s.gridlockEdges) s.gridlockEdges = gridlock;

  let longest = 0;
  for (let e = 0; e < E; e++) {
    if (s.n[e] / s.storage[e] <= thr) continue;
    const r = find(city.edgeFrom[e]);
    len[r] += city.lenM[e];
    if (len[r] > longest) longest = len[r];
  }
  if (longest > s.maxSpillbackM) s.maxSpillbackM = longest;
}

export function metrics(s: SimState): Metrics {
  const stranded = Math.max(0, s.totalVeh - s.evacuated);
  let carless = 0;
  for (let i = 0; i < s.city.S; i++) carless += s.city.srcNoCar[i];

  return {
    totalVeh: s.totalVeh,
    evacuatedVeh: s.evacuated,
    t50Sec: s.t50Sec < 0 ? null : s.t50Sec,
    t90Sec: s.t90Sec < 0 ? null : s.t90Sec,
    t95Sec: s.t95Sec < 0 ? null : s.t95Sec,
    t100Sec: s.t100Sec < 0 ? null : s.t100Sec,
    peakOutflowVehH: s.peakOutflowVehH,
    meanTravelSec: s.evacuated > 0 ? s.vehSecInNetwork / s.evacuated : 0,
    maxSpillbackM: s.maxSpillbackM,
    gridlockEdges: s.gridlockEdges,
    stranded,
    maxFlowVehH: s.maxFlowVehH,
    efficiency: s.maxFlowVehH > 0 ? s.peakOutflowVehH / s.maxFlowVehH : 0,
    carlessPeople: carless,
    busRunsNeeded: Math.ceil(carless / s.params.busSeats),
  };
}
