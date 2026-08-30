// The OSM preprocessor, CONTRACTS.md §4 steps 2-11. Every step is checked on a graph of a
// few nodes: a .pbf takes ten seconds to read and tells you nothing about which of the twelve
// steps got it wrong.

import { describe, it, expect } from 'vitest';
import {
  buildArcs,
  classCode,
  clipWays,
  direction,
  exitPredicate,
  lanes,
  polylineLengthM,
  pruneToLargestComponent,
  assignPopulation,
  assignBuildings,
  BUILDING_RADIUS_M,
  splitLongArcs,
  vertexNodes,
} from '../tools/preprocess.ts';
import type { Bbox, Extract, Graph, Tags } from '../tools/preprocess.ts';
import { CLASS_CODE } from '../src/core/params.ts';
import { MAX_EDGE_LEN_M } from '../src/core/city.ts';
import type { LatLng } from '../src/core/types.ts';

const BBOX: Bbox = [0, 0, 1, 1];

/** Nodes on a line of latitude, one per 0.01 degree, so lengths are ~1.1 km apart. */
function coords(ids: number[], lon0 = 0.1): Map<number, LatLng> {
  const m = new Map<number, LatLng>();
  ids.forEach((id, i) => m.set(id, [0.5, lon0 + i * 0.01]));
  return m;
}

const way = (i: number, r: number[], t: Tags): Extract['ways'][number] => ({ i, r, t });

// -------------------------------------------------------------------- step 4: tags

describe('§4 step 4: tags to numbers', () => {
  it('maps highway classes, and links to the link class', () => {
    expect(classCode('motorway')).toBe(CLASS_CODE.motorway);
    expect(classCode('residential')).toBe(CLASS_CODE.residential);
    expect(classCode('motorway_link')).toBe(CLASS_CODE.link);
    expect(classCode('tertiary_link')).toBe(CLASS_CODE.link);
  });

  it('reads lanes:forward, then lanes split by direction, then the class default', () => {
    expect(lanes({ highway: 'primary', 'lanes:forward': '3', lanes: '6' }, 'forward')).toBe(3);
    expect(lanes({ highway: 'primary', lanes: '4' }, 'forward')).toBe(2); // two-way: halved
    expect(lanes({ highway: 'primary', lanes: '4', oneway: 'yes' }, 'forward')).toBe(4);
    expect(lanes({ highway: 'residential' }, 'forward')).toBe(1);
    expect(lanes({ highway: 'motorway' }, 'forward')).toBe(2);
  });

  it('never returns zero lanes, whatever the tag says', () => {
    expect(lanes({ highway: 'residential', lanes: '1' }, 'forward')).toBe(1); // 1/2 rounds to 0
    expect(lanes({ highway: 'residential', lanes: 'odd' }, 'forward')).toBe(1);
  });

  it('reads oneway in both spellings and treats an untagged roundabout as one-way', () => {
    expect(direction({ highway: 'residential' })).toBe('both');
    expect(direction({ highway: 'residential', oneway: 'yes' })).toBe('forward');
    expect(direction({ highway: 'residential', oneway: '-1' })).toBe('backward');
    expect(direction({ highway: 'residential', junction: 'roundabout' })).toBe('forward');
    // An explicit tag wins over the roundabout convention.
    expect(direction({ highway: 'residential', junction: 'roundabout', oneway: 'no' })).toBe('both');
  });
});

describe('§4 step 7: which ways may reach past the border', () => {
  it('by class, when exits are auto', () => {
    const p = exitPredicate('auto');
    expect(p({ highway: 'motorway' })).toBe(true);
    expect(p({ highway: 'secondary', name: 'Skyway' })).toBe(false);
  });

  // Paradise: no road in town is above `secondary`, and two of the four evacuation arteries
  // are `tertiary`. By class the town would have no exits at all.
  it('by name or ref, whatever the class', () => {
    const p = exitPredicate(['Skyway', 'CA 70']);
    expect(p({ highway: 'secondary', name: 'Skyway' })).toBe(true);
    expect(p({ highway: 'tertiary', name: 'skyway' })).toBe(true);
    expect(p({ highway: 'primary', ref: 'CA 70' })).toBe(true);
    expect(p({ highway: 'motorway', name: 'Nunneley Road' })).toBe(false);
    expect(p({ highway: 'residential' })).toBe(false);
  });
});

// -------------------------------------------------------------------- steps 1-2: clip, collapse

