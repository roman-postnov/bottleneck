#!/usr/bin/env node
// Synthetic city generator. CONTRACTS.md §4bis.
// Emits a valid §3 city.bin with no OSM involved, so the core, the routing field, the
// renderer and the tests can all be built against the real format before the
// preprocessor exists.
//
// Geometry is derived from indices, never from an RNG -- fixtures must be deterministic.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  MAGIC,
  FORMAT_VERSION,
  HEADER_BYTES,
  SECTION_SLOTS,
  SECTION,
  FLAG,
  NO_TWIN,
  GEOM_SCALE,
} from '../src/core/city.ts';
import { CLASS_CODE, HIGHWAY_CLASSES } from '../src/core/params.ts';
import type { CityMeta, LatLng } from '../src/core/types.ts';

const EARTH_R = 6371008.8;
const D2R = Math.PI / 180;

function haversineM(a: LatLng, b: LatLng): number {
  const dLat = (b[0] - a[0]) * D2R;
  const dLon = (b[1] - a[1]) * D2R;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * D2R) * Math.cos(b[0] * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

const metresToDegLat = (m: number): number => m / (EARTH_R * D2R);
const metresToDegLon = (m: number, lat: number): number => m / (EARTH_R * D2R * Math.cos(lat * D2R));

type EdgeRec = {
  from: number;
  to: number;
  cls: number;
  lanes: number;
  speedKmh: number;
  name: string;
  bridge: boolean;
  oneway: boolean;
  exitEdge: boolean;
  geom: LatLng[];
  twinTmp: number;
};

type EdgeOpts = Partial<Omit<EdgeRec, 'from' | 'to' | 'twinTmp'>>;

type SourceRec = { node: number; pop: number; noCar: number; zone: number };

class Builder {
  nodes: LatLng[] = [];
  edges: EdgeRec[] = [];
  sources: SourceRec[] = [];
  exitNodes: number[] = [];
  names: string[] = [''];
  nameIds = new Map<string, number>([['', 0]]);

  node(lat: number, lon: number): number {
    this.nodes.push([lat, lon]);
    return this.nodes.length - 1;
  }

  nameId(s: string): number {
    let id = this.nameIds.get(s);
    if (id === undefined) {
      if (this.names.length > 65535) throw new Error('name table overflow (limit 65,536, §3.2)');
      id = this.names.length;
      this.nameIds.set(s, id);
      this.names.push(s);
    }
    return id;
  }

  edge(from: number, to: number, o: EdgeOpts = {}): number {
    const cls = o.cls ?? CLASS_CODE.residential;
    const d = HIGHWAY_CLASSES[cls];
    this.edges.push({
      from,
      to,
      cls,
      lanes: o.lanes ?? d.lanes,
      speedKmh: o.speedKmh ?? d.speedKmh,
      name: o.name ?? '',
      bridge: !!o.bridge,
      oneway: !!o.oneway,
      exitEdge: !!o.exitEdge,
      geom: o.geom ?? [],
      twinTmp: -1,
    });
    return this.edges.length - 1;
  }

  /** Two opposing arcs with independent capacity (§4 step 3). */
  pair(a: number, b: number, o: EdgeOpts = {}): [number, number] {
    const fwd = this.edge(a, b, o);
    const rev = this.edge(b, a, { ...o, geom: [...(o.geom ?? [])].reverse() });
    this.edges[fwd].twinTmp = rev;
    this.edges[rev].twinTmp = fwd;
    return [fwd, rev];
  }

  source(node: number, pop: number, noCar = 0, zone = 0): void {
    this.sources.push({ node, pop, noCar, zone });
  }

  exit(node: number): void {
    this.exitNodes.push(node);
  }

  serialize(): ArrayBuffer {
    const V = this.nodes.length;
    const E = this.edges.length;

    // CSR requires edges grouped by their tail node.
    const order = [...this.edges.keys()].sort(
      (x, y) => this.edges[x].from - this.edges[y].from || x - y,
    );
    const newIdx = new Int32Array(E);
    order.forEach((old, i) => {
      newIdx[old] = i;
    });
    const ed = order.map((i) => this.edges[i]);

    const csrOff = new Uint32Array(V + 1);
    for (const e of ed) csrOff[e.from + 1]++;
    for (let v = 0; v < V; v++) csrOff[v + 1] += csrOff[v];
    if (csrOff[V] !== E) throw new Error('internal error: CSR offsets do not add up');

    const exitSet = new Set(this.exitNodes);
    const edgeTo = new Uint32Array(E);
    const lenM = new Uint16Array(E);
    const lanes = new Uint8Array(E);
    const speed = new Uint8Array(E);
    const flags = new Uint8Array(E);
    const twin = new Uint32Array(E);
    const nameId = new Uint16Array(E);
    const geomOff = new Uint32Array(E + 1);
    const geomPts: number[] = [];

    for (let i = 0; i < E; i++) {
      const e = ed[i];
      edgeTo[i] = e.to;
      lanes[i] = e.lanes;
      speed[i] = e.speedKmh;
      twin[i] = e.twinTmp < 0 ? NO_TWIN : newIdx[e.twinTmp];
      nameId[i] = this.nameId(e.name);

      let f = (e.cls << FLAG.CLASS_SHIFT) & FLAG.CLASS_MASK;
      if (e.oneway || e.twinTmp < 0) f |= FLAG.ONEWAY;
      if (e.bridge) f |= FLAG.BRIDGE;
      if (e.cls === CLASS_CODE.motorway || e.cls === CLASS_CODE.trunk) f |= FLAG.MOTORWAY_CLASS;
      if (e.exitEdge || exitSet.has(e.to)) f |= FLAG.EXIT_EDGE;
      flags[i] = f;

      // Deltas accumulate quantised, so the decoder lands on exactly these points.
      const src = this.nodes[e.from];
      let pLat = Math.round(src[0] * 1e7);
      let pLon = Math.round(src[1] * 1e7);
      const poly: LatLng[] = [src];
      geomOff[i] = geomPts.length / 2;
      for (const p of e.geom) {
        const tLat = Math.round(p[0] * 1e7);
        const tLon = Math.round(p[1] * 1e7);
        const dLat = Math.round((tLat - pLat) / GEOM_SCALE);
        const dLon = Math.round((tLon - pLon) / GEOM_SCALE);
        if (Math.abs(dLat) > 32767 || Math.abs(dLon) > 32767) {
          throw new Error(
            `edge ${i}: geometry delta overflows Int16, densification required (§3.2)`,
          );
        }
        geomPts.push(dLat, dLon);
        pLat += dLat * GEOM_SCALE;
        pLon += dLon * GEOM_SCALE;
        poly.push([pLat / 1e7, pLon / 1e7]);
      }
      poly.push(this.nodes[e.to]);

      let L = 0;
      for (let k = 1; k < poly.length; k++) L += haversineM(poly[k - 1], poly[k]);
      lenM[i] = Math.min(65535, Math.max(1, Math.round(L)));
    }
    geomOff[E] = geomPts.length / 2;
    const G = geomPts.length / 2;

    const S = this.sources.length;
    const srcNode = new Uint32Array(S);
    const srcPop = new Float32Array(S);
    const srcNoCar = new Float32Array(S);
    const srcZone = new Uint8Array(S);
    this.sources.forEach((s, i) => {
      srcNode[i] = s.node;
      srcPop[i] = s.pop;
      srcNoCar[i] = s.noCar;
      srcZone[i] = s.zone;
    });

    const exitNode = Uint32Array.from(this.exitNodes);
    const X = exitNode.length;

    const blob = new TextEncoder().encode(this.names.join('\0') + '\0');
    const NS = blob.length;

    const latI = new Int32Array(V);
    const lonI = new Int32Array(V);
    let minLat = Infinity;
    let minLon = Infinity;
    let maxLat = -Infinity;
    let maxLon = -Infinity;
    this.nodes.forEach(([la, lo], i) => {
      latI[i] = Math.round(la * 1e7);
      lonI[i] = Math.round(lo * 1e7);
      minLat = Math.min(minLat, latI[i]);
      maxLat = Math.max(maxLat, latI[i]);
      minLon = Math.min(minLon, lonI[i]);
      maxLon = Math.max(maxLon, lonI[i]);
    });

    const parts: ArrayBufferView[] = [];
    parts[SECTION.NODE_LAT] = latI;
    parts[SECTION.NODE_LON] = lonI;
    parts[SECTION.CSR_OFF] = csrOff;
    parts[SECTION.EDGE_TO] = edgeTo;
    parts[SECTION.EDGE_LEN] = lenM;
    parts[SECTION.EDGE_LANES] = lanes;
    parts[SECTION.EDGE_SPEED] = speed;
    parts[SECTION.EDGE_FLAGS] = flags;
    parts[SECTION.EDGE_TWIN] = twin;
    parts[SECTION.GEOM_OFF] = geomOff;
    parts[SECTION.GEOM_PTS] = Int16Array.from(geomPts);
    parts[SECTION.SRC_NODE] = srcNode;
    parts[SECTION.SRC_POP] = srcPop;
    parts[SECTION.SRC_NOCAR] = srcNoCar;
    parts[SECTION.SRC_ZONE] = srcZone;
    parts[SECTION.EXIT] = exitNode;
    parts[SECTION.NAME_ID] = nameId;
    parts[SECTION.NAME_BLOB] = blob;

    const align4 = (n: number): number => (n + 3) & ~3;
    const offsets = new Uint32Array(SECTION_SLOTS);
    let cursor = HEADER_BYTES;
    for (let s = 0; s < parts.length; s++) {
      offsets[s] = cursor;
      cursor = align4(cursor + parts[s].byteLength);
    }

    const buf = new ArrayBuffer(cursor);
    const dv = new DataView(buf);
    dv.setUint32(0, MAGIC, true);
    dv.setUint16(4, FORMAT_VERSION, true);
    dv.setUint16(6, 0, true);
    dv.setUint32(8, V, true);
    dv.setUint32(12, E, true);
    dv.setUint32(16, S, true);
    dv.setUint32(20, X, true);
    dv.setUint32(24, G, true);
    dv.setUint32(28, NS, true);
    dv.setInt32(32, minLat, true);
    dv.setInt32(36, minLon, true);
    dv.setInt32(40, maxLat, true);
    dv.setInt32(44, maxLon, true);
    for (let i = 0; i < SECTION_SLOTS; i++) dv.setUint32(48 + i * 4, offsets[i], true);

    const out = new Uint8Array(buf);
    for (let s = 0; s < parts.length; s++) {
      const src = parts[s];
      out.set(new Uint8Array(src.buffer, src.byteOffset, src.byteLength), offsets[s]);
    }
    return buf;
  }
}

// ---------------------------------------------------------------- topologies

const ORIGIN: Record<string, LatLng> = {
  grid: [37.76, -122.44],
  line: [39.7596, -121.6219],
  single: [37.0, -122.0],
  island: [47.57, -122.22],
};

type Built = { b: Builder; name: string; zones: string[] };
type Opts = Record<string, number>;

/** An exit is a separate node beyond the boundary, reached by one one-way arc. */
function attachExit(
  b: Builder,
  fromNode: number,
  bearingLat: number,
  bearingLon: number,
  name: string,
): number {
  const [la, lo] = b.nodes[fromNode];
  const x = b.node(la + bearingLat, lo + bearingLon);
  b.edge(fromNode, x, { cls: CLASS_CODE.primary, lanes: 2, name, exitEdge: true, oneway: true });
  b.exit(x);
  return x;
}

function buildGrid({ n = 20, pop = 20000, exits = 2, spacingM = 200 }: Opts): Built {
  const b = new Builder();
  const [lat0, lon0] = ORIGIN.grid;
  const dLat = metresToDegLat(spacingM);
  const dLon = metresToDegLon(spacingM, lat0);
  const id = (i: number, j: number): number => i * n + j;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) b.node(lat0 + i * dLat, lon0 + j * dLon);

  // Bend a third of the edges so the geometry section is non-empty and actually exercised.
  const bend = (a: number, c: number, k: number): LatLng[] => {
    if (k % 3 !== 0) return [];
    const [la1, lo1] = b.nodes[a];
    const [la2, lo2] = b.nodes[c];
    const mLat = (la1 + la2) / 2;
    const mLon = (lo1 + lo2) / 2;
    const off = metresToDegLat(15) * (k % 2 ? 1 : -1);
    return [[mLat + (la1 === la2 ? off : 0), mLon + (la1 === la2 ? 0 : off)]];
  };

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (j + 1 < n) {
        b.pair(id(i, j), id(i, j + 1), {
          name: `E-W ${i}`,
          geom: bend(id(i, j), id(i, j + 1), i + j),
        });
      }
      if (i + 1 < n) {
        b.pair(id(i, j), id(i + 1, j), {
          name: `N-S ${j}`,
          geom: bend(id(i, j), id(i + 1, j), i + j),
        });
      }
    }
  }

  const corners = [
    [0, 0, -1, -1],
    [n - 1, n - 1, 1, 1],
    [0, n - 1, -1, 1],
    [n - 1, 0, 1, -1],
  ];
  for (let k = 0; k < Math.min(exits, 4); k++) {
    const [i, j, si, sj] = corners[k];
    attachExit(b, id(i, j), si * dLat * 3, sj * dLon * 3, `Exit ${k + 1}`);
  }

  const per = pop / (n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const zone = 1 + (i < n / 2 ? 0 : 2) + (j < n / 2 ? 0 : 1);
      b.source(id(i, j), per, per * 0.08, zone);
    }
  }
  return { b, name: `Synthetic grid ${n}x${n}`, zones: ['', 'NW', 'NE', 'SW', 'SE'] };
}

