// Test-side helpers. Written from the contract, not from the implementation: the fixtures
// are read as bytes, and the tiny graphs below are built by hand rather than through the
// loader, so a bug in the loader cannot hide a bug in the node model.

import { readFileSync } from 'node:fs';
import { parseCity } from '../src/core/city.ts';
import { normalizeScenario, resolveParams } from '../src/core/scenario.ts';
import type { City, LatLng, Params, Scenario, SimState } from '../src/core/types.ts';

export function fixtureBytes(name: string): ArrayBuffer {
  const b = readFileSync(new URL(`./fixtures/${name}.bin`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export const loadFixture = (name: string): City => parseCity(fixtureBytes(name));

type ScenarioPatch = {
  demand?: Partial<Scenario['demand']>;
  supply?: Partial<Scenario['supply']>;
  routing?: Partial<Scenario['routing']>;
  seed?: number;
  exits?: number[];
};

export function params(city: string, patch: ScenarioPatch = {}): Params {
  return resolveParams(normalizeScenario({ city, ...patch }));
}

/** notDeparted + enRoute + evacuated, which §7.1 requires to equal totalVeh every tick. */
export function massInSystem(s: SimState): number {
  let m = s.evacuated;
  for (let v = 0; v < s.city.V; v++) m += s.waiting[v] + s.queued[v];
  for (let e = 0; e < s.city.E; e++) m += s.n[e];
  return m;
}

type TinyEdge = { from: number; to: number; lanes: number; cls: number; lenM: number; speedKmh: number };

/**
 * A City assembled directly, for graphs too small to be worth a .bin. Mirrors §5: the
 * derived arrays are rebuilt here independently of the loader.
 */
export function tinyCity(opts: {
  V: number;
  edges: TinyEdge[];
  sources?: Array<{ node: number; pop: number }>;
  exits?: number[];
}): City {
  const { V, edges } = opts;
  const sources = opts.sources ?? [];
  const exits = opts.exits ?? [];

  const sorted = [...edges].sort((a, b) => a.from - b.from);
  const E = sorted.length;

  const csrOff = new Uint32Array(V + 1);
  for (const e of sorted) csrOff[e.from + 1]++;
  for (let v = 0; v < V; v++) csrOff[v + 1] += csrOff[v];

  const edgeTo = new Uint32Array(E);
  const edgeFrom = new Uint32Array(E);
  const lenM = new Uint16Array(E);
  const lanes = new Uint8Array(E);
  const speedKmh = new Uint8Array(E);
  const flags = new Uint8Array(E);
  sorted.forEach((e, i) => {
    edgeTo[i] = e.to;
    edgeFrom[i] = e.from;
    lenM[i] = e.lenM;
    lanes[i] = e.lanes;
    speedKmh[i] = e.speedKmh;
    flags[i] = (e.cls << 5) & 0xe0;
  });

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

  let maxOutDeg = 0;
  for (let v = 0; v < V; v++) maxOutDeg = Math.max(maxOutDeg, csrOff[v + 1] - csrOff[v]);

  const isExit = new Uint8Array(V);
  for (const x of exits) isExit[x] = 1;

  const center: LatLng = [0, 0];
  return {
    meta: { id: 'tiny', name: 'tiny', center, zoom: 12 },
    version: 2,
    bbox: [0, 0, 0, 0],
    V,
    E,
    S: sources.length,
    X: exits.length,
    G: 0,
    NS: 0,
    lat: new Int32Array(V),
    lon: new Int32Array(V),
    geomOff: new Uint32Array(E + 1),
    geomPts: new Int16Array(0),
    csrOff,
    edgeTo,
    edgeFrom,
    twin: new Uint32Array(E).fill(0xffffffff),
    inOff,
    inEdge,
    lenM,
    lanes,
    speedKmh,
    flags,
    srcNode: Uint32Array.from(sources.map((s) => s.node)),
    srcPop: Float32Array.from(sources.map((s) => s.pop)),
    srcNoCar: new Float32Array(sources.length),
    srcZone: new Uint8Array(sources.length),
    exitNode: Uint32Array.from(exits),
    isExit,
    nameId: new Uint16Array(E),
    nameBlob: new Uint8Array(0),
    nameStarts: [0],
    maxOutDeg,
    maxInDeg,
    nameOf: () => '',
  };
}
