#!/usr/bin/env node
// Step 2 of the preprocessor, docs/CONTRACTS.md §4 steps 2-12: intermediate JSON -> city.bin.
//
// Every step is an exported pure function over plain arrays, so test/preprocess.test.ts can
// check collapsing, direction, lanes and splitting on three-node graphs instead of on a
// 650 MB .pbf. The writer is tools/cityBuilder.ts, shared with the synthetic generator.
//
//   node tools/preprocess.ts mercer

import { readFileSync, writeFileSync } from 'node:fs';
import { MAX_EDGE_LEN_M, parseCity, stronglyConnectedComponents, validateCity } from '../src/core/city.ts';
import { CLASS_CODE, HIGHWAY_CLASSES } from '../src/core/params.ts';
import type { CityMeta, LatLng } from '../src/core/types.ts';
import { upsertCatalogue } from './catalogue.ts';
import type { BuildingRec } from './cityBuilder.ts';
import { CityBuilder, haversineM } from './cityBuilder.ts';

/** `50`, `50 mph`, `30mph` -- the forms OSM actually carries. */
const MAXSPEED = /^(\d+(?:\.\d+)?)\s*(mph)?$/i;

export type Tags = Record<string, string>;
export type Bbox = [number, number, number, number]; // minLat, minLon, maxLat, maxLon

export type Extract = {
  id: string;
  bbox: Bbox;
  nodes: { id: number[]; lat: number[]; lon: number[] };
  ways: Array<{ i: number; r: number[]; t: Tags }>;
  /** Absent in extracts written before v1.9. */
  buildings?: { lat: number[]; lon: number[] };
};

export type CityConfig = {
  id: string;
  name: string;
  blurb: string;
  pbf: string;
  bbox: Bbox;
  center: LatLng;
  zoom: number;
  population: number;
  populationSource: string;
  carlessShare: number | null;
  carlessSource: string | null;
  popMode: 'roadlength' | 'raster';
  /** 'auto' = by class; a list of names/refs = by road name (§4 step 7, v1.4). */
  exits: 'auto' | string[];
  smallCity: boolean;
};

/** A way clipped to the bbox. Refs are node ids; only exit-class runs reach past the border. */
export type Run = { tags: Tags; refs: number[] };

export type Arc = {
  from: number;
  to: number;
  cls: number;
  lanes: number;
  speedKmh: number;
  name: string;
  bridge: boolean;
  tunnel: boolean;
  oneway: boolean;
  geom: LatLng[];
  lenM: number;
  twin: number;
};

export type Graph = { nodes: LatLng[]; arcs: Arc[]; exits: Set<number> };

const RESIDENTIAL = new Set([CLASS_CODE.residential, CLASS_CODE.unclassified]);
const EXIT_CLASSES = new Set(['motorway', 'trunk', 'primary']);

/**
 * Which ways are allowed to reach past the border and become exit candidates (§4 step 7).
 *
 * `auto` goes by class. On Paradise that finds nothing: no road in town is classed above
 * `secondary`, and Neal Road and Pentz Road -- two of the four arteries the evacuation
 * actually used -- are tagged `tertiary`. Dropping the threshold to `tertiary` instead would
 * make an exit of every residential stub crossing the frame, so the road's name is what
 * separates an artery from a dead end, and it comes from the report rather than a guess.
 */
export function exitPredicate(exits: 'auto' | string[]): (t: Tags) => boolean {
  if (exits === 'auto') return (t) => EXIT_CLASSES.has(t.highway ?? '');
  const wanted = new Set(exits.map((n) => n.toLowerCase()));
  return (t) => {
    const name = t.name?.toLowerCase();
    const ref = t.ref?.toLowerCase();
    return (name !== undefined && wanted.has(name)) || (ref !== undefined && wanted.has(ref));
  };
}

const LINK_PARENT: Record<string, string> = {
  motorway_link: 'motorway',
  trunk_link: 'trunk',
  primary_link: 'primary',
  secondary_link: 'secondary',
  tertiary_link: 'tertiary',
};

// ---------------------------------------------------------------- §4 step 4: tags to numbers

