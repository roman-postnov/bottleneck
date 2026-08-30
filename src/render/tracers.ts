// One dot per vehicle (CONTRACTS.md §13.2). A dot is a car: it is born in a driveway, takes a
// route through the graph by the split shares of the routing field, and leaves the city.
//
// No deck.gl here on purpose. The layers live in layers.ts and this file is pure functions over
// typed arrays, so the whole state machine runs under vitest in Node.
//
// The renderer still imports nothing from src/core (§15): the graph arrives in the ready
// message as data.

export const PARKED = 0;
export const MOVING = 1;
export const ARRIVED = 2;
export const STUCK = 3;

/**
 * Hops recorded per car, as a PREFIX -- not a ring. The encoding is a CSR offset, which is
 * relative to the node the car was standing at, so a route replays only from a known start:
 * drop the beginning and the chain cannot be walked at all. 192 hops at San Francisco's mean
 * edge of 94 m is about 18 km, longer than any route in these cities, so the prefix is the
 * whole route in practice. A car that outruns it keeps its first 18 km and stops recording.
 */
const MAX_HOPS = 192;
const ROUTE_BYTES = MAX_HOPS >> 1;

/**
 * At x600 a frame covers ~10 simulated seconds and San Francisco's mean ttSec is 10 s, so a
 * dot crosses about one edge per frame -- but the tenth percentile is 2 s, so short links want
 * several. Without a ceiling a one-metre edge spins here forever; a clamped dot lags one frame
 * and catches up.
 */
const MAX_HOPS_PER_FRAME = 8;

/**
 * Where a parked car stands. Demand lives on NODES, and a node is a junction, so a car parked
 * at its node stands in the middle of a crossroads. The city file carries OSM building
 * centroids per node (§3.2), and that is the first choice: a car waits at a house.
 *
 * The offset off the centroid is not a driveway -- we have centroids, not outlines, and do not
 * know which side the street is on. It is there so several cars at one house do not land on
 * the same pixel.
 */
const YARD_HOUSE_MIN_M = 3;
const YARD_HOUSE_SPAN_M = 5;

/**
 * How many cars one mapped building may hold before the rest go back to the street.
 *
 * OSM coverage is not uniform and the gap is not small: San Francisco has a building for
 * every 5 residents, Paradise one for every 24 -- four fifths of its demand sits at nodes with
 * no building drawn at all. Piling forty cars onto the one house that happens to be mapped
 * says people live there, which is false; the street they are on is the weaker claim and the
 * true one. Four is already more than a household owns.
 */
const YARD_CARS_PER_HOUSE = 4;

/**
 * Fallback for a node with no building within §4's radius, and for every city whose file
 * predates the building section. Cars go down the near half of each incident edge, spaced out,
 * sat off the carriageway the way a driveway is.
 */
const YARD_SPAN_M = 130;
const YARD_LATERAL_MIN_M = 5;
const YARD_LATERAL_SPAN_M = 7;
/** Fallback only, for a node with no outgoing edge to line the cars up along. */
const YARD_RADIUS_M = 30;

export type TracerInit = {
  E: number;
  V: number;
  totalVeh: number;
  seed: number;
  csrOff: Uint32Array;
  edgeTo: Uint32Array;
  isExit: Uint8Array;
  ttSec: Uint16Array;
  split: Float32Array;
  demand0: Float32Array;
  demandNodes: Uint32Array;
  nodeXY: Float32Array;
  maxOutDeg: number;
  /** [V+1] CSR over building centroids. All zeros when the city has none. */
  bldOff: Uint32Array;
  /** [B*2] metre offsets, same origin as nodeXY. */
  bldXY: Float32Array;
  storage: Float32Array;
  /** [E+1] from the graph view. */
  startIndices: Uint32Array;
  /** [vertexCount*2] metre offsets, same origin as nodeXY. */
  vertsM: Float32Array;
  /** [vertexCount] cumulative metres along each edge's polyline. */
  cum: Float32Array;
  /** [E] */
  edgeLen: Float32Array;
};

/** The `{length, attributes}` shape a deck.gl ScatterplotLayer takes. No deck.gl import. */
export type BinaryPoints = {
  length: number;
  attributes: { getPosition: { value: Float32Array; size: number } };
};