describe('§4 steps 1-2: clipping and collapsing', () => {
  it('keeps the run inside the bbox and, for an exit-class road, one node past the border', () => {
    const c = coords([1, 2, 3, 4]);
    c.set(4, [0.5, 1.5]); // outside
    const { runs, stubs } = clipWays(
      [way(10, [1, 2, 3, 4], { highway: 'motorway' }), way(11, [1, 2, 3, 4], { highway: 'residential' })],
      c,
      BBOX,
    );
    expect(runs[0].refs).toEqual([1, 2, 3, 4]); // motorway reaches out
    expect(runs[1].refs).toEqual([1, 2, 3]); // residential stops at the border
    expect([...stubs]).toEqual([4]);
  });

  it('a node used by two ways becomes a vertex; the rest is geometry', () => {
    const c = coords([1, 2, 3, 4, 5]);
    const { runs, stubs } = clipWays(
      [way(10, [1, 2, 3], { highway: 'residential' }), way(11, [3, 4, 5], { highway: 'residential' })],
      c,
      BBOX,
    );
    const v = vertexNodes(runs, stubs);
    expect([...v].sort((a, b) => a - b)).toEqual([1, 3, 5]);
    expect(v.has(2)).toBe(false);

    const g = buildArcs(runs, c, v);
    expect(g.nodes).toHaveLength(3);
    expect(g.arcs).toHaveLength(4); // two streets, both ways
    const fwd = g.arcs.find((a) => a.from === 0 && a.to === 1)!;
    expect(fwd.geom).toHaveLength(1); // node 2 survives as an intermediate point
    expect(fwd.lenM).toBeCloseTo(polylineLengthM([c.get(1)!, c.get(2)!, c.get(3)!]), 6);
  });

  it('gives the two directions independent lanes and pairs them as twins', () => {
    const c = coords([1, 2]);
    const { runs, stubs } = clipWays(
      [way(10, [1, 2], { highway: 'primary', 'lanes:forward': '3', 'lanes:backward': '1' })],
      c,
      BBOX,
    );
    const g = buildArcs(runs, c, vertexNodes(runs, stubs));
    expect(g.arcs).toHaveLength(2);
    expect(g.arcs[0].lanes).toBe(3);
    expect(g.arcs[1].lanes).toBe(1);
    expect(g.arcs[0].twin).toBe(1);
    expect(g.arcs[1].twin).toBe(0);
  });

  it('oneway=-1 produces the reverse arc only', () => {
    const c = coords([1, 2]);
    const { runs, stubs } = clipWays([way(10, [1, 2], { highway: 'residential', oneway: '-1' })], c, BBOX);
    const g = buildArcs(runs, c, vertexNodes(runs, stubs));
    expect(g.arcs).toHaveLength(1);
    expect(g.nodes[g.arcs[0].from]).toEqual(c.get(2));
    expect(g.arcs[0].twin).toBe(-1);
  });
});

// -------------------------------------------------------------------- step 6: long edges

describe('§4 step 6: an edge longer than 60 km is split, not clamped', () => {
  it('splits into equal pieces and keeps every piece under the limit', () => {
    const nodes: LatLng[] = [
      [0, 0],
      [0, 2],
    ]; // ~222 km apart
    const g: Graph = {
      nodes,
      arcs: [
        {
          from: 0,
          to: 1,
          cls: CLASS_CODE.motorway,
          lanes: 2,
          speedKmh: 100,
          name: 'long',
          bridge: false,
          tunnel: false,
          oneway: true,
          geom: [
            [0, 0.5],
            [0, 1],
            [0, 1.5],
          ],
          lenM: polylineLengthM([
            [0, 0],
            [0, 0.5],
            [0, 1],
            [0, 1.5],
            [0, 2],
          ]),
          twin: -1,
        },
      ],
      exits: new Set(),
    };
    const out = splitLongArcs(g);
    expect(out.arcs.length).toBeGreaterThan(1);
    for (const a of out.arcs) expect(a.lenM).toBeLessThanOrEqual(MAX_EDGE_LEN_M);
    const total = out.arcs.reduce((s, a) => s + a.lenM, 0);
    expect(total).toBeCloseTo(g.arcs[0].lenM, 0);
    expect(out.arcs[0].from).toBe(0);
    expect(out.arcs[out.arcs.length - 1].to).toBe(1);
  });

  it('leaves a short edge exactly as it was', () => {
    const c = coords([1, 2]);
    const { runs, stubs } = clipWays([way(10, [1, 2], { highway: 'residential' })], c, BBOX);
    const g = buildArcs(runs, c, vertexNodes(runs, stubs));
    expect(splitLongArcs(g).arcs).toEqual(g.arcs);
  });
});

// -------------------------------------------------------------------- steps 8, 11

