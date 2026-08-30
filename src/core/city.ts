// The city.bin format and its loader. CONTRACTS.md §3, §5.
// Format constants live here and are imported by the writer (tools/synth.ts):
// two independent statements of the layout drift apart silently.

import type { City, CityMeta, EdgeIdx } from './types.ts';

export const MAGIC = 0x4b434e42; // "BNCK" little-endian
export const FORMAT_VERSION = 2;
export const HEADER_BYTES = 128;
export const SECTION_SLOTS = 20; // 18 used, 2 reserved for additive growth
export const NO_TWIN = 0xffffffff;

export const SECTION = {
  NODE_LAT: 0,
  NODE_LON: 1,
  CSR_OFF: 2,
  EDGE_TO: 3,
  EDGE_LEN: 4,
  EDGE_LANES: 5,
  EDGE_SPEED: 6,
  EDGE_FLAGS: 7,
  EDGE_TWIN: 8,
  GEOM_OFF: 9,
  GEOM_PTS: 10,
  SRC_NODE: 11,
  SRC_POP: 12,
  SRC_NOCAR: 13,
  SRC_ZONE: 14,
  EXIT: 15,
  NAME_ID: 16,
  NAME_BLOB: 17,
} as const;

export const FLAG = {
  ONEWAY: 1 << 0,
  BRIDGE: 1 << 1,
  TUNNEL: 1 << 2,
  MOTORWAY_CLASS: 1 << 3,
  EXIT_EDGE: 1 << 4,
  CLASS_SHIFT: 5,
  CLASS_MASK: 0xe0,
} as const;

export const MAX_EDGE_LEN_M = 60000;

// Geometry is stored in units of 1e-6 degrees, node coordinates in 1e-7.
// This is the factor between them; getting it wrong shifts every polyline tenfold, silently.
export const GEOM_SCALE = 10;

export function classOf(flags: number): number {
  return (flags & FLAG.CLASS_MASK) >>> FLAG.CLASS_SHIFT;
}

type TypedArrayCtor<T> = new (buffer: ArrayBuffer, byteOffset: number, length: number) => T;

/** Pure buffer parsing. Touches no network, so it runs in Node and in tests. */
export function parseCity(buffer: ArrayBuffer, meta: CityMeta | Record<string, never> = {}): City {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('city.bin: bad magic, expected BNCK');
  const version = dv.getUint16(4, true);
  if (version !== FORMAT_VERSION) {
    throw new Error(`city.bin: format version ${version}, only ${FORMAT_VERSION} is supported`);
  }

  const V = dv.getUint32(8, true);
  const E = dv.getUint32(12, true);
  const S = dv.getUint32(16, true);
  const X = dv.getUint32(20, true);
  const G = dv.getUint32(24, true);
  const NS = dv.getUint32(28, true);
  const bbox: City['bbox'] = [
    dv.getInt32(32, true),
    dv.getInt32(36, true),
    dv.getInt32(40, true),
    dv.getInt32(44, true),
  ];

  const off = new Uint32Array(SECTION_SLOTS);
  for (let i = 0; i < SECTION_SLOTS; i++) off[i] = dv.getUint32(48 + i * 4, true);
  const at = <T>(s: number, Type: TypedArrayCtor<T>, len: number): T =>
    new Type(buffer, off[s], len);

  const csrOff = at(SECTION.CSR_OFF, Uint32Array, V + 1);
  const edgeTo = at(SECTION.EDGE_TO, Uint32Array, E);
  const exitNode = at(SECTION.EXIT, Uint32Array, X);
  const nameId = at(SECTION.NAME_ID, Uint16Array, E);
  const nameBlob = at(SECTION.NAME_BLOB, Uint8Array, NS);

  const derived = buildDerived(V, E, csrOff, edgeTo, exitNode);
  const names = buildNameIndex(nameBlob);

  return {
    meta,
    version,
    bbox,
    V,
    E,
    S,
    X,
    G,
    NS,
    lat: at(SECTION.NODE_LAT, Int32Array, V),
    lon: at(SECTION.NODE_LON, Int32Array, V),
    csrOff,
    edgeTo,
    lenM: at(SECTION.EDGE_LEN, Uint16Array, E),
    lanes: at(SECTION.EDGE_LANES, Uint8Array, E),
    speedKmh: at(SECTION.EDGE_SPEED, Uint8Array, E),
    flags: at(SECTION.EDGE_FLAGS, Uint8Array, E),
    twin: at(SECTION.EDGE_TWIN, Uint32Array, E),
    geomOff: at(SECTION.GEOM_OFF, Uint32Array, E + 1),
    geomPts: at(SECTION.GEOM_PTS, Int16Array, G * 2),
    srcNode: at(SECTION.SRC_NODE, Uint32Array, S),
    srcPop: at(SECTION.SRC_POP, Float32Array, S),
    srcNoCar: at(SECTION.SRC_NOCAR, Float32Array, S),
    srcZone: at(SECTION.SRC_ZONE, Uint8Array, S),
    exitNode,
    nameId,
    nameBlob,
    ...derived,
    ...names,
  };
}

