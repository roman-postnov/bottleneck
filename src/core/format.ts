// The city.bin format and its parser. docs/CONTRACTS.md §3, §5.
// Format constants live here and are imported by the writer (tools/cityBuilder.ts):
// two independent statements of the layout drift apart silently.

import type { City, CityMeta, EdgeIdx } from './types.ts';

export const MAGIC = 0x4b434e42; // "BNCK" little-endian
export const FORMAT_VERSION = 2;
export const HEADER_BYTES = 128;
export const SECTION_SLOTS = 20; // all 20 used; the next additive section needs version 3
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
  BLD_OFF: 18,
  BLD_PTS: 19,
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
  const at = <T>(s: number, Type: TypedArrayCtor<T>, len: number): T => new Type(buffer, off[s], len);

  // Buildings are the one section a file may lack: the committed synthetic fixtures predate
  // it, and §3.1's reserve is additive precisely so an old file stays readable. Offset 0 is
  // the marker -- no section can start there, the header ends at 128.
  const hasBld = off[SECTION.BLD_OFF] !== 0;
  const bldOff = hasBld ? at(SECTION.BLD_OFF, Uint32Array, V + 1) : new Uint32Array(V + 1);
  const B = bldOff[V];
  const bldPts = hasBld ? at(SECTION.BLD_PTS, Int16Array, B * 2) : new Int16Array(0);

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
    B,
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
    bldOff,
    bldPts,
    ...derived,
    ...names,
  };
}

type Derived = Pick<City, 'edgeFrom' | 'inOff' | 'inEdge' | 'isExit' | 'maxOutDeg' | 'maxInDeg'>;

/** edgeFrom, incoming edges, isExit, degrees. One pass, no per-element objects. */
function buildDerived(V: number, E: number, csrOff: Uint32Array, edgeTo: Uint32Array, exitNode: Uint32Array): Derived {
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
