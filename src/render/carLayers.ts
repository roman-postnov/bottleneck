// The car layers of docs/CONTRACTS.md §13.2: one dot per vehicle, plus the route of the one being
// followed. Layer factories only -- the state machine is in tracers.ts and stays deck.gl-free.

import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { GraphView } from './layers.ts';
import type { Palette } from './palette.ts';
import type { BinaryPoints, TracerField } from './tracers.ts';

/**
 * Below this zoom a dot is smaller than a pixel and the layer reads as density; above it, as
 * individual cars you can aim at. One set of constants cannot serve both: at z12 San Francisco
 * is ~38 m/px, so a metre radius decides nothing and radiusMinPixels decides everything.
 */
export const INDIVIDUAL_ZOOM = 15;

/** Approximate car length in metres. */
const CAR_M = 2.2;

type Origin = [lon: number, lat: number];

/**
 * Rebuild the small wrapper so ScatterplotLayer observes a changing instance count. The typed
 * buffers are reused; §13.1's stable-data rule applies to PathLayer tessellation, not this layer.
 */
function points(
  id: string,
  count: number,
  positions: Float32Array,
  origin: Origin,
  revision: number,
  props: Record<string, unknown>,
): ScatterplotLayer {
  const data: BinaryPoints = {
    length: count,
    attributes: { getPosition: { value: positions, size: 2 } },
  };
  return new ScatterplotLayer({
    id,
    // METER_OFFSETS, not LNGLAT: under LNGLAT deck.gl declares instancePositions as float64 and
    // splits the buffer into hi/lo Float32 attributes on the CPU every frame. At a quarter of a
    // million dots that is a second upload and a quarter-million conversions, and none of it
    // shows up in a timer we control. In metre offsets use64bitPositions() is false, the fp64
    // path disappears, the buffer halves, and Float32 still resolves 1.4 mm at 12 km out.
    coordinateSystem: 'meter-offsets',
    coordinateOrigin: origin,
    data,
    radiusUnits: 'meters',
    updateTriggers: { getPosition: revision },
    ...props,
  } as never);
}

/** Cars on the road. */
export function carsLayer(
  f: TracerField,
  palette: Palette,
  origin: Origin,
  zoom: number,
  revision: number,
): ScatterplotLayer {
  const individual = zoom >= INDIVIDUAL_ZOOM;
  return points('cars', f.count, f.pos, origin, revision, {
    // The outline keeps the individual-car fill visible on both roads and the basemap.
    getFillColor: individual ? palette.particle : palette.carDense,
    getLineColor: palette.particleEdge,
    getRadius: CAR_M,
    // Small dots read as density when zoomed out while preserving one dot per car.
    radiusMinPixels: individual ? 1.6 : 1.1,
    radiusMaxPixels: individual ? 8 : 6,
    // The outline IS the whole dot at a pixel across, and it doubles the fragment work.
    stroked: individual,
    lineWidthUnits: 'pixels',
    getLineWidth: 0.9,
    opacity: individual ? 1 : 0.95,
    pickable: true,
    // Never autoHighlight: it forces deck to render the picking pass every frame, and the
    // whole reason picking is free here is that it only runs on a click.
    autoHighlight: false,
  });
}

/** Cars still in a driveway. Quiet: at t = 0 this is the entire fleet. */
export function parkedLayer(
  f: TracerField,
  palette: Palette,
  origin: Origin,
  zoom: number,
  revision: number,
): ScatterplotLayer {
  const individual = zoom >= INDIVIDUAL_ZOOM;
  return points('parked', f.parkedCount, f.parkedPos, origin, revision, {
    getFillColor: palette.parked,
    getRadius: CAR_M,
    // Parked cars stay quieter so they do not obscure the moving traffic.
    radiusMinPixels: individual ? 1.2 : 0.55,
    radiusMaxPixels: individual ? 5 : 3,
    stroked: false,
    pickable: true,
    autoHighlight: false,
  });
}

/** Cars the network stranded (§11). */
export function stuckLayer(f: TracerField, palette: Palette, origin: Origin, revision: number): ScatterplotLayer {
  return points('stuck', f.stuckCount, f.stuckPos, origin, revision, {
    getFillColor: palette.stuck,
    getRadius: CAR_M * 1.6,
    radiusMinPixels: 2,
    radiusMaxPixels: 9,
    stroked: false,
    pickable: true,
    autoHighlight: false,
  });
}

/** The route a followed car has taken, as lon/lat paths built from the edges it used. */
export function trailLayer(paths: [number, number][][], palette: Palette): PathLayer {
  return new PathLayer({
    id: 'trail',
    data: paths,
    getPath: (d: [number, number][]) => d,
    getColor: palette.trail,
    getWidth: 16,
    widthUnits: 'meters',
    widthMinPixels: 2.5,
    widthMaxPixels: 10,
    capRounded: true,
    jointRounded: true,
    pickable: false,
    parameters: { depthCompare: 'always' },
  });
}

/** A ring on the car being followed, so it stays findable in a field of identical dots. */
export function followLayer(
  position: [number, number],
  palette: Palette,
  origin: Origin,
  revision: number,
): ScatterplotLayer {
  return new ScatterplotLayer({
    id: 'follow',
    coordinateSystem: 'meter-offsets',
    coordinateOrigin: origin,
    data: [position],
    getPosition: (d: [number, number]) => d,
    getFillColor: [0, 0, 0, 0],
    getLineColor: palette.trail,
    getRadius: 26,
    radiusUnits: 'meters',
    radiusMinPixels: 7,
    radiusMaxPixels: 22,
    stroked: true,
    filled: false,
    lineWidthUnits: 'pixels',
    getLineWidth: 2,
    pickable: false,
    updateTriggers: { getPosition: revision },
    parameters: { depthCompare: 'always' },
  } as never);
}

/**
 * The lon/lat polyline of a route, built by concatenating the edges it used -- the same
 * concatenation cutPaths does for the min-cut. A route is contiguous by construction, so this
 * is one path; it is returned wrapped because PathLayer wants a list. The joins carry a step of up
 * to two lanes, which jointRounded swallows at the trail's width.
 */
export function edgePaths(view: GraphView, edges: ArrayLike<number>): [number, number][][] {
  const path: [number, number][] = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    for (let k = view.startIndices[e]; k < view.startIndices[e + 1]; k++) {
      const pt: [number, number] = [view.positions[k * 2], view.positions[k * 2 + 1]];
      // Directed edge offsets can still produce a repeated coordinate at a route join (§13.1).
      const last = path[path.length - 1];
      if (!last || last[0] !== pt[0] || last[1] !== pt[1]) path.push(pt);
    }
  }
  return path.length > 1 ? [path] : [];
}
