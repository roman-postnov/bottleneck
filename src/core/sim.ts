// The simulation core (CONTRACTS.md §7). The public API here is exactly §7.2;
// the node model, the departure curve and the statistics live in their own files.

import { classOf, NO_TWIN } from './city.ts';
import { recordTickStats } from './metrics.ts';
import { mobilize, rayleighSigmaSec } from './mobilization.ts';
import { nodeTransfer } from './nodeModel.ts';
import { capVehS, storageVeh } from './params.ts';
import { buildField, observedCost } from './routing.ts';
import type { City, Edit, FrameBuffers, HotEdit, Params, SimState } from './types.ts';

// biome-ignore lint/performance/noBarrelFile: §16.6 -- the module's declared API is re-exported from its contract file, so the split stays invisible from outside
export { metrics, updateFrameStats } from './metrics.ts';

const OUTFLOW_WINDOW_SEC = 300;
const MAX_TT_SEC = 65535; // ttSec is a Uint16 in SimState, and ringLen must equal it

export function createSim(city: City, params: Params, edits: Edit[] = []): SimState {
  const { V, E } = city;

  const cap = new Float32Array(E);
  const storage = new Float32Array(E);
  const ttSec = new Uint16Array(E);
  const ringOff = new Uint32Array(E + 1);

  for (let e = 0; e < E; e++) {
    cap[e] = capVehS(city.lanes[e], classOf(city.flags[e]), params.satFlowPerLane);
    storage[e] = storageVeh(city.lenM[e], city.lanes[e], params.jamSpacingM);
    const speedKmh = Math.max(1, city.speedKmh[e] * params.speedFactor);
    const tt = Math.max(1, Math.round(city.lenM[e] / ((speedKmh * 1000) / 3600)));
    ttSec[e] = Math.min(MAX_TT_SEC, tt);
    ringOff[e + 1] = ringOff[e] + ttSec[e];
  }

  const demand0 = new Float32Array(V);
  const waiting = new Float32Array(V);
  const releaseAt = new Float32Array(V);
  const vehPerPerson = params.participation / params.occupancy;
  let totalVeh = 0;
  for (let i = 0; i < city.S; i++) {
    const veh = city.srcPop[i] * vehPerPerson;
    demand0[city.srcNode[i]] += veh;
    totalVeh += veh;
    if (params.staging) {
      const zone = city.srcZone[i];
      const rule = params.staging.find((r) => r.zone === zone);
      if (rule) releaseAt[city.srcNode[i]] = rule.releaseAtMin * 60;
    }
  }
  waiting.set(demand0);

  const exits = params.exits && params.exits.length > 0 ? Uint32Array.from(params.exits) : city.exitNode;

  // Two arrays, not one. The free-flow price is the potential the routing field descends and
  // it must survive the whole run: reactive reoptimisation smooths its own array towards the
  // observed cost, and a single array would leave nothing to route the uninformed share by.
  const edgeCostFree = new Float32Array(E);
  for (let e = 0; e < E; e++) edgeCostFree[e] = ttSec[e];
  const edgeCostObs = Float32Array.from(edgeCostFree);

  const blocked = new Uint8Array(E);
  const nd = city.maxInDeg + 1;

  const edgeIdOf = new Float64Array(E);
  const indexOfEdgeId = new Map<number, number>();
  for (let e = 0; e < E; e++) {
    edgeIdOf[e] = e;
    indexOfEdgeId.set(e, e);
  }

  const s: SimState = {
    city,
    params,
    t: 0,

    n: new Float32Array(E),
    ready: new Float32Array(E),
    lanes: Uint8Array.from(city.lanes),
    cap,
    storage,
    blocked,
    ttSec,

    demand: new Float32Array(E),
    supply: new Float32Array(E),
    moveOut: new Float32Array(E),
    inflow: new Float32Array(E),

    ringOff,
    ringLen: ttSec, // §7.3: the ring is exactly as long as the travel time, never longer
    ring: new Float32Array(ringOff[E]),

    demand0,
    waiting,
    queued: new Float32Array(V),
    moveSrc: new Float32Array(V),
    releaseAt,

    ndDemand: new Float32Array(nd),
    ndWeight: new Float32Array(nd),
    ndOut: new Float32Array(nd),
    ndActive: new Uint8Array(nd),
    ndSat: new Uint8Array(nd),

    outAccum: new Float32Array(E),
    depAccum: new Float32Array(V),
    fieldRev: 0,

    field: buildField(city, exits, edgeCostFree, blocked, params.logitTheta, {
      splitEpsilon: params.splitEpsilon,
      informed: params.informed,
      edgeCostObs,
    }),
    evacuated: 0,
    totalVeh,
    vehSecInNetwork: 0,

    srcInjectCapVehS: (params.srcInjectLanes * params.satFlowPerLane) / 3600,
    mobilizationSigmaSec: rayleighSigmaSec(params.mobilizationHalfMin),
    indexOfEdgeId,
    edgeIdOf,

    exits,
    edgeCostFree,
    edgeCostObs,
    maxFlowVehH: 0,

    t50Sec: -1,
    t90Sec: -1,
    t95Sec: -1,
    t100Sec: -1,
    outflowRing: new Float32Array(OUTFLOW_WINDOW_SEC),
    outflowSum: 0,
    peakOutflowVehH: 0,
    maxSpillbackM: 0,
    gridlockEdges: 0,

    schedule: [],
    scheduleCursor: 0,
  };

  const now: HotEdit[] = [];
  for (const edit of edits) {
    if (edit.op === 'addRoad') {
      throw new Error('addRoad changes the topology and requires a full reset (§9.3)');
    }
    if (edit.atMin === undefined) now.push(edit);
    else s.schedule.push(edit);
  }
  // Array.prototype.sort is stable, so two edits on the same minute keep their scenario
  // order. §9.1 requires it: applied the other way round they leave a different `cap`.
  s.schedule.sort((a, b) => (a.atMin ?? 0) - (b.atMin ?? 0));
  if (now.length > 0) applyEdits(s, now);

  return s;
}