export type TracerField = {
  cap: number;
  E: number;
  V: number;
  /** False when maxOutDeg > 16 and the 4-bit route encoding cannot hold a decision. */
  routesEnabled: boolean;

  csrOff: Uint32Array;
  edgeTo: Uint32Array;
  isExit: Uint8Array;
  nodeXY: Float32Array;
  bldOff: Uint32Array;
  bldXY: Float32Array;
  startIndices: Uint32Array;
  vertsM: Float32Array;
  cum: Float32Array;
  edgeLen: Float32Array;

  ttSec: Uint16Array;
  storage: Float32Array;
  blocked: Uint8Array;
  split: Float32Array;
  /** [E] the newest frame's vehicle count. Owned by the caller, read here. */
  n: Float32Array;
  invTt: Float32Array;
  invStorage: Float32Array;
  /** [E] cumulative moveOut, accumulated from the per-frame deltas. Float64: the sum reaches
   *  ~1e5 on an exit edge, where a Float32 step is already 0.008 of a vehicle. */
  servedCum: Float64Array;
  /**
   * [E] the FIFO number the next car onto this edge gets. Reset every frame to the model's own
   * cumulative arrivals as of the previous frame, then incremented per entry, so the cars that
   * arrive during a frame take the numbers the model's arrivals took.
   *
   * A per-pass counter added on top of n[e] does NOT work, and this is what it costs: n[e]
   * already counts the cars that arrived during the frame, so adding a sequence number on top
   * charges the fifth car onto an edge four extra vehicles of delay. Measured: 16% more dots on
   * the network than the model had cars.
   */
  arrCum: Float64Array;
  /** [E] live count, against which n[e] is checked -- the self-test of the whole scheme. */
  dotsOn: Int32Array;
  /** [E] axis-aligned bounds in metre offsets, for the viewport cull. */
  edgeBbox: Float32Array;

  dEdge: Uint32Array;
  dState: Uint8Array;
  dNode: Uint32Array;
  dEnterT: Float64Array;
  dAhead: Float64Array;
  dParam: Float32Array;
  dVtx: Uint32Array;
  dRng: Uint32Array;
  dKey: Uint32Array;
  dSpawnT: Float32Array;
  dArriveT: Float32Array;
  dHops: Uint16Array;
  route: Uint8Array;

  /**
   * Yards, as contiguous slot ranges. fillYards hands out slots node by node, so node v owns
   * [yardBegin[v], yardEnd[v]) and departures only ever advance yardNext[v]. That keeps a
   * departure O(1) and keeps the still-parked cars contiguous, so the draw buffer is a handful
   * of memcpys rather than a scatter.
   */
  yardBegin: Uint32Array;
  yardNext: Uint32Array;
  yardEnd: Uint32Array;
  /** [cap*2] where each parked car stands, indexed by SLOT. Never moves. */
  yardPos: Float32Array;
  /** [cap*2] the compacted draw buffer, rebuilt only when a car leaves. */
  parkedPos: Float32Array;
  parkedCount: number;
  parkedRevision: number;
  parkedDirty: boolean;

  moving: Uint32Array;
  movingIdx: Uint32Array;
  movingCount: number;

  arrived: Uint32Array;
  arrivedCount: number;
  /** Stranded cars and where they stopped. They never move again, so this is written once. */
  stuckList: Uint32Array;
  stuckPos: Float32Array;
  stuckCount: number;
  stuckRevision: number;

  /** Per-node spawn ordinal, so a dot's seed comes from the model and not from frame timing. */
  ordinal: Uint32Array;
  /**
   * Cumulative vehicles the model has released from each node's driveway. A running remainder
   * instead of this leaves under a car parked at every node forever -- which is nothing on one
   * node and 9233 nodes' worth on San Francisco, so a percent of the fleet would never leave.
   */
  depCum: Float64Array;
  /**
   * A fixed per-node offset in [0, 1), so a node owing 0.4 of a departure releases a car four
   * times in ten rather than never. Rounding per node instead loses everything below half a car
   * at every node at once: nine minutes into Mercer Island the model has released 42 cars
   * across 1033 driveways, and rounding showed none of them moving at all.
   */
  dither: Float32Array;
  /** [V] the demand the yards were built from, to flush a node the model has emptied. */
  demand0: Float32Array;
  demandNodes: Uint32Array;

  /** Compacted output for the moving layer, and the map back to slots for picking. */
  pos: Float32Array;
  slotOf: Uint32Array;
  count: number;

  /** Cars that had no usable out-edge to start on. They are metrics.stranded, undrawable. */
  droppedAtOrigin: number;
  spawned: number;
};

