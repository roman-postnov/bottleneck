// Particles of CONTRACTS.md §13.2: dots per edge proportional to n[e], speed proportional to
// (1 - load). A visualisation, not physics -- a dot that reaches the end of an edge returns to
// the start of the same edge and never continues onto the next one.

import { ScatterplotLayer } from '@deck.gl/layers';
import type { GraphView } from './layers.ts';
import type { Palette } from './palette.ts';

/** Metres of map per second of wall clock at an empty road. Chosen to read, not to be true. */
const FREE_SPEED_M_S = 260;
const MIN_SPEED_FRACTION = 0.04;
/**
 * Dots per vehicle, before the budget claws it back. The count has to be driven by n[e] and
 * not by load: a network is mostly empty even at its worst hour, and scaling dots by load
 * rounded almost every edge to zero -- 239 dots out of a 40 000 budget, measured.
 */
const MAX_DOTS_PER_VEH = 6;

export type ParticleField = {
  cap: number;
  /**
   * Slots are reserved per edge in proportion to `storage`, which never changes, and only the
   * first `active[e]` of them are drawn. Reallocating slots between edges every frame would
   * make the dots jump; this way a dot stays on its edge for the whole run.
   */
  base: Uint32Array;
  quota: Uint32Array;
  active: Uint32Array;
  slotEdge: Uint32Array;
  param: Float32Array;
  speed: Float32Array;
  /** Cumulative metres along each edge's polyline, indexed like the view's vertices. */
  cum: Float32Array;
  edgeLen: Float32Array;
  positions: Float64Array;
  count: number;
};

function cumulative(view: GraphView): { cum: Float32Array; edgeLen: Float32Array } {
  const { positions, startIndices, E, vertexCount } = view;
  const cum = new Float32Array(vertexCount);
  const edgeLen = new Float32Array(E);
  for (let e = 0; e < E; e++) {
    const a = startIndices[e];
    const b = startIndices[e + 1];
    let acc = 0;
    cum[a] = 0;
    for (let k = a + 1; k < b; k++) {
      const lon0 = positions[(k - 1) * 2];
      const lat0 = positions[(k - 1) * 2 + 1];
      const lon1 = positions[k * 2];
      const lat1 = positions[k * 2 + 1];
      const dy = (lat1 - lat0) * 110540;
      const dx = (lon1 - lon0) * 111320 * Math.cos(((lat0 + lat1) / 2) * (Math.PI / 180));
      acc += Math.sqrt(dx * dx + dy * dy);
      cum[k] = acc;
    }
    edgeLen[e] = acc > 1 ? acc : 1;
  }
  return { cum, edgeLen };
}

export function createParticles(view: GraphView, storage: Float32Array, cap: number): ParticleField {
  const E = view.E;
  const { cum, edgeLen } = cumulative(view);

  let total = 0;
  for (let e = 0; e < E; e++) total += storage[e];

  const base = new Uint32Array(E);
  const quota = new Uint32Array(E);
  let used = 0;
  for (let e = 0; e < E; e++) {
    base[e] = used;
    // Slots in proportion to what the edge can hold, so a jammed artery has room for a solid
    // line of dots and a driveway does not. Three at minimum: an edge that can never show a
    // dot reads as a road with no traffic, which is a different statement from a little.
    const q = Math.max(3, Math.round((storage[e] / total) * cap));
    quota[e] = q;
    used += q;
  }

  const slotEdge = new Uint32Array(used);
  const param = new Float32Array(used);
  for (let e = 0; e < E; e++) {
    for (let i = 0; i < quota[e]; i++) {
      const s = base[e] + i;
      slotEdge[s] = e;
      // Spread along the edge instead of bunched at its start, without a random source:
      // §10 keeps Math.random out of the model, and there is no reason to let it in here.
      param[s] = quota[e] === 1 ? 0.5 : i / quota[e];
    }
  }

  return {
    cap,
    base,
    quota,
    active: new Uint32Array(E),
    slotEdge,
    param,
    speed: new Float32Array(E),
    cum,
    edgeLen,
    positions: new Float64Array(used * 2),
    count: 0,
  };
}