/**
 * §9.3. Applies everything the clock has reached. Lives in the core, not in the worker that
 * owns the clock: every run in Node -- the sanity checks and the whole of the validation --
 * goes nowhere near the worker, and a schedule hidden there would mean the test and the
 * browser simulate different cities.
 *
 * Returns true if anything fired, which is when the max-flow ceiling has to be recomputed.
 */
export function applyDueEdits(s: SimState): boolean {
  const due: HotEdit[] = [];
  while (s.scheduleCursor < s.schedule.length) {
    const edit = s.schedule[s.scheduleCursor];
    if ((edit.atMin ?? 0) * 60 > s.t) break;
    due.push(edit);
    s.scheduleCursor++;
  }
  if (due.length === 0) return false;
  applyEdits(s, due);
  return true;
}

function rebuildField(s: SimState): void {
  buildField(s.city, s.exits, s.edgeCostFree, s.blocked, s.params.logitTheta, {
    out: s.field,
    splitEpsilon: s.params.splitEpsilon,
    informed: s.params.informed,
    edgeCostObs: s.edgeCostObs,
  });
  s.fieldRev += 1;
}

function reoptimize(s: SimState): void {
  observedCost(s, s.edgeCostObs, s.params.ttSmoothing, s.edgeCostObs);
  rebuildField(s);
}