function splitmix32(a: number): number {
  // Copied from src/core/rng.ts rather than imported: §15 forbids src/render from importing
  // src/core, and test/boundaries.test.ts enforces it by reading the source text.
  // test/tracers.test.ts pins the two streams together so the copy cannot drift.
  a = (a + 0x9e3779b9) | 0;
  let t = a ^ (a >>> 16);
  t = Math.imul(t, 0x21f0aaad);
  t = t ^ (t >>> 15);
  t = Math.imul(t, 0x735a2d97);
  return (t = t ^ (t >>> 15)) >>> 0;
}

function nextRandom(f: TracerField, i: number): number {
  let x = f.dRng[i];
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  f.dRng[i] = x;
  return x * 2.3283064365386963e-10;
}

/** Cumulative metres per vertex and total length per edge, over the metre-offset vertices. */
export function cumulative(
  startIndices: Uint32Array,
  vertsM: Float32Array,
  E: number,
): { cum: Float32Array; edgeLen: Float32Array } {
  const cum = new Float32Array(startIndices[E]);
  const edgeLen = new Float32Array(E);
  for (let e = 0; e < E; e++) {
    const a = startIndices[e];
    const b = startIndices[e + 1];
    let acc = 0;
    cum[a] = 0;
    for (let k = a + 1; k < b; k++) {
      const dx = vertsM[k * 2] - vertsM[(k - 1) * 2];
      const dy = vertsM[k * 2 + 1] - vertsM[(k - 1) * 2 + 1];
      acc += Math.sqrt(dx * dx + dy * dy);
      cum[k] = acc;
    }
    edgeLen[e] = acc > 1 ? acc : 1;
  }
  return { cum, edgeLen };
}

/** Lon/lat degrees to metre offsets from `center`, matching buildNodeXY in the worker. */
export function toMeterOffsets(
  positions: Float64Array,
  center: [lat: number, lon: number],
): Float32Array {
  const out = new Float32Array(positions.length);
  const mPerLon = 111320 * Math.cos(center[0] * (Math.PI / 180));
  for (let k = 0; k < positions.length; k += 2) {
    out[k] = (positions[k] - center[1]) * mPerLon;
    out[k + 1] = (positions[k + 1] - center[0]) * 110540;
  }
  return out;
}

function reciprocals(f: TracerField): void {
  for (let e = 0; e < f.E; e++) {
    f.invTt[e] = 1 / (f.ttSec[e] > 0 ? f.ttSec[e] : 1);
    f.invStorage[e] = 1 / (f.storage[e] > 0 ? f.storage[e] : 1);
  }
}

export function createTracers(init: TracerInit): TracerField {
  const { E, V } = init;
  // Every car that will ever exist: demand is fixed at configure time and nothing is created
  // mid-run, so a slot is never reused. That is what makes a slot a stable car id and keeps
  // the route of a car that already got out readable to the end of the run.
  const cap = Math.ceil(init.totalVeh) + init.demandNodes.length + 1;

  const f: TracerField = {
    cap,
    E,
    V,
    routesEnabled: init.maxOutDeg <= 16,
    csrOff: init.csrOff,
    edgeTo: init.edgeTo,
    isExit: init.isExit,
    nodeXY: init.nodeXY,
    bldOff: init.bldOff,
    bldXY: init.bldXY,
    startIndices: init.startIndices,
    vertsM: init.vertsM,
    cum: init.cum,
    edgeLen: init.edgeLen,
    ttSec: init.ttSec,
    storage: init.storage,
    blocked: new Uint8Array(E),
    split: init.split,
    n: new Float32Array(E),
    invTt: new Float32Array(E),
    invStorage: new Float32Array(E),
    servedCum: new Float64Array(E),
    arrCum: new Float64Array(E),
    dotsOn: new Int32Array(E),
    edgeBbox: new Float32Array(E * 4),

    dEdge: new Uint32Array(cap),
    dState: new Uint8Array(cap),
    dNode: new Uint32Array(cap),
    dEnterT: new Float64Array(cap),
    dAhead: new Float64Array(cap),
    dParam: new Float32Array(cap),
    dVtx: new Uint32Array(cap),
    dRng: new Uint32Array(cap),
    dKey: new Uint32Array(cap),
    dSpawnT: new Float32Array(cap),
    dArriveT: new Float32Array(cap),
    dHops: new Uint16Array(cap),
    route: new Uint8Array(cap * ROUTE_BYTES),

    yardBegin: new Uint32Array(V),
    yardNext: new Uint32Array(V),
    yardEnd: new Uint32Array(V),
    yardPos: new Float32Array(cap * 2),
    parkedPos: new Float32Array(cap * 2),
    parkedCount: 0,
    parkedRevision: 0,
    parkedDirty: true,

    moving: new Uint32Array(cap),
    movingIdx: new Uint32Array(cap),
    movingCount: 0,

    arrived: new Uint32Array(cap),
    arrivedCount: 0,
    stuckList: new Uint32Array(cap),
    stuckPos: new Float32Array(cap * 2),
    stuckCount: 0,
    stuckRevision: 0,

    ordinal: new Uint32Array(V),
    depCum: new Float64Array(V),
    dither: new Float32Array(V),
    demand0: init.demand0,
    demandNodes: init.demandNodes,

    pos: new Float32Array(cap * 2),
    slotOf: new Uint32Array(cap),
    count: 0,
    droppedAtOrigin: 0,
    spawned: 0,
  };

  reciprocals(f);
  edgeBounds(f);
  fillYards(f, init.demand0, init.seed);
  return f;
}