/** How many dots each edge shows this frame, and how fast they crawl. */
/**
 * How many dots a whole-city view can carry before it reads as texture instead of as traffic.
 * The budget is per screen, not per edge, and it cannot be derived from zoom: Paradise and San
 * Francisco both open at z12, and San Francisco puts eight times as many edges in the window.
 * Zooming in shows fewer edges, so it can afford more dots on each.
 */
const ON_SCREEN = 6000;
const ZOOM_BASE = 13;

function budgetAt(cap: number, zoom: number): number {
  const factor = zoom > ZOOM_BASE ? 2 ** (zoom - ZOOM_BASE) : 1;
  const want = ON_SCREEN * factor;
  return want < cap ? want : cap;
}

export function step(
  f: ParticleField,
  n: Float32Array,
  storage: Float32Array,
  dtSec: number,
  zoom: number,
): void {
  const E = f.active.length;
  let sumN = 0;
  for (let e = 0; e < E; e++) sumN += n[e];
  // Spend the whole budget when there is little traffic and clip against it when there is a
  // lot; an edge that wants more dots than it has slots ends up a solid line, which is what a
  // jam should look like.
  const budget = budgetAt(f.cap, zoom);
  const gain = Math.min(MAX_DOTS_PER_VEH, budget / (sumN > 1 ? sumN : 1));

  for (let e = 0; e < E; e++) {
    let load = n[e] / storage[e];
    if (!(load > 0)) load = 0;
    else if (load > 1) load = 1;
    const want = Math.round(n[e] * gain);
    f.active[e] = want < f.quota[e] ? want : f.quota[e];
    const frac = 1 - load;
    f.speed[e] = (FREE_SPEED_M_S * (frac > MIN_SPEED_FRACTION ? frac : MIN_SPEED_FRACTION)) / f.edgeLen[e];
  }
  const { slotEdge, param, speed } = f;
  for (let s = 0; s < slotEdge.length; s++) {
    let p = param[s] + speed[slotEdge[s]] * dtSec;
    if (p >= 1) p -= Math.floor(p);
    param[s] = p;
  }
}

/** Compacts the active dots into the position buffer ScatterplotLayer reads. */
export function writePositions(f: ParticleField, view: GraphView): number {
  const { base, active, param, cum, edgeLen, positions } = f;
  const { startIndices, positions: verts } = view;
  let out = 0;
  for (let e = 0; e < active.length; e++) {
    const a = startIndices[e];
    const b = startIndices[e + 1];
    const len = edgeLen[e];
    for (let i = 0; i < active[e]; i++) {
      const target = param[base[e] + i] * len;
      let k = a + 1;
      while (k < b - 1 && cum[k] < target) k++;
      const d0 = cum[k - 1];
      const seg = cum[k] - d0;
      const t = seg > 0 ? (target - d0) / seg : 0;
      const lon0 = verts[(k - 1) * 2];
      const lat0 = verts[(k - 1) * 2 + 1];
      positions[out * 2] = lon0 + (verts[k * 2] - lon0) * t;
      positions[out * 2 + 1] = lat0 + (verts[k * 2 + 1] - lat0) * t;
      out++;
    }
  }
  f.count = out;
  return out;
}

export function particleLayer(f: ParticleField, palette: Palette, revision: number): ScatterplotLayer {
  return new ScatterplotLayer({
    id: 'particles',
    data: { length: f.count, attributes: { getPosition: { value: f.positions, size: 2 } } },
    getFillColor: palette.particle,
    getLineColor: palette.particleEdge,
    getRadius: 9,
    radiusUnits: 'meters',
    radiusMinPixels: 1.9,
    radiusMaxPixels: 5,
    stroked: true,
    lineWidthUnits: 'pixels',
    getLineWidth: 0.9,
    pickable: false,
    updateTriggers: { getPosition: revision },
  });
}