type Derived = Pick<
  City,
  'edgeFrom' | 'inOff' | 'inEdge' | 'isExit' | 'maxOutDeg' | 'maxInDeg'
>;

/** edgeFrom, incoming edges, isExit, degrees. One pass, no per-element objects. */
function buildDerived(
  V: number,
  E: number,
  csrOff: Uint32Array,
  edgeTo: Uint32Array,
  exitNode: Uint32Array,
): Derived {
  const edgeFrom = new Uint32Array(E);
  let maxOutDeg = 0;
  for (let v = 0; v < V; v++) {
    const a = csrOff[v];
    const b = csrOff[v + 1];
    if (b - a > maxOutDeg) maxOutDeg = b - a;
    for (let e = a; e < b; e++) edgeFrom[e] = v;
  }

  const inOff = new Uint32Array(V + 1);
  for (let e = 0; e < E; e++) inOff[edgeTo[e] + 1]++;
  let maxInDeg = 0;
  for (let v = 0; v < V; v++) {
    if (inOff[v + 1] > maxInDeg) maxInDeg = inOff[v + 1];
    inOff[v + 1] += inOff[v];
  }
  const cursor = Uint32Array.from(inOff.subarray(0, V));
  const inEdge = new Uint32Array(E);
  for (let e = 0; e < E; e++) inEdge[cursor[edgeTo[e]]++] = e;

  const isExit = new Uint8Array(V);
  for (let i = 0; i < exitNode.length; i++) isExit[exitNode[i]] = 1;

  return { edgeFrom, inOff, inEdge, isExit, maxOutDeg, maxInDeg };
}

function buildNameIndex(nameBlob: Uint8Array): Pick<City, 'nameStarts' | 'nameOf'> {
  const starts = [0];
  for (let i = 0; i < nameBlob.length; i++) if (nameBlob[i] === 0) starts.push(i + 1);
  const dec = new TextDecoder();
  return {
    nameStarts: starts,
    nameOf(this: City, e: EdgeIdx): string {
      const id = this.nameId[e];
      if (id === 0 || id >= starts.length) return '';
      const a = starts[id];
      let b = a;
      while (b < nameBlob.length && nameBlob[b] !== 0) b++;
      return dec.decode(nameBlob.subarray(a, b));
    },
  };
}

/**
 * An edge polyline in degrees: tail node, intermediate points, head node.
 * Deltas accumulate in quantised units, so the decoder lands exactly where the
 * encoder did, without drift.
 */
export function edgePolyline(city: City, e: EdgeIdx): Array<[number, number]> {
  const from = city.edgeFrom[e];
  const to = city.edgeTo[e];
  const pts: Array<[number, number]> = [[city.lat[from] / 1e7, city.lon[from] / 1e7]];
  let lat = city.lat[from];
  let lon = city.lon[from];
  for (let k = city.geomOff[e]; k < city.geomOff[e + 1]; k++) {
    lat += city.geomPts[k * 2] * GEOM_SCALE;
    lon += city.geomPts[k * 2 + 1] * GEOM_SCALE;
    pts.push([lat / 1e7, lon / 1e7]);
  }
  pts.push([city.lat[to] / 1e7, city.lon[to] / 1e7]);
  return pts;
}

/** Strongly connected components of G' -- exit out-edges suppressed (§3.3.8). */
export function stronglyConnectedComponents(
  city: Pick<City, 'V' | 'csrOff' | 'edgeTo' | 'isExit'>,
): { comp: Int32Array; nComp: number } {
  const { V, csrOff, edgeTo, isExit } = city;
  const index = new Int32Array(V).fill(-1);
  const low = new Int32Array(V);
  const onStack = new Uint8Array(V);
  const comp = new Int32Array(V).fill(-1);
  const stack = new Int32Array(V);
  const frameV = new Int32Array(V + 1);
  const frameE = new Uint32Array(V + 1);
  let sp = 0;
  let idx = 0;
  let nComp = 0;

  const endOf = (v: number): number => (isExit[v] ? csrOff[v] : csrOff[v + 1]);

  for (let s = 0; s < V; s++) {
    if (index[s] !== -1) continue;
    let top = 0;
    frameV[0] = s;
    frameE[0] = csrOff[s];
    index[s] = low[s] = idx++;
    stack[sp++] = s;
    onStack[s] = 1;
    while (top >= 0) {
      const v = frameV[top];
      if (frameE[top] < endOf(v)) {
        const w = edgeTo[frameE[top]++];
        if (index[w] === -1) {
          index[w] = low[w] = idx++;
          stack[sp++] = w;
          onStack[w] = 1;
          top++;
          frameV[top] = w;
          frameE[top] = csrOff[w];
        } else if (onStack[w] && index[w] < low[v]) {
          low[v] = index[w];
        }
      } else {
        if (low[v] === index[v]) {
          for (;;) {
            const w = stack[--sp];
            onStack[w] = 0;
            comp[w] = nComp;
            if (w === v) break;
          }
          nComp++;
        }
        top--;
        if (top >= 0 && low[v] < low[frameV[top]]) low[frameV[top]] = low[v];
      }
    }
  }
  return { comp, nComp };
}