function buildLine({ n = 10, pop = 5000, spacingM = 400 }: Opts): Built {
  const b = new Builder();
  const [lat0, lon0] = ORIGIN.line;
  const dLon = metresToDegLon(spacingM, lat0);
  for (let i = 0; i <= n; i++) b.node(lat0, lon0 + i * dLon);
  for (let i = 0; i < n; i++) b.pair(i, i + 1, { cls: CLASS_CODE.secondary, name: 'Main Street' });
  attachExit(b, n, 0, dLon * 3, 'Exit');
  for (let i = 0; i <= n; i++) b.source(i, pop / (n + 1), (pop / (n + 1)) * 0.08, 0);
  return { b, name: `Synthetic chain of ${n}`, zones: [''] };
}

function buildSingle({ lanes = 2, pop = 1e6, lenM = 1000 }: Opts): Built {
  const b = new Builder();
  const [lat0, lon0] = ORIGIN.single;
  const dLon = metresToDegLon(lenM, lat0);
  const s = b.node(lat0, lon0);
  const x = b.node(lat0, lon0 + dLon);
  // motorway has class factor 1.0, so capacity is exactly lanes x 1800 veh/h (sanity check 3).
  b.edge(s, x, {
    cls: CLASS_CODE.motorway,
    lanes,
    name: 'The Only Road',
    exitEdge: true,
    oneway: true,
  });
  b.exit(x);
  b.source(s, pop, 0, 0);
  return { b, name: `Single edge, ${lanes} lanes`, zones: [''] };
}