export function classCode(highway: string): number {
  if (highway in LINK_PARENT) return CLASS_CODE.link;
  const code = CLASS_CODE[highway as keyof typeof CLASS_CODE];
  return code === undefined ? CLASS_CODE.residential : code;
}

export function speedKmh(tags: Tags): number {
  const raw = tags.maxspeed;
  if (raw) {
    const m = MAXSPEED.exec(raw.trim());
    if (m) {
      const v = Math.round(Number(m[1]) * (m[2] ? 1.609344 : 1));
      if (v >= 5 && v <= 255) return v;
    }
  }
  const hw = tags.highway ?? 'residential';
  const parent = LINK_PARENT[hw];
  if (parent !== undefined) {
    const base = HIGHWAY_CLASSES[classCode(parent)].speedKmh;
    return Math.max(5, Math.ceil(base * 0.6));
  }
  return HIGHWAY_CLASSES[classCode(hw)].speedKmh;
}

export type Direction = 'forward' | 'backward' | 'both';

export function direction(tags: Tags): Direction {
  const ow = tags.oneway;
  if (ow === '-1' || ow === 'reverse') return 'backward';
  if (ow === 'yes' || ow === 'true' || ow === '1') return 'forward';
  // A roundabout without an explicit tag is one-way by convention, and taking it as two-way
  // hands the router a shortcut that does not exist on the ground.
  if (ow === undefined && (tags.junction === 'roundabout' || tags.junction === 'circular')) {
    return 'forward';
  }
  return 'both';
}

/** The per-direction lane count OSM actually states, or null when it states nothing. */
export function taggedLanes(tags: Tags, side: 'forward' | 'backward'): number | null {
  const explicit = tags[side === 'forward' ? 'lanes:forward' : 'lanes:backward'];
  const oneway = direction(tags) !== 'both';
  const total = explicit ?? tags.lanes;
  if (total === undefined) return null;
  const n = Number.parseFloat(total);
  if (!Number.isFinite(n)) return null;
  const per = explicit === undefined ? n / (oneway ? 1 : 2) : n;
  return Math.max(1, Math.floor(per));
}

export function lanes(tags: Tags, side: 'forward' | 'backward'): number {
  return taggedLanes(tags, side) ?? HIGHWAY_CLASSES[classCode(tags.highway ?? 'residential')].lanes;
}

const roadKey = (t: Tags): string | null => (t.name === undefined ? null : `${t.name}\u0000${t.highway ?? ''}`);

/**
 * Fills the lane count OSM left off a segment from the other segments of the same road
 * (§4 step 4, v1.4). A street does not change width where the mapper stopped typing.
 *
 * Skyway in Paradise is the case that forced this: its undivided blocks carry `lanes=4`, so
 * two per direction, while the divided carriageways that actually leave town carry no lane
 * tag at all and fell through to the class default of one. The model then read two lanes on
 * one block of a street and one on the next. Nothing is invented here -- the number comes
 * from OSM's own tags on that same road, an explicit tag is never overridden, and a road
 * that states nothing anywhere still gets the class default.
 *
 * The median, not the maximum: one mistagged segment should not widen a whole road.
 */
export function inferLanes(runs: Run[]): (tags: Tags, side: 'forward' | 'backward') => number {
  const seen = new Map<string, number[]>();
  for (const r of runs) {
    const key = roadKey(r.tags);
    if (key === null) continue;
    for (const side of ['forward', 'backward'] as const) {
      const n = taggedLanes(r.tags, side);
      if (n === null) continue;
      const list = seen.get(key);
      if (list) list.push(n);
      else seen.set(key, [n]);
    }
  }
  const median = new Map<string, number>();
  for (const [key, list] of seen) {
    list.sort((a, b) => a - b);
    median.set(key, list[(list.length - 1) >> 1]);
  }
  return (tags, side) => {
    const tagged = taggedLanes(tags, side);
    if (tagged !== null) return tagged;
    const key = roadKey(tags);
    const filled = key === null ? undefined : median.get(key);
    return filled ?? HIGHWAY_CLASSES[classCode(tags.highway ?? 'residential')].lanes;
  };
}

// ---------------------------------------------------------------- §4 steps 1-2: clip, collapse

const inside = (b: Bbox, p: LatLng): boolean => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