/** The invariants of §3.3. An empty array means the file is valid. */
export function validateCity(city: City): string[] {
  const err: string[] = [];
  const {
    V,
    E,
    G,
    csrOff,
    edgeTo,
    twin,
    lenM,
    lanes,
    speedKmh,
    geomOff,
    srcNode,
    srcPop,
    srcNoCar,
    exitNode,
    isExit,
  } = city;

  if (csrOff[0] !== 0 || csrOff[V] !== E) {
    err.push(`1: CSR_OFF[0]=${csrOff[0]}, CSR_OFF[V]=${csrOff[V]}, expected 0 and ${E}`);
  }
  for (let v = 0; v < V; v++) {
    if (csrOff[v + 1] < csrOff[v]) {
      err.push(`2: CSR_OFF decreases at node ${v}`);
      break;
    }
  }
  for (let e = 0; e < E; e++) {
    if (edgeTo[e] >= V) {
      err.push(`3: EDGE_TO[${e}]=${edgeTo[e]} >= V=${V}`);
      break;
    }
  }
  if (geomOff[0] !== 0 || geomOff[E] !== G) {
    err.push(`4: GEOM_OFF[0]=${geomOff[0]}, GEOM_OFF[E]=${geomOff[E]}, expected 0 and ${G}`);
  }
  for (let e = 0; e < E; e++) {
    const t = twin[e];
    if (t === NO_TWIN) continue;
    if (t >= E || twin[t] !== e) {
      err.push(`5: EDGE_TWIN is not mutual at edge ${e} (twin=${t})`);
      break;
    }
  }
  for (let e = 0; e < E; e++) {
    if (lanes[e] < 1) {
      err.push(`6: lanes[${e}]=${lanes[e]} < 1`);
      break;
    }
  }
  for (let e = 0; e < E; e++) {
    if (speedKmh[e] < 5) {
      err.push(`6: speedKmh[${e}]=${speedKmh[e]} < 5`);
      break;
    }
  }
  for (let e = 0; e < E; e++) {
    if (lenM[e] > MAX_EDGE_LEN_M) {
      err.push(`7: lenM[${e}]=${lenM[e]} > ${MAX_EDGE_LEN_M}, the edge must be split`);
      break;
    }
  }

  for (let i = 0; i < srcNode.length; i++) {
    if (srcNode[i] >= V) {
      err.push(`11: SRC_NODE[${i}]=${srcNode[i]} >= V`);
      break;
    }
  }
  for (let i = 0; i < exitNode.length; i++) {
    if (exitNode[i] >= V) {
      err.push(`11: EXIT[${i}]=${exitNode[i]} >= V`);
      break;
    }
  }
  for (let i = 0; i < srcNode.length; i++) {
    if (srcNode[i] < V && isExit[srcNode[i]]) {
      err.push(`11: node ${srcNode[i]} is both a SRC and an EXIT`);
      break;
    }
  }

  let pop = 0;
  for (let i = 0; i < srcPop.length; i++) {
    pop += srcPop[i];
    if (!(srcNoCar[i] >= 0 && srcNoCar[i] <= srcPop[i])) {
      err.push(`10: SRC_NOCAR[${i}]=${srcNoCar[i]} outside [0, SRC_POP[${i}]=${srcPop[i]}]`);
      break;
    }
  }
  if (!(pop > 0)) err.push(`10: sum(SRC_POP)=${pop}, must be > 0`);

  // 8 and 9: connectivity. C is the component that holds the sources.
  if (err.length === 0 && srcNode.length > 0) {
    const { comp } = stronglyConnectedComponents(city);
    const C = comp[srcNode[0]];
    for (let i = 1; i < srcNode.length; i++) {
      if (comp[srcNode[i]] !== C) {
        err.push(
          `8: SRC ${srcNode[i]} outside the source component (comp=${comp[srcNode[i]]}, expected ${C})`,
        );
        break;
      }
    }
    for (let v = 0; v < V; v++) {
      if (comp[v] !== C && !isExit[v]) {
        err.push(`8: node ${v} is neither in the source component nor an exit; the preprocessor must drop it`);
        break;
      }
    }
    let reachableExits = 0;
    for (let i = 0; i < exitNode.length; i++) {
      const x = exitNode[i];
      let ok = false;
      for (let k = city.inOff[x]; k < city.inOff[x + 1]; k++) {
        if (comp[city.edgeFrom[city.inEdge[k]]] === C) {
          ok = true;
          break;
        }
      }
      if (ok) reachableExits++;
      else err.push(`8: exit ${x} is unreachable from the source component`);
    }
    if (reachableExits === 0) err.push('9: no exit is reachable from the sources');
  }

  return err;
}

/** Network load. The only I/O in core; the parsing itself lives in parseCity. */
export async function loadCity(
  url: string,
  meta: CityMeta | Record<string, never> = {},
): Promise<City> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`city.bin: ${res.status} ${res.statusText} for ${url}`);
  return parseCity(await res.arrayBuffer(), meta);
}