function buildIsland({ n = 8, pop = 25000, spacingM = 250, bridgeM = 2000 }: Opts): Built {
  const b = new Builder();
  const [lat0, lon0] = ORIGIN.island;
  const dLat = metresToDegLat(spacingM);
  const dLon = metresToDegLon(spacingM, lat0);
  const id = (i: number, j: number): number => i * n + j;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) b.node(lat0 + i * dLat, lon0 + j * dLon);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (j + 1 < n) b.pair(id(i, j), id(i, j + 1), { name: `Street ${i}` });
      if (i + 1 < n) b.pair(id(i, j), id(i + 1, j), { name: `Avenue ${j}` });
    }
  }
  // The only bridge out: this is where everything jams.
  const head = id(Math.floor(n / 2), n - 1);
  const bLon = metresToDegLon(bridgeM, lat0);
  const mid = b.node(lat0 + Math.floor(n / 2) * dLat, lon0 + (n - 1) * dLon + bLon);
  b.pair(head, mid, { cls: CLASS_CODE.trunk, lanes: 2, bridge: true, name: 'Bridge' });
  attachExit(b, mid, 0, bLon, 'Mainland');
  const per = pop / (n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) b.source(id(i, j), per, per * 0.12, 0);
  return { b, name: `Island ${n}x${n}, one bridge`, zones: [''] };
}