/**
 * Keeps the maximal runs of in-bbox nodes. An exit-class way additionally keeps the first node
 * past the border: §4 step 7 puts the exit exactly there, and without that node the road ends
 * at the shoreline instead of leaving town.
 */
export function clipWays(
  ways: Extract['ways'],
  coord: Map<number, LatLng>,
  bbox: Bbox,
  isExitWay: (t: Tags) => boolean = exitPredicate('auto'),
): { runs: Run[]; stubs: Set<number> } {
  const runs: Run[] = [];
  const stubs = new Set<number>();
  for (const w of ways) {
    const refs = w.r.filter((r) => coord.has(r));
    const isExitCls = isExitWay(w.t);
    const flags = refs.map((r) => inside(bbox, coord.get(r)!));
    let i = 0;
    while (i < refs.length) {
      if (!flags[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < refs.length && flags[j + 1]) j++;
      const run = refs.slice(i, j + 1);
      if (isExitCls) {
        if (i > 0) {
          run.unshift(refs[i - 1]);
          stubs.add(refs[i - 1]);
        }
        if (j + 1 < refs.length) {
          run.push(refs[j + 1]);
          stubs.add(refs[j + 1]);
        }
      }
      if (run.length >= 2) runs.push({ tags: w.t, refs: run });
      i = j + 1;
    }
  }
  return { runs, stubs };
}

/**
 * §4 step 2. A graph vertex is a node shared by two runs, a run endpoint, or an exit stub.
 * Everything else is intermediate geometry -- skipping this turns 30k vertices into 4M.
 */
export function vertexNodes(runs: Run[], stubs: Set<number>): Set<number> {
  const uses = new Map<number, number>();
  for (const run of runs) {
    for (const r of run.refs) uses.set(r, (uses.get(r) ?? 0) + 1);
  }
  const set = new Set<number>(stubs);
  for (const run of runs) {
    set.add(run.refs[0]);
    set.add(run.refs[run.refs.length - 1]);
    for (const r of run.refs) if ((uses.get(r) ?? 0) >= 2) set.add(r);
  }
  return set;
}

export function polylineLengthM(pts: LatLng[]): number {
  let L = 0;
  for (let k = 1; k < pts.length; k++) L += haversineM(pts[k - 1], pts[k]);
  return L;
}

/** §4 steps 2-5: runs to directed arcs, with the two directions kept independent. */
export function buildArcs(
  runs: Run[],
  coord: Map<number, LatLng>,
  vertices: Set<number>,
  stubs: Set<number> = new Set(),
  laneOf: (tags: Tags, side: 'forward' | 'backward') => number = lanes,
): Graph {
  const index = new Map<number, number>();
  const nodes: LatLng[] = [];
  const vertexOf = (osmId: number): number => {
    let v = index.get(osmId);
    if (v === undefined) {
      v = nodes.length;
      nodes.push(coord.get(osmId)!);
      index.set(osmId, v);
    }
    return v;
  };

  const arcs: Arc[] = [];
  for (const run of runs) {
    const dir = direction(run.tags);
    const cls = classCode(run.tags.highway ?? 'residential');
    const speed = speedKmh(run.tags);
    const name = run.tags.name ?? run.tags.ref ?? '';
    const bridge = run.tags.bridge !== undefined && run.tags.bridge !== 'no';
    const tunnel = run.tags.tunnel !== undefined && run.tags.tunnel !== 'no';

    let start = 0;
    for (let k = 1; k < run.refs.length; k++) {
      if (!vertices.has(run.refs[k]) && k < run.refs.length - 1) continue;
      const seg = run.refs.slice(start, k + 1);
      start = k;
      const a = vertexOf(seg[0]);
      const b = vertexOf(seg[seg.length - 1]);
      if (a === b) continue; // a closed loop between two vertices carries no traffic
      const geom = seg.slice(1, -1).map((r) => coord.get(r)!);
      const poly = [coord.get(seg[0])!, ...geom, coord.get(seg[seg.length - 1])!];
      const lenM = polylineLengthM(poly);
      const base = { cls, speedKmh: speed, name, bridge, tunnel, lenM, twin: -1 };

      if (dir === 'both') {
        const f = arcs.length;
        arcs.push({ ...base, from: a, to: b, lanes: laneOf(run.tags, 'forward'), oneway: false, geom });
        arcs.push({
          ...base,
          from: b,
          to: a,
          lanes: laneOf(run.tags, 'backward'),
          oneway: false,
          geom: [...geom].reverse(),
        });
        arcs[f].twin = f + 1;
        arcs[f + 1].twin = f;
      } else if (dir === 'forward') {
        arcs.push({ ...base, from: a, to: b, lanes: laneOf(run.tags, 'forward'), oneway: true, geom });
      } else {
        arcs.push({
          ...base,
          from: b,
          to: a,
          lanes: laneOf(run.tags, 'backward'),
          oneway: true,
          geom: [...geom].reverse(),
        });
      }
    }
  }
  const exits = new Set<number>();
  for (const s of stubs) {
    const v = index.get(s);
    if (v !== undefined) exits.add(v);
  }
  return { nodes, arcs, exits };
}

// ---------------------------------------------------------------- §4 step 6: split long edges

/** §3.3.7. Longer edges are split by a fictitious vertex, never clamped: a clamped length is
 *  a file that lies about distance. */
export function splitLongArcs(g: Graph, maxLenM: number = MAX_EDGE_LEN_M): Graph {
  const out: Arc[] = [];
  const remap = new Map<number, number[]>();
  for (let i = 0; i < g.arcs.length; i++) {
    const a = g.arcs[i];
    if (a.lenM <= maxLenM) {
      remap.set(i, [out.length]);
      out.push(a);
      continue;
    }
    const parts = Math.ceil(a.lenM / maxLenM);
    const poly = [g.nodes[a.from], ...a.geom, g.nodes[a.to]];
    const pieces: number[] = [];
    let prev = a.from;
    for (let p = 0; p < parts; p++) {
      const lo = Math.floor((poly.length - 1) * (p / parts));
      const hi = Math.floor((poly.length - 1) * ((p + 1) / parts));
      const last = p === parts - 1;
      let to: number;
      if (last) to = a.to;
      else {
        to = g.nodes.length;
        g.nodes.push(poly[hi]);
      }
      const geom = poly.slice(lo + 1, last ? poly.length - 1 : hi);
      pieces.push(out.length);
      out.push({ ...a, from: prev, to, geom, lenM: polylineLengthM([g.nodes[prev], ...geom, g.nodes[to]]), twin: -1 });
      prev = to;
    }
    remap.set(i, pieces);
  }
  // Twins survive only when both sides split into the same number of pieces, which they do:
  // the split is driven by length, and twins share a polyline.
  for (let i = 0; i < g.arcs.length; i++) {
    const t = g.arcs[i].twin;
    if (t < 0) continue;
    const mine = remap.get(i)!;
    const theirs = remap.get(t)!;
    if (mine.length !== theirs.length) continue;
    for (let k = 0; k < mine.length; k++) {
      out[mine[k]].twin = theirs[1 + k];
    }
  }
  return { ...g, arcs: out };
}

// ---------------------------------------------------------------- §4 step 8: population

/**
 * `roadlength` mode. A documented census total is split between vertices in proportion to the
 * length of the residential streets touching them. See docs/LIMITATIONS.md §3.2-3.3 for what
 * this gets wrong; the `raster` mode of §4 step 8 replaces it once a raster exists.
 *
 * Runs AFTER the prune, unlike the raster mode: the total belongs to the city, not to the
 * bbox, and a mainland sliver that leaked past the border must not walk off with a share of
 * the residents before Tarjan drops it.
 */
export function assignPopulation(g: Graph, total: number): Float64Array {
  const weight = new Float64Array(g.nodes.length);
  for (let i = 0; i < g.arcs.length; i++) {
    const a = g.arcs[i];
    if (!RESIDENTIAL.has(a.cls)) continue;
    if (a.twin >= 0 && a.twin < i) continue; // count each street once, not once per direction
    weight[a.from] += a.lenM / 2;
    weight[a.to] += a.lenM / 2;
  }
  for (const v of g.exits) weight[v] = 0;
  let sum = 0;
  for (const w of weight) sum += w;
  const pop = new Float64Array(g.nodes.length);
  if (sum === 0) return pop;
  for (let v = 0; v < pop.length; v++) pop[v] = (total * weight[v]) / sum;
  return pop;
}

// ------------------------------------------------------- §4 step 8bis: buildings to nodes

/** Beyond this a house is not on that street any more and gets no car (§4 step 8bis). */
export const BUILDING_RADIUS_M = 300;

/**
 * Attaches each building centroid to the nearest node that carries demand. Runs AFTER the
 * prune, like assignPopulation and for the same reason: node numbering changes there, and a
 * building attached to a node Tarjan then drops would index a vertex that no longer exists.
 *
 * `pop[v] > 0` rather than "has a residential out-edge": the two are the same set in
 * `roadlength` mode, and taking the demand itself makes it so by construction rather than by
 * argument -- a building whose node never releases a car would place a dot nobody drives away.
 *
 * A uniform grid, not a k-d tree. San Francisco is 166k buildings against 14k nodes; the tree
 * would be code without a win.
 */
export function assignBuildings(
  g: Graph,
  pop: Float64Array,
  blds: { lat: number[]; lon: number[] },
): { buildings: BuildingRec[]; dropped: number } {
  const out: BuildingRec[] = [];
  if (blds.lat.length === 0) return { buildings: out, dropped: 0 };

  const cand: number[] = [];
  for (let v = 0; v < pop.length; v++) if (pop[v] > 0) cand.push(v);
  if (cand.length === 0) return { buildings: out, dropped: blds.lat.length };

  let lat0 = 0;
  for (const v of cand) lat0 += g.nodes[v][0];
  lat0 /= cand.length;
  const cellLat = BUILDING_RADIUS_M / 111320;
  const cellLon = BUILDING_RADIUS_M / (111320 * Math.max(0.05, Math.cos((lat0 * Math.PI) / 180)));

  const cells = new Map<string, number[]>();
  const key = (i: number, j: number): string => `${i}:${j}`;
  for (const v of cand) {
    const k = key(Math.floor(g.nodes[v][0] / cellLat), Math.floor(g.nodes[v][1] / cellLon));
    const list = cells.get(k);
    if (list) list.push(v);
    else cells.set(k, [v]);
  }

  let dropped = 0;
  for (let b = 0; b < blds.lat.length; b++) {
    const lat = blds.lat[b] / 1e7;
    const lon = blds.lon[b] / 1e7;
    const ci = Math.floor(lat / cellLat);
    const cj = Math.floor(lon / cellLon);
    let best = -1;
    let bestD = BUILDING_RADIUS_M;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const list = cells.get(key(ci + di, cj + dj));
        if (!list) continue;
        for (const v of list) {
          const d = haversineM([lat, lon], g.nodes[v]);
          if (d < bestD) {
            bestD = d;
            best = v;
          }
        }
      }
    }
    if (best < 0) dropped++;
    else out.push({ node: best, lat, lon });
  }
  return { buildings: out, dropped };
}

