#!/usr/bin/env node
// Synthetic city generator. CONTRACTS.md §4bis.
// Emits a valid §3 city.bin with no OSM involved, so the core, the routing field, the
// renderer and the tests can all be built against the real format before the
// preprocessor exists.
//
// Geometry is derived from indices, never from an RNG -- fixtures must be deterministic.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CLASS_CODE } from '../src/core/params.ts';
import type { CityMeta, LatLng } from '../src/core/types.ts';
import { upsertCatalogue } from './catalogue.ts';
import { CityBuilder, metresToDegLat, metresToDegLon } from './cityBuilder.ts';

const DIRNAME = /^.*\//;
const BIN_EXT = /\.bin$/;

const ORIGIN: Record<string, LatLng> = {
  grid: [37.76, -122.44],
  line: [39.7596, -121.6219],
  single: [37.0, -122.0],
  island: [47.57, -122.22],
};

type Built = { b: CityBuilder; name: string; zones: string[] };
type Opts = Record<string, number>;

/** An exit is a separate node beyond the boundary, reached by one one-way arc. */
function attachExit(b: CityBuilder, fromNode: number, bearingLat: number, bearingLon: number, name: string): number {
  const [la, lo] = b.nodes[fromNode];
  const x = b.node(la + bearingLat, lo + bearingLon);
  b.edge(fromNode, x, { cls: CLASS_CODE.primary, lanes: 2, name, exitEdge: true, oneway: true });
  b.exit(x);
  return x;
}

function buildGrid({ n = 20, pop = 20000, exits = 2, spacingM = 200 }: Opts): Built {
  const b = new CityBuilder();
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
  const b = new CityBuilder();
  const [lat0, lon0] = ORIGIN.line;
  const dLon = metresToDegLon(spacingM, lat0);
  for (let i = 0; i <= n; i++) b.node(lat0, lon0 + i * dLon);
  for (let i = 0; i < n; i++) b.pair(i, i + 1, { cls: CLASS_CODE.secondary, name: 'Main Street' });
  attachExit(b, n, 0, dLon * 3, 'Exit');
  for (let i = 0; i <= n; i++) b.source(i, pop / (n + 1), (pop / (n + 1)) * 0.08, 0);
  return { b, name: `Synthetic chain of ${n}`, zones: [''] };
}

function buildSingle({ lanes = 2, pop = 1e6, lenM = 1000 }: Opts): Built {
  const b = new CityBuilder();
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
  const b = new CityBuilder();
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
    id: outPath.replace(DIRNAME, '').replace(BIN_EXT, ''),
    name,
    blurb: `Synthetic fixture (${kind}). Not real geography.`,
    center: [(Math.min(...lats) + Math.max(...lats)) / 2, (Math.min(...lons) + Math.max(...lons)) / 2],
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
  writeFileSync(outPath.replace(BIN_EXT, '.json'), `${JSON.stringify(meta, null, 2)}\n`);
  return { buf, meta };
}

const FIXTURES: [string, Opts, string][] = [
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
  upsertCatalogue(catalogue);
} else if (typeof args.kind === 'string') {
  const { kind, out, ...rest } = args;
  if (!KINDS[kind as string]) {
    throw new Error(`unknown --kind ${kind}; available: ${Object.keys(KINDS).join(', ')}`);
  }
  const { meta } = emit(kind as string, rest as Opts, typeof out === 'string' ? out : `test/fixtures/${kind}.bin`);
  console.log(`${typeof out === 'string' ? out : kind}: V=${meta.nodes} E=${meta.edges} ${meta.bytes} B`);
} else {
  console.log(`Usage:
  node tools/synth.ts --all
  node tools/synth.ts --kind grid --n 20 --pop 20000 --exits 2 --out test/fixtures/grid20.bin
  available --kind: ${Object.keys(KINDS).join(', ')}`);
}
