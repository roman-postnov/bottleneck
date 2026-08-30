// Every type declared by CONTRACTS.md §5-§12, in one place.
// The contract was written in TypeScript from the start; these declarations are that text,
// compiled. If a module needs a shape that is not here, the contract is silent on it.

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type NodeIdx = number;

/** Dense runtime index into the per-edge arrays. Shifts when roads are added. */
export type EdgeIdx = number;

/**
 * Stable identity of an edge outside the runtime: scenarios, permalinks, UI (§9.2).
 * Branded because it is a number that looks exactly like an EdgeIdx and corrupts a
 * scenario silently when the two are mixed -- added roads live at >= 1e9.
 */
export type EdgeId = Brand<number, 'EdgeId'>;

export const asEdgeId = (n: number): EdgeId => n as EdgeId;

export const ADDED_EDGE_ID_BASE = 1_000_000_000;

export type LatLng = [lat: number, lon: number];

/** The <city>.json that sits next to the binary and is read before it (§4). */
export type CityMeta = {
  id: string;
  name: string;
  blurb?: string;
  center: LatLng;
  zoom: number;
  bytes?: number;
  nodes?: number;
  edges?: number;
  population?: number;
  carlessPeople?: number;
  exits?: number;
  zones?: string[];
  unassignedPop?: number;
  smallCity?: boolean;
  notes?: string;
};

/**
 * The loaded graph (§5). Every typed array over a section is a view on the source
 * ArrayBuffer -- no copy. The derived arrays are built once, in O(V+E).
 */
export type City = {
  meta: CityMeta | Record<string, never>;
  version: number;
  bbox: [minLat: number, minLon: number, maxLat: number, maxLon: number];
  V: number;
  E: number;
  S: number;
  X: number;
  G: number;
  NS: number;
  /** Buildings. 0 when the file predates the section (§3.1). */
  B: number;

  lat: Int32Array;
  lon: Int32Array;
  geomOff: Uint32Array;
  geomPts: Int16Array;
  /** [V+1] CSR over buildings by owning node, the shape of geomOff. */
  bldOff: Uint32Array;
  /** [B*2] building centroid as a delta from its owning node, in GEOM_SCALE units. */
  bldPts: Int16Array;

  csrOff: Uint32Array;
  edgeTo: Uint32Array;
  edgeFrom: Uint32Array;
  twin: Uint32Array;

  inOff: Uint32Array;
  inEdge: Uint32Array;

  lenM: Uint16Array;
  lanes: Uint8Array;
  speedKmh: Uint8Array;
  flags: Uint8Array;

  srcNode: Uint32Array;
  srcPop: Float32Array;
  srcNoCar: Float32Array;
  srcZone: Uint8Array;
  exitNode: Uint32Array;
  isExit: Uint8Array;

  nameId: Uint16Array;
  nameBlob: Uint8Array;
  nameStarts: number[];

  maxOutDeg: number;
  maxInDeg: number;

  nameOf(e: EdgeIdx): string;
};

/** The routing field (§6.1): split shares per out-edge, seconds to safety per node. */
export type Field = {
  split: Float32Array;
  /**
   * Free-flow seconds to the nearest exit. This is the potential the used arcs descend, and
   * it is what makes the blended field of §6.2 acyclic: it changes only when an edit changes
   * the network, never with congestion.
   */
  cost: Float32Array;
  /** The same, priced at observed cost. Untouched while `informed` is 0. */
  costObs: Float32Array;
  next: Int32Array;
};

/** Scenario parameters resolved against the defaults of §2, flat and numeric. */
export type Params = {
  seed: number;

  occupancy: number;
  participation: number;
  mobilizationHalfMin: number;
  staging: ReadonlyArray<{ zone: number; releaseAtMin: number }> | null;

  satFlowPerLane: number;
  jamSpacingM: number;
  speedFactor: number;
  srcInjectLanes: number;

  /** Exit nodes from the scenario; null means "use the ones in city.bin". */
  exits: number[] | null;

  /** Share of flow routing on observed travel times rather than free-flow ones, 0..1 (§6.2). */
  informed: number;
  reoptSec: number;
  logitTheta: number;
  splitEpsilon: number;
  ttSmoothing: number;

  spillbackLoadThreshold: number;
  hazardCheckSec: number;
  busSeats: number;
  horizonSec: number;
};