/** Exactly one simulated second. Allocates nothing. */
export function tick(s: SimState): void {
  const { city, params } = s;
  const E = city.E;
  const V = city.V;

  // Before phase 1, so the whole tick is computed on the network the edit leaves behind.
  applyDueEdits(s);

  if (params.informed > 0 && s.t > 0 && s.t % params.reoptSec === 0) {
    reoptimize(s);
  }

  // 1 MOBILIZE -- also clears moveSrc for this tick
  mobilize(s);

  // 2 MATURE
  for (let e = 0; e < E; e++) {
    const slot = s.ringOff[e] + (s.t % s.ringLen[e]);
    s.ready[e] += s.ring[slot];
    s.ring[slot] = 0;
  }

  // 3 DEMAND and 4 SUPPLY, clearing the per-tick scratch in the same pass
  for (let e = 0; e < E; e++) {
    s.moveOut[e] = 0;
    s.inflow[e] = 0;
    if (s.blocked[e]) {
      s.demand[e] = 0;
      s.supply[e] = 0;
      continue;
    }
    const c = s.cap[e];
    const ready = s.ready[e];
    s.demand[e] = ready < c ? ready : c;
    // A lanes edit can push n above storage (§9.3); supply is then zero until it drains.
    const room = s.storage[e] - s.n[e];
    s.supply[e] = room <= 0 ? 0 : room < c ? room : c;
  }

  // 5 NODES -- reads the state as of the start of the tick, writes only scratch
  const evacBefore = s.evacuated;
  for (let v = 0; v < V; v++) nodeTransfer(s, v);

  // 6 MOVE
  for (let e = 0; e < E; e++) {
    const f = s.moveOut[e];
    if (f === 0) continue;
    s.n[e] -= f;
    s.ready[e] -= f;
    s.outAccum[e] += f;
  }
  for (let v = 0; v < V; v++) {
    const f = s.moveSrc[v];
    if (f !== 0) {
      s.queued[v] -= f;
      // At an exit node moveSrc is not a departure from a driveway but the evacuated flow
      // (nodeModel phase 5), and counting it here would spawn dots at the city limit.
      if (!city.isExit[v]) s.depAccum[v] += f;
    }
  }

  // 6 (arrival) and 8 ACCOUNT
  let inNetwork = 0;
  for (let e = 0; e < E; e++) {
    const f = s.inflow[e];
    if (f !== 0) {
      s.n[e] += f;
      // ringLen === ttSec, so this is the slot phase 2 emptied this very tick; a ring with
      // slack silently breaks maturation instead of failing loudly (§7.3).
      s.ring[s.ringOff[e] + ((s.t + s.ttSec[e]) % s.ringLen[e])] += f;
    }
    inNetwork += s.n[e];
  }
  s.vehSecInNetwork += inNetwork;
  s.t += 1;

  recordTickStats(s, s.evacuated - evacBefore);
}

/** Hot edits (§9.3): no reset, no vehicles removed from the network. */
export function applyEdits(s: SimState, edits: Edit[]): void {
  for (const edit of edits) {
    if (edit.op === 'addRoad') {
      throw new Error('addRoad changes the topology and requires a full reset (§9.3)');
    }
    const e = s.indexOfEdgeId.get(edit.edgeId);
    if (e === undefined) throw new Error(`unknown edgeId ${edit.edgeId}`);

    switch (edit.op) {
      case 'close':
        s.blocked[e] = 1;
        s.cap[e] = 0;
        break;
      case 'lanes':
        setLanes(s, e, edit.lanes);
        break;
      case 'contraflow': {
        const twin = s.city.twin[e];
        if (twin === NO_TWIN) continue; // §9.3: ignored, the UI warns
        setLanes(s, e, s.lanes[e] + s.lanes[twin]);
        setLanes(s, twin, 0);
        s.blocked[twin] = 1;
        s.cap[twin] = 0;
        break;
      }
      default:
        throw new Error(`unknown edit op ${JSON.stringify(edit)}`);
    }
  }
  rebuildField(s);
}

function setLanes(s: SimState, e: number, lanes: number): void {
  // A non-zero lane count reopens the edge (§9.3). Without it a closed road could never be
  // opened again, and the Camp Fire timeline has Clark Road reopening at 13:00.
  if (lanes > 0) {
    s.blocked[e] = 0;
  }
  s.lanes[e] = lanes;
  s.cap[e] = capVehS(lanes, classOf(s.city.flags[e]), s.params.satFlowPerLane);
  s.storage[e] = storageVeh(s.city.lenM[e], lanes, s.params.jamSpacingM);
}

export function snapshot(s: SimState, out: FrameBuffers): void {
  out.n.set(s.n);
}