/**
 * A car with nowhere to go. The model keeps these vehicles where they are to the end of the run
 * and reports them as metrics.stranded, so the dot stops and stays: no teleport, no random road,
 * no quiet disappearance. `e < 0` means it never got out of its own driveway.
 */
function markStuck(f: TracerField, slot: number, e: number): void {
  f.dState[slot] = STUCK;
  const at = f.stuckCount++;
  f.stuckList[at] = slot;
  if (e < 0) {
    f.stuckPos[at * 2] = f.yardPos[slot * 2];
    f.stuckPos[at * 2 + 1] = f.yardPos[slot * 2 + 1];
  } else {
    // At the head of the link it could not leave.
    const last = f.startIndices[e + 1] - 1;
    f.stuckPos[at * 2] = f.vertsM[last * 2];
    f.stuckPos[at * 2 + 1] = f.vertsM[last * 2 + 1];
  }
  f.stuckRevision++;
}

function edgeBounds(f: TracerField): void {
  const { startIndices, vertsM, edgeBbox } = f;
  for (let e = 0; e < f.E; e++) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = startIndices[e]; k < startIndices[e + 1]; k++) {
      const x = vertsM[k * 2];
      const y = vertsM[k * 2 + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    edgeBbox[e * 4] = x0;
    edgeBbox[e * 4 + 1] = y0;
    edgeBbox[e * 4 + 2] = x1;
    edgeBbox[e * 4 + 3] = y1;
  }
}

/**
 * Writes the point `dist` metres along edge `e`, pushed `lateral` metres to one side of the
 * carriageway. Walks the polyline the same way writePositions does; only ever runs at setup.
 */
function alongEdge(
  f: TracerField,
  e: number,
  dist: number,
  lateral: number,
  out: Float32Array,
  at: number,
): void {
  const { startIndices, cum, vertsM } = f;
  const a = startIndices[e];
  const b = startIndices[e + 1];
  let k = a + 1;
  while (k < b - 1 && cum[k] < dist) k++;
  const d0 = cum[k - 1];
  const seg = cum[k] - d0;
  const t = seg > 0 ? (dist - d0) / seg : 0;
  const x0 = vertsM[(k - 1) * 2];
  const y0 = vertsM[(k - 1) * 2 + 1];
  const dx = vertsM[k * 2] - x0;
  const dy = vertsM[k * 2 + 1] - y0;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  out[at] = x0 + dx * t + (-dy / len) * lateral;
  out[at + 1] = y0 + dy * t + (dx / len) * lateral;
}