// ---------------------------------------------------------------- §4 step 11: Tarjan

/**
 * §3.3.8. Keeps the largest strongly connected component of G' and moves every exit onto its
 * frontier. Without this the evacuation curve never reaches 100% and the reason takes a night
 * to find.
 *
 * `g.exits` arrives holding the bbox crossings of §4 step 7, and those are only candidates: a
 * divided highway leaves town one-way, so the carriageway between the last interchange and the
 * water belongs to no SCC at all, and keeping it would leave vertices outside C u EXIT --
 * exactly what invariant 8 forbids. The exit therefore moves to the first vertex past C on a
 * road that still leads to a candidate. A residential street clipped at the border leads
 * nowhere and is dropped instead, which is the point: cars must not escape through a dead end.
 */
export function pruneToLargestComponent(g: Graph): { graph: Graph; droppedNodes: number; droppedResidentialM: number } {
  const V = g.nodes.length;
  const order = [...g.arcs.keys()].sort((x, y) => g.arcs[x].from - g.arcs[y].from || x - y);
  const csrOff = new Uint32Array(V + 1);
  for (const a of g.arcs) csrOff[a.from + 1]++;
  for (let v = 0; v < V; v++) csrOff[v + 1] += csrOff[v];
  const edgeTo = new Uint32Array(g.arcs.length);
  order.forEach((old, i) => {
    edgeTo[i] = g.arcs[old].to;
  });
  const candidate = new Uint8Array(V);
  for (const v of g.exits) candidate[v] = 1;

  const { comp, nComp } = stronglyConnectedComponents({ V, csrOff, edgeTo, isExit: candidate });
  const size = new Int32Array(nComp);
  for (let v = 0; v < V; v++) if (!candidate[v]) size[comp[v]]++;
  let best = 0;
  for (let c = 1; c < nComp; c++) if (size[c] > size[best]) best = c;

  const core = new Uint8Array(V);
  for (let v = 0; v < V; v++) if (comp[v] === best && !candidate[v]) core[v] = 1;

  const leadsOut = new Uint8Array(V);
  const stack: number[] = [];
  for (let v = 0; v < V; v++)
    if (candidate[v]) {
      leadsOut[v] = 1;
      stack.push(v);
    }
  const into = new Map<number, number[]>();
  for (const a of g.arcs) {
    const list = into.get(a.to);
    if (list) list.push(a.from);
    else into.set(a.to, [a.from]);
  }
  while (stack.length > 0) {
    const v = stack.pop()!;
    for (const u of into.get(v) ?? []) {
      if (!leadsOut[u]) {
        leadsOut[u] = 1;
        stack.push(u);
      }
    }
  }

  const keep = new Uint8Array(core);
  const exitSet = new Set<number>();
  for (const a of g.arcs) {
    if (core[a.from] && !core[a.to] && leadsOut[a.to]) {
      keep[a.to] = 1;
      exitSet.add(a.to);
    }
  }

  const remap = new Int32Array(V).fill(-1);
  const nodes: LatLng[] = [];
  let droppedNodes = 0;
  for (let v = 0; v < V; v++) {
    if (keep[v]) {
      remap[v] = nodes.length;
      nodes.push(g.nodes[v]);
    } else {
      droppedNodes++;
    }
  }

  const arcRemap = new Int32Array(g.arcs.length).fill(-1);
  const arcs: Arc[] = [];
  for (let i = 0; i < g.arcs.length; i++) {
    const a = g.arcs[i];
    if (remap[a.from] < 0 || remap[a.to] < 0) continue;
    arcRemap[i] = arcs.length;
    arcs.push({ ...a, from: remap[a.from], to: remap[a.to] });
  }
  for (let i = 0; i < g.arcs.length; i++) {
    const j = arcRemap[i];
    if (j < 0) continue;
    const t = g.arcs[i].twin;
    arcs[j].twin = t >= 0 ? arcRemap[t] : -1;
  }

  let droppedResidentialM = 0;
  for (let i = 0; i < g.arcs.length; i++) {
    const a = g.arcs[i];
    if (arcRemap[i] >= 0 || !RESIDENTIAL.has(a.cls)) continue;
    if (a.twin >= 0 && a.twin < i) continue;
    droppedResidentialM += a.lenM;
  }

  const exits = new Set<number>();
  for (const v of exitSet) exits.add(remap[v]);

  return { graph: { nodes, arcs, exits }, droppedNodes, droppedResidentialM };
}