const KINDS: Record<string, (o: Opts) => Built> = {
  grid: buildGrid,
  line: buildLine,
  single: buildSingle,
  island: buildIsland,
};

// ---------------------------------------------------------------- CLI

function emit(kind: string, opts: Opts, outPath: string): { buf: ArrayBuffer; meta: CityMeta } {
  const { b, name, zones } = KINDS[kind](opts);
  const buf = b.serialize();
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, Buffer.from(buf));

  const pop = b.sources.reduce((s, x) => s + x.pop, 0);
  const noCar = b.sources.reduce((s, x) => s + x.noCar, 0);
  const lats = b.nodes.map((p) => p[0]);
  const lons = b.nodes.map((p) => p[1]);
  const meta: CityMeta = {
    id: outPath.replace(/^.*\//, '').replace(/\.bin$/, ''),
    name,
    blurb: `Synthetic fixture (${kind}). Not real geography.`,
    center: [
      (Math.min(...lats) + Math.max(...lats)) / 2,
      (Math.min(...lons) + Math.max(...lons)) / 2,
    ],
    zoom: 13,
    bytes: buf.byteLength,
    nodes: b.nodes.length,
    edges: b.edges.length,
    population: Math.round(pop),
    carlessPeople: Math.round(noCar),
    exits: b.exitNodes.length,
    zones,
    unassignedPop: 0,
    smallCity: true,
    notes: `synth.ts --kind ${kind} ${JSON.stringify(opts)}`,
  };
  writeFileSync(outPath.replace(/\.bin$/, '.json'), JSON.stringify(meta, null, 2) + '\n');
  return { buf, meta };
}