/** One parked car per vehicle of demand, in its node's driveway, at t = 0. */
function fillYards(f: TracerField, demand0: Float32Array, seed: number): void {
  const { demandNodes, nodeXY, yardPos, dKey, dRng, dEdge, dNode, csrOff, edgeLen } = f;
  const { bldOff, bldXY } = f;
  // The remainder carries between nodes so the total lands on round(totalVeh) instead of
  // drifting by a car per node.
  let carry = 0;
  let slot = 0;
  for (let i = 0; i < demandNodes.length; i++) {
    const v = demandNodes[i];
    const want = demand0[v] + carry;
    let k = Math.round(want);
    if (k < 0) k = 0;
    carry = want - k;
    if (slot + k > f.cap) k = f.cap - slot;
    f.yardBegin[v] = slot;
    f.yardNext[v] = slot;
    const bb = bldOff[v];
    const m = bldOff[v + 1] - bb;
    const atHouses = Math.min(k, m * YARD_CARS_PER_HOUSE);
    const ea = csrOff[v];
    const deg = csrOff[v + 1] - ea;
    // Rows down each street, so k cars over deg streets stand deg abreast and k/deg deep.
    const rows = deg > 0 ? Math.ceil((k - atHouses) / deg) : 0;
    for (let j = 0; j < k; j++, slot++) {
      const key = splitmix32(seed ^ splitmix32(Math.imul(v, 0x9e3779b1) + j));
      dKey[slot] = key;
      dRng[slot] = key === 0 ? 1 : key; // xorshift32 is dead at zero
      dNode[slot] = v;
      dEdge[slot] = 0;
      f.dState[slot] = PARKED;
      f.dArriveT[slot] = -1;
      // Deterministic throughout: §10 keeps Math.random out of the model and there is no reason
      // to let it in here.
      if (j < atHouses) {
        const b = bb + (j % m);
        const ang = (key & 0xffff) * (6.283185307179586 / 65536);
        const rad = YARD_HOUSE_MIN_M + (((key >>> 16) & 0xff) / 256) * YARD_HOUSE_SPAN_M;
        yardPos[slot * 2] = bldXY[b * 2] + Math.cos(ang) * rad;
        yardPos[slot * 2 + 1] = bldXY[b * 2 + 1] + Math.sin(ang) * rad;
        continue;
      }
      if (deg === 0) {
        const ang = (key & 0xffff) * (6.283185307179586 / 65536);
        const rad = YARD_RADIUS_M * Math.sqrt(((key >>> 16) & 0xffff) / 65536);
        yardPos[slot * 2] = nodeXY[v * 2] + Math.cos(ang) * rad;
        yardPos[slot * 2 + 1] = nodeXY[v * 2 + 1] + Math.sin(ang) * rad;
        continue;
      }
      const js = j - atHouses;
      const e = ea + (js % deg);
      // The NEAR HALF only. Each edge is claimed from both ends, and a car allowed the whole
      // length would stand outside somebody else's house.
      const span = Math.min(edgeLen[e] * 0.5, YARD_SPAN_M);
      const row = (js / deg) | 0;
      const jitter = ((key >>> 8) & 0xff) / 256 - 0.5;
      let dist = ((row + 0.5 + jitter * 0.6) / rows) * span;
      if (dist < 1) dist = 1;
      // Both kerbs, so a street reads as houses down each side rather than a single file.
      const side = key & 1 ? 1 : -1;
      const lateral =
        side * (YARD_LATERAL_MIN_M + (((key >>> 16) & 0xff) / 256) * YARD_LATERAL_SPAN_M);
      alongEdge(f, e, dist, lateral, yardPos, slot * 2);
    }
    f.yardEnd[v] = slot;
    f.dither[v] = splitmix32(Math.imul(v, 0x85ebca6b) ^ seed) / 4294967296;
  }
  f.parkedCount = slot;
  f.parkedDirty = true;
}

/**
 * Rebuilds the parked draw buffer from the still-parked tails of every yard. Called at most
 * once a frame, and each yard is one typed-array copy rather than a per-car scatter.
 */
export function writeParked(f: TracerField): number {
  if (!f.parkedDirty) return f.parkedCount;
  const { demandNodes, yardNext, yardEnd, yardPos, parkedPos } = f;
  let out = 0;
  for (let i = 0; i < demandNodes.length; i++) {
    const v = demandNodes[i];
    const a = yardNext[v];
    const b = yardEnd[v];
    if (b <= a) continue;
    parkedPos.set(yardPos.subarray(a * 2, b * 2), out * 2);
    out += b - a;
  }
  f.parkedCount = out;
  f.parkedDirty = false;
  f.parkedRevision++;
  return out;
}

/** Resolves a picked index in the parked buffer back to a slot. Only ever runs on a click. */
export function parkedSlotAt(f: TracerField, index: number): number {
  const { demandNodes, yardNext, yardEnd } = f;
  let seen = 0;
  for (let i = 0; i < demandNodes.length; i++) {
    const v = demandNodes[i];
    const a = yardNext[v];
    const b = yardEnd[v];
    const k = b - a;
    if (index < seen + k) return a + (index - seen);
    seen += k;
  }
  return -1;
}

export function setNetwork(
  f: TracerField,
  storage: Float32Array,
  blocked: Uint8Array,
  ttSec: Uint16Array,
): void {
  f.storage = storage;
  f.blocked = blocked;
  f.ttSec = ttSec;
  reciprocals(f);
}

function addMoving(f: TracerField, slot: number): void {
  const idx = f.movingCount++;
  f.moving[idx] = slot;
  f.movingIdx[slot] = idx;
}

