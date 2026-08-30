// The single writer of the city.bin format (§3), shared by the synthetic generator (§4bis)
// and the OSM preprocessor (§4). Two independent writers drift apart silently, and they
// drift on the day the format is first amended after the freeze.

import {
  FLAG,
  FORMAT_VERSION,
  GEOM_SCALE,
  HEADER_BYTES,
  MAGIC,
  MAX_EDGE_LEN_M,
  NO_TWIN,
  SECTION,
  SECTION_SLOTS,
} from '../src/core/city.ts';
import { CLASS_CODE, HIGHWAY_CLASSES } from '../src/core/params.ts';
import type { LatLng } from '../src/core/types.ts';

const GEOM_MAX_DELTA = 32767;

export const EARTH_R = 6371008.8;
const D2R = Math.PI / 180;

export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = (b[0] - a[0]) * D2R;
  const dLon = (b[1] - a[1]) * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * D2R) * Math.cos(b[0] * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

export const metresToDegLat = (m: number): number => m / (EARTH_R * D2R);
export const metresToDegLon = (m: number, lat: number): number => m / (EARTH_R * D2R * Math.cos(lat * D2R));

export type EdgeRec = {
  from: number;
  to: number;
  cls: number;
  lanes: number;
  speedKmh: number;
  name: string;
  bridge: boolean;
  tunnel: boolean;
  oneway: boolean;
  exitEdge: boolean;
  geom: LatLng[];
  twinTmp: number;
};

export type EdgeOpts = Partial<Omit<EdgeRec, 'from' | 'to' | 'twinTmp'>>;

export type SourceRec = { node: number; pop: number; noCar: number; zone: number };

/** A building centroid already attached to the node whose driveway it counts as (§4 step 8bis). */
export type BuildingRec = { node: number; lat: number; lon: number };

export class CityBuilder {
  nodes: LatLng[] = [];
  edges: EdgeRec[] = [];
  sources: SourceRec[] = [];
  exitNodes: number[] = [];
  buildings: BuildingRec[] = [];
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
      bridge: Boolean(o.bridge),
      tunnel: Boolean(o.tunnel),
      oneway: Boolean(o.oneway),
      exitEdge: Boolean(o.exitEdge),
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

  /** Marks two arcs as twins. §4 step 3 lets the two directions differ in lanes, so they
   *  cannot always be created through pair(). */
  twin(a: number, b: number): void {
    this.edges[a].twinTmp = b;
    this.edges[b].twinTmp = a;
  }

  source(node: number, pop: number, noCar = 0, zone = 0): void {
    this.sources.push({ node, pop, noCar, zone });
  }

  building(node: number, lat: number, lon: number): void {
    this.buildings.push({ node, lat, lon });
  }

  exit(node: number): void {
    this.exitNodes.push(node);
  }

  serialize(): ArrayBuffer {
    const V = this.nodes.length;
    const E = this.edges.length;

    // CSR requires edges grouped by their tail node.
    const order = [...this.edges.keys()].sort((x, y) => this.edges[x].from - this.edges[y].from || x - y);
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
      if (e.tunnel) f |= FLAG.TUNNEL;
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
        for (;;) {
          let dLat = Math.round((tLat - pLat) / GEOM_SCALE);
          let dLon = Math.round((tLon - pLon) / GEOM_SCALE);
          const reach = Math.max(Math.abs(dLat), Math.abs(dLon));
          // A hop past ~3.6 km overflows Int16. §3.2 says densify -- insert a point and write
          // two deltas. Splitting the EDGE instead would shift indices, and the stable edgeIds
          // of §9.2 are built on them.
          if (reach > GEOM_MAX_DELTA) {
            const steps = Math.ceil(reach / GEOM_MAX_DELTA);
            dLat = Math.round(dLat / steps);
            dLon = Math.round(dLon / steps);
          }
          geomPts.push(dLat, dLon);
          pLat += dLat * GEOM_SCALE;
          pLon += dLon * GEOM_SCALE;
          poly.push([pLat / 1e7, pLon / 1e7]);
          if (reach <= GEOM_MAX_DELTA) break;
        }
      }
      poly.push(this.nodes[e.to]);

      let L = 0;
      for (let k = 1; k < poly.length; k++) L += haversineM(poly[k - 1], poly[k]);
      const len = Math.max(1, Math.round(L));
      // Clamping would make the file lie about distance instead of failing: §3.3.7 wants such
      // an edge split by a fictitious vertex, upstream, where topology may still change.
      if (len > MAX_EDGE_LEN_M) {
        throw new Error(`edge ${i}: ${len} m over the ${MAX_EDGE_LEN_M} m limit, split it (§3.3.7)`);
      }
      lenM[i] = len;
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

    const blob = new TextEncoder().encode(`${this.names.join('\0')}\0`);
    const NS = blob.length;

    const latI = new Int32Array(V);
    const lonI = new Int32Array(V);
    let minLat = Number.POSITIVE_INFINITY;
    let minLon = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    let maxLon = Number.NEGATIVE_INFINITY;
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

    // Absent, not empty, when there are no buildings: an offset of 0 is what tells parseCity
    // the file predates the section, and the synthetic fixtures rely on staying byte-identical.
    if (this.buildings.length > 0) {
      const bldOff = new Uint32Array(V + 1);
      for (const b of this.buildings) bldOff[b.node + 1]++;
      for (let v = 0; v < V; v++) bldOff[v + 1] += bldOff[v];
      const cur = Uint32Array.from(bldOff.subarray(0, V));
      const bldPts = new Int16Array(this.buildings.length * 2);
      for (const b of this.buildings) {
        const dLat = Math.round((Math.round(b.lat * 1e7) - latI[b.node]) / GEOM_SCALE);
        const dLon = Math.round((Math.round(b.lon * 1e7) - lonI[b.node]) / GEOM_SCALE);
        if (Math.abs(dLat) > GEOM_MAX_DELTA || Math.abs(dLon) > GEOM_MAX_DELTA) {
          throw new Error(`building at ${b.lat},${b.lon} is too far from node ${b.node} for Int16`);
        }
        const k = cur[b.node]++;
        bldPts[k * 2] = dLat;
        bldPts[k * 2 + 1] = dLon;
      }
      parts[SECTION.BLD_OFF] = bldOff;
      parts[SECTION.BLD_PTS] = bldPts;
    }

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