/** §7.1. n[e] includes ready[e]. Every scratch buffer lives here: tick() allocates nothing. */
export type SimState = {
  city: City;
  params: Params;
  t: number;

  n: Float32Array;
  ready: Float32Array;
  /** Current lane count -- edits compose, so this diverges from city.lanes (§9.3). */
  lanes: Uint8Array;
  cap: Float32Array;
  storage: Float32Array;
  blocked: Uint8Array;
  ttSec: Uint16Array;

  demand: Float32Array;
  supply: Float32Array;
  moveOut: Float32Array;
  inflow: Float32Array;

  ringOff: Uint32Array;
  ringLen: Uint16Array;
  ring: Float32Array;

  demand0: Float32Array;
  waiting: Float32Array;
  queued: Float32Array;
  moveSrc: Float32Array;
  releaseAt: Float32Array;

  ndDemand: Float32Array;
  ndWeight: Float32Array;
  ndOut: Float32Array;
  ndActive: Uint8Array;
  ndSat: Uint8Array;

  /**
   * Cumulative moveOut per edge since the worker last shipped a frame, and cumulative moveSrc
   * per node likewise. The renderer needs both as flows, not levels: it places one dot per
   * vehicle, so it has to know how many left each edge and each driveway, not how many stand
   * there now. Whoever reads them zeroes them; the core only ever adds.
   */
  outAccum: Float32Array;
  depAccum: Float32Array;
  /** Bumped by every rebuildField, so a reader can tell whether `field.split` moved. */
  fieldRev: number;

  field: Field;
  evacuated: number;
  totalVeh: number;
  vehSecInNetwork: number;

  /** Injection rate of the virtual driveway edge, veh/s (§7.4). */
  srcInjectCapVehS: number;
  /** Rayleigh sigma in seconds, derived from mobilizationHalfMin (§7.5). */
  mobilizationSigmaSec: number;
  /** edgeId -> dense index, built at configure time (§9.2). */
  indexOfEdgeId: Map<number, EdgeIdx>;
  /** dense index -> edgeId, the inverse; used when talking to the UI. */
  edgeIdOf: Float64Array;

  /** Exit nodes actually in force: city.exitNode unless the scenario overrides them. */
  exits: Uint32Array;
  /** Free-flow seconds per edge. Constant for a run: neither `lanes` nor `contraflow` moves it. */
  edgeCostFree: Float32Array;
  /** What the informed share believes each edge costs now, smoothed (§6.1 observedCost). */
  edgeCostObs: Float32Array;
  /** Filled from maxflow.ts by whoever runs it; 0 means "not computed". */
  maxFlowVehH: number;

  /** Edits carrying an `atMin`, sorted by it (§9.1). Ties keep their order in the scenario. */
  schedule: HotEdit[];
  /** How far through `schedule` the clock has got. */
  scheduleCursor: number;

  // Run statistics, accumulated as the run goes (§11). -1 = threshold not reached.
  t50Sec: number;
  t90Sec: number;
  t95Sec: number;
  t100Sec: number;
  /** Per-tick evacuated deltas over a five-minute window, for peakOutflowVehH. */
  outflowRing: Float32Array;
  outflowSum: number;
  peakOutflowVehH: number;
  maxSpillbackM: number;
  gridlockEdges: number;
};

/** `atMin` (§9.1) is the minute of model time the edit lands on; absent means "at configure",
 *  before the first tick. It is what lets a closure made mid-run survive into the permalink. */
export type Edit =
  | { op: 'close'; edgeId: number; atMin?: number }
  | { op: 'lanes'; edgeId: number; lanes: number; atMin?: number }
  | { op: 'contraflow'; edgeId: number; atMin?: number }
  | {
      op: 'addRoad';
      id: number;
      from: LatLng;
      to: LatLng;
      lanes: number;
      speedKmh: number;
      bidirectional: boolean;
    };

/** The edits §9.3 applies without a reset -- everything but `addRoad`. */
export type HotEdit = Exclude<Edit, { op: 'addRoad' }>;

/** §9. One JSON describes a run completely; it is also the permalink and the preset. */
export type Scenario = {
  v: 1;
  city: string;
  seed: number;

  demand: {
    occupancy: number;
    participation: number;
    mobilizationHalfMin: number;
    staging?: Array<{ zone: number; releaseAtMin: number }>;
  };

  supply: {
    satFlowPerLane: number;
    jamSpacingM: number;
    speedFactor: number;
    srcInjectLanes: number;
  };

  routing: {
    informed: number;
    reoptSec: number;
    logitTheta: number;
    splitEpsilon: number;
    ttSmoothing: number;
  };

  exits?: number[];

  edits: Edit[];

  hazard?: {
    checkSec: number;
    polygons: Array<{ atMin: number; ring: Array<[number, number]> }>;
  };
};

/** §11. */
export type Metrics = {
  totalVeh: number;
  evacuatedVeh: number;
  t50Sec: number | null;
  t90Sec: number | null;
  t95Sec: number | null;
  t100Sec: number | null;
  peakOutflowVehH: number;
  meanTravelSec: number;
  maxSpillbackM: number;
  gridlockEdges: number;
  stranded: number;
  maxFlowVehH: number;
  efficiency: number;
  carlessPeople: number;
  busRunsNeeded: number;
};

/** What snapshot() fills for the frame message (§7.2, §8.2). */
export type FrameBuffers = {
  n: Float32Array;
};