function removeMoving(f: TracerField, slot: number): void {
  const last = --f.movingCount;
  const idx = f.movingIdx[slot];
  const moved = f.moving[last];
  f.moving[idx] = moved;
  f.movingIdx[moved] = idx;
}

/**
 * Picks an out-edge of `v` by the split shares. Returns -1 when the node has none usable,
 * which is a stranded car in the model's own terms (metrics.stranded).
 */
function chooseEdge(f: TracerField, slot: number, v: number): number {
  const a = f.csrOff[v];
  const b = f.csrOff[v + 1];
  if (b <= a) return -1;
  const u = nextRandom(f, slot);
  let acc = 0;
  for (let e = a; e < b; e++) {
    acc += f.split[e];
    if (acc > u) return e;
  }
  // buildField normalises the shares to sum 1 in Float32, so the sum lands on 0.9999994 and a
  // draw above it falls through the loop. Without this the last usable edge would read as a
  // dead end every few thousand hops.
  for (let e = b - 1; e >= a; e--) if (f.split[e] > 0) return e;
  return -1;
}

function enterEdge(f: TracerField, slot: number, e: number, simT: number, atParam: number): void {
  f.dEdge[slot] = e;
  f.dEnterT[slot] = simT;
  // Its arrival number, so it leaves as the departure count reaches it -- after the cars that
  // arrived before it and not after itself. Successive arrivals are a car apart, which both
  // queues them correctly and stops them landing on one pixel.
  f.dAhead[slot] = f.arrCum[e];
  f.arrCum[e] += 1;
  f.dParam[slot] = atParam;
  f.dVtx[slot] = f.startIndices[e];
  f.dotsOn[e] += 1;
}

/** Records which out-edge of `v` was taken, as a 4-bit CSR offset. */
function recordHop(f: TracerField, slot: number, v: number, e: number): void {
  const h = f.dHops[slot];
  if (h < 0xffff) f.dHops[slot] = h + 1;
  if (!f.routesEnabled || h >= MAX_HOPS) return;
  const c = e - f.csrOff[v];
  if (c < 0 || c > 15) return;
  const at = slot * ROUTE_BYTES + (h >> 1);
  // Nibble-aligned so the write is one read-modify-write instead of a splice across a byte
  // boundary. At x600 this runs a few hundred thousand times a frame.
  if (h & 1) f.route[at] = (f.route[at] & 0x0f) | (c << 4);
  else f.route[at] = (f.route[at] & 0xf0) | c;
}

/**
 * Replays the recorded decisions into the edges the car actually took.
 *
 * Pure topology: csrOff and edgeTo never change during a run -- close, lanes and contraflow
 * leave the graph alone and addRoad already forces a full reset (§9.3) -- so this is exact and
 * needs nothing from the field, the loads, or the order the frames happened to arrive in.
 */
export function replayRoute(
  f: TracerField,
  slot: number,
): { edges: Uint32Array; truncated: boolean } {
  const hops = f.dHops[slot];
  if (!f.routesEnabled || hops === 0) return { edges: new Uint32Array(0), truncated: false };
  const kept = hops > MAX_HOPS ? MAX_HOPS : hops;
  const edges = new Uint32Array(kept);
  let v = f.dNode[slot];
  for (let i = 0; i < kept; i++) {
    const at = slot * ROUTE_BYTES + (i >> 1);
    const c = i & 1 ? f.route[at] >> 4 : f.route[at] & 0x0f;
    const e = f.csrOff[v] + c;
    edges[i] = e;
    v = f.edgeTo[e];
  }
  return { edges, truncated: hops > MAX_HOPS };
}

export const ROUTE_MAX_HOPS = MAX_HOPS;