describe('§4 steps 8 and 11: population and Tarjan', () => {
  /** Two streets in a row plus an exit stub past the border, and a detached fragment. */
  function town(): Graph {
    const c = coords([1, 2, 3, 9, 8]);
    c.set(3, [0.5, 1.5]); // the stub, outside the bbox
    c.set(9, [0.9, 0.9]); // a fragment connected to nothing
    c.set(8, [0.9, 0.91]);
    const { runs, stubs } = clipWays(
      [
        way(10, [1, 2], { highway: 'residential' }),
        way(11, [2, 3], { highway: 'primary' }),
        way(12, [9, 8], { highway: 'residential' }),
      ],
      c,
      BBOX,
    );
    return buildArcs(runs, c, vertexNodes(runs, stubs), stubs);
  }

  it('drops the fragment that cannot reach an exit and moves the exit onto the frontier', () => {
    const g = town();
    expect(g.nodes).toHaveLength(5);
    const pruned = pruneToLargestComponent(g);
    expect(pruned.droppedNodes).toBe(2); // the detached pair
    expect(pruned.graph.exits.size).toBe(1);
    expect(pruned.droppedResidentialM).toBeGreaterThan(0);
  });

  it('hands the whole census total to the surviving streets', () => {
    const pruned = pruneToLargestComponent(town());
    const pop = assignPopulation(pruned.graph, 1000);
    let sum = 0;
    for (const p of pop) sum += p;
    expect(sum).toBeCloseTo(1000, 6);
  });

  it('gives an exit no population: §3.3.11 keeps sources and exits disjoint', () => {
    const pruned = pruneToLargestComponent(town());
    const pop = assignPopulation(pruned.graph, 1000);
    for (const v of pruned.graph.exits) expect(pop[v]).toBe(0);
  });

  it('splits between two residential streets in proportion to their length', () => {
    const c = new Map<number, LatLng>([
      [1, [0.5, 0.1]],
      [2, [0.5, 0.2]],
      [3, [0.5, 0.5]], // three times as far
      [4, [0.5, 1.5]],
    ]);
    const { runs, stubs } = clipWays(
      [
        way(10, [1, 2], { highway: 'residential' }),
        way(11, [2, 3], { highway: 'residential' }),
        way(12, [3, 4], { highway: 'primary' }),
      ],
      c,
      BBOX,
    );
    const g = buildArcs(runs, c, vertexNodes(runs, stubs), stubs);
    const pop = assignPopulation(pruneToLargestComponent(g).graph, 800);
    // Node 1 touches only the short street, node 3 only the long one, node 2 touches both.
    expect(pop[0] / pop[2]).toBeCloseTo(1 / 3, 2);
  });
});

describe('§4 step 8bis: buildings attach to the node that releases their cars', () => {
  /** metres north of the equator, as a latitude. */
  const north = (m: number): number => m / 111320;

  function twoStreets(): { g: Graph; pop: Float64Array } {
    const c = new Map<number, LatLng>([
      [1, [0.5, 0.1]],
      [2, [0.5, 0.2]],
      [3, [0.5, 1.5]],
    ]);
    const { runs, stubs } = clipWays(
      [
        way(10, [1, 2], { highway: 'residential' }),
        way(11, [2, 3], { highway: 'primary' }),
      ],
      c,
      BBOX,
    );
    const g = pruneToLargestComponent(buildArcs(runs, c, vertexNodes(runs, stubs), stubs)).graph;
    return { g, pop: assignPopulation(g, 1000) };
  }

  it('takes the nearest node carrying demand', () => {
    const { g, pop } = twoStreets();
    const near0 = [g.nodes[0][0] + north(20), g.nodes[0][1]];
    const near1 = [g.nodes[1][0] - north(15), g.nodes[1][1]];
    const r = assignBuildings(g, pop, {
      lat: [Math.round(near0[0] * 1e7), Math.round(near1[0] * 1e7)],
      lon: [Math.round(near0[1] * 1e7), Math.round(near1[1] * 1e7)],
    });
    expect(r.dropped).toBe(0);
    expect(r.buildings.map((b) => b.node)).toEqual([0, 1]);
  });

  it('drops a building further than the radius from every demand node', () => {
    const { g, pop } = twoStreets();
    const far = g.nodes[0][0] + north(BUILDING_RADIUS_M + 50);
    const r = assignBuildings(g, pop, {
      lat: [Math.round(far * 1e7)],
      lon: [Math.round(g.nodes[0][1] * 1e7)],
    });
    expect(r.buildings).toHaveLength(0);
    expect(r.dropped).toBe(1);
  });

  it('never attaches to an exit, which carries no demand and would strand the dot', () => {
    const { g, pop } = twoStreets();
    const [x] = [...g.exits];
    const r = assignBuildings(g, pop, {
      lat: [Math.round(g.nodes[x][0] * 1e7)],
      lon: [Math.round(g.nodes[x][1] * 1e7)],
    });
    for (const b of r.buildings) expect(pop[b.node]).toBeGreaterThan(0);
  });

  it('a city with no building section yields none and drops none', () => {
    const { g, pop } = twoStreets();
    expect(assignBuildings(g, pop, { lat: [], lon: [] })).toEqual({ buildings: [], dropped: 0 });
  });
});
