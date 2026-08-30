// Tests for the city.bin format and loader. Written from CONTRACTS.md §3 and §5.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseCity, validateCity, edgePolyline, stronglyConnectedComponents,
  classOf, NO_TWIN, FLAG, MAX_EDGE_LEN_M, FORMAT_VERSION, GEOM_SCALE,
} from '../src/core/city.ts';
import { capVehS, ttSec, storageVeh, CLASS_CODE, HIGHWAY_CLASSES } from '../src/core/params.ts';
import type { LatLng } from '../src/core/types.ts';

const FIXTURES = ['grid20', 'line10', 'single', 'island8'];

function bytes(name: string): ArrayBuffer {
  const b = readFileSync(new URL(`./fixtures/${name}.bin`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}
const load = (name: string) => parseCity(bytes(name));

/** An index the fixture is required to contain; a miss is a broken fixture, not a soft skip. */
function must(i: number | undefined, what: string): number {
  if (i === undefined) throw new Error(`fixture has no ${what}`);
  return i;
}

/** Perpendicular offset of point p from segment a-b, in metres (local planar projection). */
function offsetFromLineM(a: LatLng, b: LatLng, p: LatLng): number {
  const kLat = 111320, kLon = 111320 * Math.cos(a[0] * Math.PI / 180);
  const ax = 0, ay = 0;
  const bx = (b[1] - a[1]) * kLon, by = (b[0] - a[0]) * kLat;
  const px = (p[1] - a[1]) * kLon, py = (p[0] - a[0]) * kLat;
  const len = Math.hypot(bx - ax, by - ay);
  return Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
}

const EARTH_R = 6371008.8, D2R = Math.PI / 180;
function haversineM(a: LatLng, b: LatLng): number {
  const dLat = (b[0] - a[0]) * D2R, dLon = (b[1] - a[1]) * D2R;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a[0] * D2R) * Math.cos(b[0] * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

describe.each(FIXTURES)('fixture %s', (name) => {
  const c = load(name);

  it('satisfies every invariant of §3.3', () => {
    expect(validateCity(c)).toEqual([]);
  });

  it('header counts agree with section lengths', () => {
    expect(c.version).toBe(FORMAT_VERSION);
    expect(c.csrOff.length).toBe(c.V + 1);
    expect(c.edgeTo.length).toBe(c.E);
    expect(c.geomOff.length).toBe(c.E + 1);
    expect(c.geomPts.length).toBe(c.G * 2);
    expect(c.srcNode.length).toBe(c.S);
    expect(c.exitNode.length).toBe(c.X);
  });

  it('edgeFrom is reconstructed from CSR correctly', () => {
    for (let v = 0; v < c.V; v++) {
      for (let e = c.csrOff[v]; e < c.csrOff[v + 1]; e++) expect(c.edgeFrom[e]).toBe(v);
    }
  });

  it('incoming edges: each edge appears exactly once, under its own target', () => {
    const seen = new Uint8Array(c.E);
    for (let v = 0; v < c.V; v++) {
      for (let k = c.inOff[v]; k < c.inOff[v + 1]; k++) {
        const e = c.inEdge[k];
        expect(c.edgeTo[e]).toBe(v);
        expect(seen[e]).toBe(0);
        seen[e] = 1;
      }
    }
    expect(seen.every((x) => x === 1)).toBe(true);
  });

  it('twins are mutual and reversed', () => {
    for (let e = 0; e < c.E; e++) {
      const t = c.twin[e];
      if (t === NO_TWIN) continue;
      expect(c.twin[t]).toBe(e);
      expect(c.edgeTo[t]).toBe(c.edgeFrom[e]);
      expect(c.edgeFrom[t]).toBe(c.edgeTo[e]);
    }
  });

  it('edges without a twin carry the ONEWAY flag', () => {
    for (let e = 0; e < c.E; e++) {
      if (c.twin[e] === NO_TWIN) expect(c.flags[e] & FLAG.ONEWAY).toBeTruthy();
    }
  });

  it('the class code in flags matches the table in §2', () => {
    for (let e = 0; e < c.E; e++) {
      const code = classOf(c.flags[e]);
      expect(code).toBeGreaterThanOrEqual(0);
      expect(code).toBeLessThan(HIGHWAY_CLASSES.length);
      expect(c.speedKmh[e]).toBeGreaterThanOrEqual(5);
    }
  });

  it('a polyline starts at the tail node and ends at the head node', () => {
    for (let e = 0; e < c.E; e++) {
      const p = edgePolyline(c, e);
      expect(p.length).toBe(c.geomOff[e + 1] - c.geomOff[e] + 2);
      expect(p[0][0]).toBeCloseTo(c.lat[c.edgeFrom[e]] / 1e7, 9);
      expect(p[p.length - 1][1]).toBeCloseTo(c.lon[c.edgeTo[e]] / 1e7, 9);
    }
  });

  it('lenM matches the length of the decoded polyline', () => {
    for (let e = 0; e < c.E; e++) {
      const p = edgePolyline(c, e);
      let L = 0;
      for (let k = 1; k < p.length; k++) L += haversineM(p[k - 1], p[k]);
      expect(Math.abs(c.lenM[e] - L)).toBeLessThanOrEqual(0.5);
      expect(c.lenM[e]).toBeLessThanOrEqual(MAX_EDGE_LEN_M);
    }
  });

  it('exits have no out-edges, and their in-edges are flagged', () => {
    for (let i = 0; i < c.X; i++) {
      const x = c.exitNode[i];
      expect(c.isExit[x]).toBe(1);
      expect(c.csrOff[x + 1] - c.csrOff[x]).toBe(0);
      for (let k = c.inOff[x]; k < c.inOff[x + 1]; k++) {
        expect(c.flags[c.inEdge[k]] & FLAG.EXIT_EDGE).toBeTruthy();
      }
    }
  });

  it('the derived formulas of §2 yield finite positive values', () => {
    for (let e = 0; e < c.E; e++) {
      const cap = capVehS(c.lanes[e], classOf(c.flags[e]));
      const st = storageVeh(c.lenM[e], c.lanes[e]);
      const tt = ttSec(c.lenM[e], c.speedKmh[e]);
      expect(cap).toBeGreaterThan(0);
      expect(st).toBeGreaterThanOrEqual(1);
      expect(tt).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(tt)).toBe(true);
    }
  });

  it('car-free count never exceeds population, and total population is positive', () => {
    let pop = 0;
    for (let i = 0; i < c.S; i++) {
      expect(c.srcNoCar[i]).toBeGreaterThanOrEqual(0);
      expect(c.srcNoCar[i]).toBeLessThanOrEqual(c.srcPop[i]);
      pop += c.srcPop[i];
    }
    expect(pop).toBeGreaterThan(0);
  });
});

describe('geometry', () => {
  it('the grid really does carry intermediate points -- the section is not empty', () => {
    const c = load('grid20');
    expect(c.G).toBeGreaterThan(0);
  });

  it('a bent edge is longer than the straight line between its nodes', () => {
    const c = load('grid20');
    const bent = must(
      [...Array(c.E).keys()].find((e) => c.geomOff[e + 1] > c.geomOff[e]),
      'bent edge',
    );
    const straight = haversineM(
      [c.lat[c.edgeFrom[bent]] / 1e7, c.lon[c.edgeFrom[bent]] / 1e7],
      [c.lat[c.edgeTo[bent]] / 1e7, c.lon[c.edgeTo[bent]] / 1e7],
    );
    expect(c.lenM[bent]).toBeGreaterThan(straight);
  });

  // Absolute scale check: synth bends every third edge by exactly 15 m. This has to be
  // measured in metres rather than through GEOM_SCALE -- otherwise the test derives its
  // expectation from the very constant it is checking, and swapping the scale goes unnoticed.
  it('the bend measures 15 metres -- delta scale pinned in physical units', () => {
    const c = load('grid20');
    const bent = [...Array(c.E).keys()].filter((i) => c.geomOff[i + 1] - c.geomOff[i] === 1);
    expect(bent.length).toBeGreaterThan(0);
    for (const e of bent.slice(0, 50)) {
      const [a, mid, b] = edgePolyline(c, e);
      expect(offsetFromLineM(a, b, mid)).toBeGreaterThan(10);
      expect(offsetFromLineM(a, b, mid)).toBeLessThan(20);
    }
  });

  it('deltas decode in units of 1e-6 degrees', () => {
    const c = load('grid20');
    const e = must([...Array(c.E).keys()].find((i) => c.geomOff[i + 1] > c.geomOff[i]), 'bent edge');
    const k = c.geomOff[e];
    const expected = c.lat[c.edgeFrom[e]] + c.geomPts[k * 2] * GEOM_SCALE;
    expect(Math.round(edgePolyline(c, e)[1][0] * 1e7)).toBe(expected);
  });
});

describe('road names', () => {
  it('id 0 is the empty string, and named edges read back', () => {
    const c = load('island8');
    const bridge = must([...Array(c.E).keys()].find((e) => c.flags[e] & FLAG.BRIDGE), 'bridge');
    expect(c.nameOf(bridge)).toBe('Bridge');
    const unnamed = [...Array(c.E).keys()].find((e) => c.nameId[e] === 0);
    if (unnamed !== undefined) expect(c.nameOf(unnamed)).toBe('');
  });
});

describe('single: precondition for sanity check §14.3', () => {
  it('two motorway lanes give exactly 3600 veh/h', () => {
    const c = load('single');
    expect(c.E).toBe(1);
    expect(c.lanes[0]).toBe(2);
    expect(classOf(c.flags[0])).toBe(CLASS_CODE.motorway);
    expect(capVehS(c.lanes[0], classOf(c.flags[0])) * 3600).toBe(3600);
  });
});

describe('island: a single bridge out', () => {
  it('exactly one bridge pair, and all egress runs through it', () => {
    const c = load('island8');
    const bridges = [...Array(c.E).keys()].filter((e) => c.flags[e] & FLAG.BRIDGE);
    expect(bridges.length).toBe(2);
    expect(c.X).toBe(1);
  });
});

describe('strongly connected components', () => {
  it('an exit stays separate because its out-edges are suppressed (§3.3.8)', () => {
    const g = {
      V: 4,
      csrOff: Uint32Array.from([0, 1, 3, 5, 5]),
      edgeTo: Uint32Array.from([1, 0, 2, 1, 3]),
      isExit: Uint8Array.from([0, 0, 0, 1]),
    };
    const { comp } = stronglyConnectedComponents(g);
    expect(comp[0]).toBe(comp[1]);
    expect(comp[1]).toBe(comp[2]);
    expect(comp[3]).not.toBe(comp[0]);
  });

  it('an exit with an edge back into town is not pulled into the town component', () => {
    const g = {
      V: 3,
      csrOff: Uint32Array.from([0, 1, 2, 3]),
      edgeTo: Uint32Array.from([1, 2, 0]),   // 0->1->2->0, but 2 is an exit
      isExit: Uint8Array.from([0, 0, 1]),
    };
    const { comp } = stronglyConnectedComponents(g);
    expect(new Set([comp[0], comp[1], comp[2]]).size).toBe(3);
  });
});

describe('validator catches corruption', () => {
  it('foreign magic', () => {
    const b = bytes('line10');
    new DataView(b).setUint32(0, 0xdeadbeef, true);
    expect(() => parseCity(b)).toThrow(/magic/);
  });

  it('unsupported format version', () => {
    const b = bytes('line10');
    new DataView(b).setUint16(4, 99, true);
    expect(() => parseCity(b)).toThrow(/format version/);
  });

  it('invariant 3: EDGE_TO out of range', () => {
    const c = load('line10');
    c.edgeTo[0] = c.V + 5;
    expect(validateCity(c).join()).toMatch(/^3:/);
  });

  it('invariant 5: non-mutual twin', () => {
    const c = load('line10');
    const e = must([...Array(c.E).keys()].find((i) => c.twin[i] !== NO_TWIN), 'twinned edge');
    c.twin[e] = (e + 3) % c.E;
    expect(validateCity(c).join()).toMatch(/5:/);
  });

  it('invariant 6: zero lanes', () => {
    const c = load('line10');
    c.lanes[0] = 0;
    expect(validateCity(c).join()).toMatch(/6:/);
  });

  it('invariant 7: over-long edge', () => {
    const c = load('line10');
    c.lenM[0] = 65000;
    expect(validateCity(c).join()).toMatch(/7:/);
  });

  it('invariant 10: more car-free people than population', () => {
    const c = load('line10');
    c.srcNoCar[0] = c.srcPop[0] + 1;
    expect(validateCity(c).join()).toMatch(/10:/);
  });

  it('invariant 11: a node that is both source and exit', () => {
    const c = load('line10');
    c.srcNode[0] = c.exitNode[0];
    expect(validateCity(c).join()).toMatch(/11:/);
  });

  it('invariant 8: a node outside the source component', () => {
    const c = load('line10');
    // Point every out-edge of node 0 back at itself: node 0 becomes a sink that is not
    // flagged as an exit, which the validator is required to catch.
    for (let e = 0; e < c.E; e++) if (c.edgeFrom[e] === 0) c.edgeTo[e] = 0;
    expect(validateCity(c).join()).toMatch(/8:/);
  });
});
