// The presets of CONTRACTS.md §18, generated rather than hand-typed.
//
// The Paradise scenarios name edges by id, and an edge id means nothing to a reader. Deriving
// them here from the road names and the routing field keeps the derivation in one auditable
// place, and lets test/validation.test.ts judge the very files the app serves instead of a
// second copy of the same intent.
//
//     node tools/scenarios.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { FLAG, parseCity } from '../src/core/city.ts';
import { polylineLengthM } from './preprocess.ts';
import { defaultScenario } from '../src/core/scenario.ts';
import { resolveParams } from '../src/core/scenario.ts';
import { createSim } from '../src/core/sim.ts';
import type { City, Edit, Scenario } from '../src/core/types.ts';

function city(id: string): City {
  const b = readFileSync(`public/cities/${id}.bin`);
  return parseCity(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
}

function edgesNamed(c: City, name: string): number[] {
  const out: number[] = [];
  for (let e = 0; e < c.E; e++) if (c.nameOf(e) === name) out.push(e);
  return out;
}

/** The last edge of an artery before it leaves town -- what "this road is no longer a way
 *  out" means. Closing the whole road instead severs the driveways hanging off it, which a
 *  burnover at one point did not: measured, it strands 1209 vehicles against 1. */
function exitEdgeOf(c: City, name: string): number {
  const e = edgesNamed(c, name).find((i) => c.flags[i] & FLAG.EXIT_EDGE);
  if (e === undefined) throw new Error(`${name} does not reach an exit`);
  return e;
}

/**
 * Every edge that leaves town at the same crossing as the road named `name`.
 *
 * A bridge arrives at the city line as more than one OSM way: the Bay Bridge is the five-lane
 * deck plus a one-lane ramp off Yerba Buena, and they land on two different exit nodes forty
 * metres apart. Closing only the named one leaves a lane open on a bridge the scenario says
 * is gone.
 */
function crossingEdges(c: City, name: string, radiusM = 400): number[] {
  const isExitEdge = (e: number): boolean => (c.flags[e] & FLAG.EXIT_EDGE) !== 0;
  const at = (e: number): [number, number] => {
    const v = c.edgeTo[e];
    return [c.lat[v] / 1e7, c.lon[v] / 1e7];
  };
  const anchors: [number, number][] = [];
  for (let e = 0; e < c.E; e++) if (isExitEdge(e) && c.nameOf(e) === name) anchors.push(at(e));
  if (anchors.length === 0) throw new Error(`${name} does not reach an exit`);

  const out: number[] = [];
  for (let e = 0; e < c.E; e++) {
    if (!isExitEdge(e)) continue;
    const p = at(e);
    if (anchors.some((a) => polylineLengthM([a, p]) <= radiusM)) out.push(e);
  }
  return out;
}

/**
 * Skyway southbound at four lanes, northbound closed -- NIST TN 2252 Table 6, whose caption
 * says its lane counts already account for contraflow.
 *
 * Not the `contraflow` op: near the town line Skyway is a divided highway, its two
 * carriageways are separate OSM ways, and §9.3 takes lanes from a `twin` that a divided
 * carriageway does not have. Spelled out as lanes + close it is the same intervention and
 * the JSON says plainly what it does.
 */
function skywayContraflow(c: City): Edit[] {
  const p = resolveParams(defaultScenario('paradise'));
  const { cost } = createSim(c, p).field;
  const outbound = (e: number): boolean => cost[c.edgeTo[e]] < cost[c.edgeFrom[e]];
  const sky = edgesNamed(c, 'Skyway');
  return [
    ...sky.filter(outbound).map((e) => ({ op: 'lanes' as const, edgeId: e, lanes: 4 })),
    ...sky.filter((e) => !outbound(e)).map((e) => ({ op: 'close' as const, edgeId: e })),
  ];
}

/**
 * Zero of model time is 08:00 on 8 November 2018 (TF-ET 2).
 *
 * Built from the timeline in docs/VALIDATION.md §2.1, NOT from Table 29. The table's
 * per-artery, 15-minute schedule has to be transcribed from the PDF itself, and the PDF is
 * not in this repository -- reconstructing it from a text layer would be invention. Every
 * verdict that depends on this schedule is provisional and says so.
 */
function campFireClosures(c: City): Edit[] {
  const clark = exitEdgeOf(c, 'Clark Road');
  return [
    { op: 'close', edgeId: exitEdgeOf(c, 'Pentz Road'), atMin: 45 }, // 08:45 burnover
    { op: 'close', edgeId: clark, atMin: 120 }, // 10:00 burnover
    { op: 'close', edgeId: exitEdgeOf(c, 'Neal Road'), atMin: 270 }, // 12:30 burnover
    { op: 'lanes', edgeId: clark, lanes: c.lanes[clark], atMin: 300 }, // 13:00 reopened
  ];
}

const index: Array<{ id: string; city: string; label: string }> = [];

/** The label is written here rather than in the app: the file and the sentence that describes
 *  it are derived from the same place, so a renamed preset cannot keep an old description. */
function write(name: string, label: string, s: Scenario): void {
  writeFileSync(`public/scenarios/${name}.json`, JSON.stringify(s, null, 2) + '\n');
  index.push({ id: name, city: s.city, label });
  console.log(`${name}: ${s.edits.length} edits`);
}

const paradise = city('paradise');
const contraflow = skywayContraflow(paradise);

write('paradise-2018', 'Paradise, 8 Nov 2018 — as it happened', {
  ...defaultScenario('paradise'),
  edits: [...contraflow, ...campFireClosures(paradise)],
});
write('paradise-no-contraflow', 'Paradise — without the contraflow', {
  ...defaultScenario('paradise'),
  edits: campFireClosures(paradise),
});
write('paradise-open-network', 'Paradise — if the fire had closed nothing', {
  ...defaultScenario('paradise'),
  edits: contraflow,
});
write('mercer-baseline', 'Mercer Island — the small case', defaultScenario('mercer'));

const sf = city('sf');
// I-80 carries the ceremonial name of the Interstate system in OSM; the deck of the Bay
// Bridge is tagged with it and not with the bridge's own name.
const bayBridge = crossingEdges(sf, 'Dwight D. Eisenhower Highway');
write('sf-baseline', 'San Francisco — everything open', defaultScenario('sf'));
write('sf-bridge-closed', 'San Francisco — Bay Bridge closed', {
  ...defaultScenario('sf'),
  edits: bayBridge.map((e) => ({ op: 'close' as const, edgeId: e })),
});

writeFileSync('public/scenarios/index.json', JSON.stringify(index, null, 2) + '\n');
console.log(`index.json: ${index.length} presets`);