/** Cars that left their driveway this frame come off the yard and onto a road. */
export function onFrame(
  f: TracerField,
  n: Float32Array,
  outflow: Float32Array,
  departed: Float32Array,
  split: Float32Array | undefined,
  simT: number,
): void {
  const { servedCum, arrCum } = f;
  // Anchor first, on the PREVIOUS frame's servedCum and n: their sum is the model's cumulative
  // arrivals as of the last frame, which is exactly the number the next arrival follows.
  for (let e = 0; e < f.E; e++) {
    // Assigned, not raised. A max() here is a ratchet: every dot entry bumps arrCum by one, so
    // any frame where the dots arrive faster than the model leaves the counter permanently
    // high, every later car is charged the drift, and the network fills with dots that cannot
    // leave. Measured that way, the worst edge ran 148 dots over its n[e].
    arrCum[e] = servedCum[e] + f.n[e];
    servedCum[e] += outflow[e];
  }
  f.n.set(n);
  if (split) f.split.set(split);

  const { demandNodes, depCum, dither, demand0, yardBegin, yardNext, yardEnd } = f;
  for (let i = 0; i < demandNodes.length; i++) {
    const v = demandNodes[i];
    const d = departed[v];
    if (d !== 0) depCum[v] += d;
    // Chase the model's own cumulative count rather than accumulating a remainder: the error
    // then stays under a car per node instead of stranding a fraction of one at every node for
    // the rest of the run. Dithered so a fractional debt is paid at the right rate across the
    // city, and flushed outright once the model has released the whole yard -- the dither's own
    // leftover would otherwise keep a car or two parked to the end.
    const want =
      depCum[v] >= demand0[v] - 1e-3
        ? yardEnd[v] - yardBegin[v]
        : Math.floor(depCum[v] + dither[v]);
    for (let have = yardNext[v] - yardBegin[v]; have < want; have++) {
      if (!depart(f, v, simT)) break;
    }
  }
}

/** Takes one parked car at node `v` and puts it on a road. False when there is none left. */
function depart(f: TracerField, v: number, simT: number): boolean {
  const slot = f.yardNext[v];
  if (slot >= f.yardEnd[v]) return false;
  f.yardNext[v] = slot + 1;
  // Decremented here as well as recomputed in writeParked, so the count stays true while the
  // yards are hidden and the readout is not quietly stale.
  f.parkedCount -= 1;
  f.parkedDirty = true;

  const e = chooseEdge(f, slot, v);
  if (e < 0) {
    markStuck(f, slot, -1);
    f.droppedAtOrigin++;
    return true;
  }
  f.dState[slot] = MOVING;
  f.dSpawnT[slot] = simT;
  f.dHops[slot] = 0;
  recordHop(f, slot, v, e);
  enterEdge(f, slot, e, simT, 0);
  addMoving(f, slot);
  f.spawned++;
  return true;
}

/**
 * Newell's cumulative-count solution, evaluated in closed form rather than integrated.
 *
 * A car on edge `e` is at whichever is smaller: how far free-flow has carried it since it
 * entered, or where the back of the queue ahead of it currently stands. That is exactly what
 * §7.3 does -- mature after ttSec, then wait in ready[e] until the node serves you in FIFO
 * order -- so a dot's time on the edge equals the vehicle's, and the dots on an edge come out
 * equal to n[e] with nothing tuned to make it so.
 *
 * Integrating a speed instead would drift against a jittery clock and, worse, would smear the
 * queue over the whole edge: the model holds it vertically at the downstream end, and the
 * standing tail is the thing worth seeing.
 */
export function advance(f: TracerField, simT: number): void {
  const {
    moving,
    dEdge,
    dEnterT,
    dAhead,
    dParam,
    servedCum,
    invTt,
    invStorage,
    blocked,
    n,
    isExit,
    edgeTo,
  } = f;

  // Backwards, so removeMoving's swap of the tail into the current index cannot skip a car.
  for (let k = f.movingCount - 1; k >= 0; k--) {
    const i = moving[k];
    let hops = 0;
    for (;;) {
      const e = dEdge[i];
      const ff = (simT - dEnterT[i]) * invTt[e];
      let q = 1 - (dAhead[i] - servedCum[e]) * invStorage[e];
      // An edge holding nobody cannot be holding this car back. With the -1 above this is
      // almost always already true; it stays as a guard against drift between n and the
      // accumulated servedCum, which would otherwise park dots on an empty road forever.
      if (n[e] < 1 && q < ff) q = ff;
      // A closed road serves nobody, so servedCum stops and the queue branch pins the car by
      // itself -- but only from where it already is. Without this a car mid-link would coast up
      // to the head of a queue that is never going to move.
      if (blocked[e]) {
        const held = dParam[i];
        if (q > held) q = held;
      }
      let p = ff < q ? ff : q;
      if (!(p > 0)) p = 0;

      if (p < 1) {
        dParam[i] = p;
        break;
      }

      f.dotsOn[e] -= 1;
      const to = edgeTo[e];
      if (isExit[to]) {
        f.dState[i] = ARRIVED;
        f.dArriveT[i] = simT;
        f.arrived[f.arrivedCount++] = i;
        removeMoving(f, i);
        break;
      }
      const next = chooseEdge(f, i, to);
      if (next < 0) {
        markStuck(f, i, e);
        f.dParam[i] = 1;
        f.dotsOn[e] += 1;
        removeMoving(f, i);
        break;
      }
      recordHop(f, i, to, next);
      // Backdated by the overshoot, so the car enters the next edge at the moment it actually
      // reached the end of this one rather than at the frame boundary. At x600 a car crosses
      // more than one edge per frame and would otherwise lose the fraction every time.
      // When the queue branch was the binding one, (p-1) is measured in link-fractions rather
      // than in free-flow time and the conversion is approximate -- but q crosses 1 gradually,
      // so the overshoot is then a fraction of a car length.
      enterEdge(f, i, next, simT - (p - 1) / invTt[e], 0);
      if (++hops >= MAX_HOPS_PER_FRAME) {
        dParam[i] = 0;
        break;
      }
    }
  }
}