// ---------------------------------------------------------------- §4 step 12: write

export function toBuilder(
  g: Graph,
  pop: Float64Array,
  carlessShare: number,
  buildings: BuildingRec[] = [],
): CityBuilder {
  const b = new CityBuilder();
  for (const [lat, lon] of g.nodes) b.node(lat, lon);
  const idx = g.arcs.map((a) =>
    b.edge(a.from, a.to, {
      cls: a.cls,
      lanes: a.lanes,
      speedKmh: a.speedKmh,
      name: a.name,
      bridge: a.bridge,
      tunnel: a.tunnel,
      oneway: a.oneway,
      geom: a.geom,
    }),
  );
  for (let i = 0; i < g.arcs.length; i++) {
    const t = g.arcs[i].twin;
    if (t > i) b.twin(idx[i], idx[t]);
  }
  for (const v of g.exits) b.exit(v);
  for (let v = 0; v < pop.length; v++) {
    if (pop[v] > 0) b.source(v, pop[v], pop[v] * carlessShare, 0);
  }
  for (const bl of buildings) b.building(bl.node, bl.lat, bl.lon);
  return b;
}

// ---------------------------------------------------------------- CLI

function main(cityId: string): void {
  const cfg = JSON.parse(readFileSync(`tools/cities/${cityId}.json`, 'utf8')) as CityConfig;
  if (cfg.popMode !== 'roadlength') {
    throw new Error(`popMode ${cfg.popMode}: only 'roadlength' is implemented (§4 step 8)`);
  }
  const ex = JSON.parse(readFileSync(`data/extract/${cityId}.json`, 'utf8')) as Extract;

  const coord = new Map<number, LatLng>();
  for (let i = 0; i < ex.nodes.id.length; i++) {
    coord.set(ex.nodes.id[i], [ex.nodes.lat[i] / 1e7, ex.nodes.lon[i] / 1e7]);
  }

  const { runs, stubs } = clipWays(ex.ways, coord, cfg.bbox, exitPredicate(cfg.exits));
  const vertices = vertexNodes(runs, stubs);
  let g = buildArcs(runs, coord, vertices, stubs, inferLanes(runs));
  g = splitLongArcs(g);
  const pruned = pruneToLargestComponent(g);
  const pop = assignPopulation(pruned.graph, cfg.population);

  const bld = assignBuildings(pruned.graph, pop, ex.buildings ?? { lat: [], lon: [] });

  const carlessShare = cfg.carlessShare ?? 0;
  const b = toBuilder(pruned.graph, pop, carlessShare, bld.buildings);
  const buf = b.serialize();
  const city = parseCity(buf);
  const errs = validateCity(city);
  if (errs.length > 0) {
    for (const e of errs) console.error('  invalid:', e);
    throw new Error(`${cityId}: ${errs.length} validator errors (§3.3)`);
  }

  let population = 0;
  let carlessPeople = 0;
  for (let i = 0; i < city.S; i++) {
    population += city.srcPop[i];
    carlessPeople += city.srcNoCar[i];
  }

  const notes: string[] = [
    `Population: ${cfg.populationSource}; roadlength mode (§4 step 8).`,
    cfg.carlessSource ? `Carless: ${cfg.carlessSource}.` : 'Carless: no census data, zeros recorded (§4 step 9).',
    cfg.exits === 'auto'
      ? 'Exits found automatically where motorway/trunk/primary roads cross the bbox.'
      : `Exits listed by name (§4 step 7): ${cfg.exits.join(', ')}.`,
    `Tarjan (§3.3.8) dropped ${pruned.droppedNodes} vertices and ${(pruned.droppedResidentialM / 1000).toFixed(1)} km of residential streets not connected to the city.`,
    `OSM buildings attached to demand nodes: ${bld.buildings.length}; dropped beyond ${BUILDING_RADIUS_M} m: ${bld.dropped}.`,
  ];

  const meta: CityMeta = {
    id: cfg.id,
    name: cfg.name,
    blurb: cfg.blurb,
    center: cfg.center,
    zoom: cfg.zoom,
    bytes: buf.byteLength,
    nodes: city.V,
    edges: city.E,
    population: Math.round(population),
    carlessPeople: Math.round(carlessPeople),
    exits: city.X,
    zones: [''],
    unassignedPop: 0,
    smallCity: cfg.smallCity,
    notes: notes.join(' '),
  };

  writeFileSync(`public/cities/${cfg.id}.bin`, Buffer.from(buf));
  writeFileSync(`public/cities/${cfg.id}.json`, `${JSON.stringify(meta, null, 2)}\n`);
  upsertCatalogue([meta], true);

  console.log(
    `${cfg.id}: V=${city.V} E=${city.E} S=${city.S} X=${city.X} ` +
      `B=${city.B} pop=${meta.population} dropped=${pruned.droppedNodes} nodes / ${(pruned.droppedResidentialM / 1000).toFixed(1)} km ` +
      `${(buf.byteLength / 1024).toFixed(0)} KB`,
  );
}

if (process.argv[1]?.endsWith('preprocess.ts')) {
  const id = process.argv[2];
  if (!id) {
    console.log('usage: node tools/preprocess.ts <cityId>');
    process.exit(2);
  }
  main(id);
}