const FIXTURES: Array<[string, Opts, string]> = [
  ['grid', { n: 20, pop: 20000, exits: 2 }, 'test/fixtures/grid20.bin'],
  ['line', { n: 10, pop: 5000 }, 'test/fixtures/line10.bin'],
  ['single', { lanes: 2, pop: 1e6 }, 'test/fixtures/single.bin'],
  ['island', { n: 8, pop: 25000 }, 'test/fixtures/island8.bin'],
];

function parseArgs(argv: string[]): Record<string, string | number | boolean> {
  const a: Record<string, string | number | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    a[k] = v === 'true' ? true : Number.isNaN(Number(v)) ? v : Number(v);
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (args.all) {
  const catalogue: CityMeta[] = [];
  for (const [kind, opts, out] of FIXTURES) {
    const { meta } = emit(kind, opts, out);
    // The app serves cities from public/; the tests read the very same bytes from test/fixtures.
    emit(kind, opts, `public/cities/${meta.id}.bin`);
    catalogue.push(meta);
    console.log(
      `${out.padEnd(28)} V=${String(meta.nodes).padStart(5)} E=${String(meta.edges).padStart(6)} ${String(meta.bytes).padStart(8)} B`,
    );
  }
  writeFileSync('public/cities/index.json', JSON.stringify(catalogue, null, 2) + '\n');
} else if (typeof args.kind === 'string') {
  const { kind, out, ...rest } = args;
  if (!KINDS[kind as string]) {
    throw new Error(`unknown --kind ${kind}; available: ${Object.keys(KINDS).join(', ')}`);
  }
  const { meta } = emit(
    kind as string,
    rest as Opts,
    typeof out === 'string' ? out : `test/fixtures/${kind}.bin`,
  );
  console.log(`${typeof out === 'string' ? out : kind}: V=${meta.nodes} E=${meta.edges} ${meta.bytes} B`);
} else {
  console.log(`Usage:
  node tools/synth.ts --all
  node tools/synth.ts --kind grid --n 20 --pop 20000 --exits 2 --out test/fixtures/grid20.bin
  available --kind: ${Object.keys(KINDS).join(', ')}`);
}