export type ViewBounds = { x0: number; y0: number; x1: number; y1: number };

/**
 * Compacts the moving cars into the position buffer, and records which slot each drawn point
 * came from so a pick can name the car.
 */
export function writePositions(f: TracerField, bounds: ViewBounds | null): number {
  const { moving, dEdge, dParam, dVtx, cum, edgeLen, vertsM, startIndices, pos, slotOf, edgeBbox } =
    f;
  let out = 0;
  for (let k = 0; k < f.movingCount; k++) {
    const i = moving[k];
    const e = dEdge[i];
    if (bounds !== null) {
      // Hoisted to the edge, not the point: the position is closed-form, so a car on an
      // off-screen road needs neither the polyline walk nor the write.
      const b = e * 4;
      if (
        edgeBbox[b] > bounds.x1 ||
        edgeBbox[b + 2] < bounds.x0 ||
        edgeBbox[b + 1] > bounds.y1 ||
        edgeBbox[b + 3] < bounds.y0
      ) {
        continue;
      }
    }
    const a = startIndices[e];
    const bEnd = startIndices[e + 1];
    const target = dParam[i] * edgeLen[e];
    // Resumes where this car left off last frame instead of rescanning the polyline: param only
    // grows while a car is on one edge.
    let vtx = dVtx[i];
    if (vtx < a + 1) vtx = a + 1;
    while (vtx < bEnd - 1 && cum[vtx] < target) vtx++;
    dVtx[i] = vtx;

    const d0 = cum[vtx - 1];
    const seg = cum[vtx] - d0;
    const t = seg > 0 ? (target - d0) / seg : 0;
    const x0 = vertsM[(vtx - 1) * 2];
    const y0 = vertsM[(vtx - 1) * 2 + 1];
    pos[out * 2] = x0 + (vertsM[vtx * 2] - x0) * t;
    pos[out * 2 + 1] = y0 + (vertsM[vtx * 2 + 1] - y0) * t;
    slotOf[out] = i;
    out++;
  }
  f.count = out;
  return out;
}

/** Position of a car, whatever state it is in, in metre offsets. Null when it has left. */
export function carPosition(f: TracerField, slot: number): [number, number] | null {
  const state = f.dState[slot];
  if (state === ARRIVED) return null;
  if (state === PARKED) return [f.yardPos[slot * 2], f.yardPos[slot * 2 + 1]];
  if (state === STUCK) {
    for (let i = 0; i < f.stuckCount; i++) {
      if (f.stuckList[i] === slot) return [f.stuckPos[i * 2], f.stuckPos[i * 2 + 1]];
    }
    return null;
  }
  const e = f.dEdge[slot];
  const a = f.startIndices[e];
  const b = f.startIndices[e + 1];
  const target = f.dParam[slot] * f.edgeLen[e];
  let k = a + 1;
  while (k < b - 1 && f.cum[k] < target) k++;
  const d0 = f.cum[k - 1];
  const seg = f.cum[k] - d0;
  const t = seg > 0 ? (target - d0) / seg : 0;
  const x0 = f.vertsM[(k - 1) * 2];
  const y0 = f.vertsM[(k - 1) * 2 + 1];
  return [x0 + (f.vertsM[k * 2] - x0) * t, y0 + (f.vertsM[k * 2 + 1] - y0) * t];
}

/** max |dotsOn[e] - n[e]|: the self-check that says whether the Newell wiring is right. */
export function dotError(f: TracerField): number {
  let worst = 0;
  for (let e = 0; e < f.E; e++) {
    const d = Math.abs(f.dotsOn[e] - f.n[e]);
    if (d > worst) worst = d;
  }
  return worst;
}

/** Exposed for the test that pins the copied mixer against src/core/rng.ts. */
export const _splitmix32 = splitmix32;
