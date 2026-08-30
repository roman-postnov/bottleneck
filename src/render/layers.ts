// The binary PathLayer of CONTRACTS.md §13.1.
// The renderer knows vertices and a frame, never a graph (§15).

import { PathStyleExtension } from '@deck.gl/extensions';
import { PathLayer } from '@deck.gl/layers';
import { LUT_SIZE, type Palette } from './palette.ts';

/**
 * Every path is drawn one width to the right of its own direction of travel. Twin edges run
 * opposite ways, so their right-hand sides are opposite sides of the street and the two
 * directions separate on their own -- without this a two-way street is two lines on top of
 * each other and which one you see is an accident of edge order.
 */
const OFFSET = 1;
const offsetOnly = new PathStyleExtension({ offset: true });
const dashedOffset = new PathStyleExtension({ offset: true, dash: true });

/** Metres, before deck.gl's pixel clamping. Colour carries the load; width only reinforces it
 *  slightly, so a stopped road does not obscure its neighbours or the cars drawn over it. */
const WIDTH_EMPTY = 4;
const WIDTH_JAMMED = WIDTH_EMPTY * 1.2;

export type GraphView = {
  E: number;
  positions: Float64Array;
  /** Uint32, not Uint16: the documented example uses Uint16 and folds a big city silently. */
  startIndices: Uint32Array;
  /** One colour per VERTEX, not per path -- length is vertexCount * 3. */
  colors: Uint8Array;
  /** One width per PATH. */
  widths: Float32Array;
  vertexCount: number;
  revision: number;
  /**
   * §13.1: recreating `data` every frame is forbidden, and the reason is not style. A fresh
   * object identity makes deck.gl re-tesselate every polyline -- 171 807 vertices on San
   * Francisco, sixty times a second, outside any timer this file could report. Measured cost
   * of getting this wrong: the requested x600 came out as an actual x2.5.
   */
  data: {
    length: number;
    startIndices: Uint32Array;
    attributes: {
      getPath: { value: Float64Array; size: number };
      getColor: { value: Uint8Array; size: number };
      getWidth: { value: Float32Array; size: number };
    };
  };
};

export function createGraphView(E: number, positions: Float64Array, startIndices: Uint32Array): GraphView {
  const vertexCount = startIndices[E];
  const colors = new Uint8Array(vertexCount * 3);
  // Per VERTEX, not per path -- same rule as the colours (§13.1). Sized [E] this silently
  // under-supplies the instanced draw: Chromium reads past the buffer and draws garbage
  // widths, Firefox refuses the draw call outright and the entire road layer disappears
  // ("Instance fetch requires 15790, but attribs only supply 2703").
  const widths = new Float32Array(vertexCount).fill(WIDTH_EMPTY);
  return {
    E,
    positions,
    startIndices,
    colors,
    widths,
    vertexCount,
    revision: 0,
    data: {
      length: E,
      startIndices,
      attributes: {
        getPath: { value: positions, size: 2 },
        getColor: { value: colors, size: 3 },
        getWidth: { value: widths, size: 1 },
      },
    },
  };
}

/** Writes into the existing colour and width buffers; the data object is never recreated. */
export function paint(view: GraphView, n: Float32Array, storage: Float32Array, palette: Palette): void {
  const { startIndices, colors, widths, E } = view;
  const lut = palette.load;
  for (let e = 0; e < E; e++) {
    let load = n[e] / storage[e];
    if (!(load > 0)) load = 0;
    else if (load > 1) load = 1;
    const w = WIDTH_EMPTY + (WIDTH_JAMMED - WIDTH_EMPTY) * load;
    const c = (((load * (LUT_SIZE - 1)) | 0) * 3) | 0;
    const r = lut[c];
    const g = lut[c + 1];
    const b = lut[c + 2];
    for (let k = startIndices[e]; k < startIndices[e + 1]; k++) {
      const o = k * 3;
      colors[o] = r;
      colors[o + 1] = g;
      colors[o + 2] = b;
      widths[k] = w;
    }
  }
  // deck.gl shallow-compares binary attribute descriptors. Mutating the typed arrays while
  // keeping these two objects makes setBinaryValue treat them as already uploaded, so every
  // road stays at its initial empty colour. Refresh only the descriptors: the outer data and
  // the geometry remain stable, therefore PathLayer does not re-tesselate the polylines.
  view.data.attributes.getColor = { value: colors, size: 3 };
  view.data.attributes.getWidth = { value: widths, size: 1 };
  view.revision++;
}

export function roadLayer(view: GraphView): PathLayer {
  return new PathLayer({
    id: 'roads',
    data: view.data,
    // Without this deck.gl normalises the data and the whole point of binary paths is lost.
    _pathType: 'open',
    pickable: true,
    widthUnits: 'meters',
    widthMinPixels: 0.7,
    widthMaxPixels: 8,
    capRounded: true,
    jointRounded: true,
    getOffset: OFFSET,
    extensions: [offsetOnly],
    updateTriggers: { getColor: view.revision, getWidth: view.revision },
  });
}

export type CutPaths = [number, number][][];

export type MarkedPaths = [number, number][][];

function edgePath(view: GraphView, e: number): [number, number][] {
  const path: [number, number][] = [];
  for (let k = view.startIndices[e]; k < view.startIndices[e + 1]; k++) {
    path.push([view.positions[k * 2], view.positions[k * 2 + 1]]);
  }
  return path;
}

/** The cut is a handful of edges, so it gets plain paths rather than a second binary buffer. */
export function cutPaths(view: GraphView, cutEdges: Uint32Array): CutPaths {
  const out: CutPaths = [];
  for (let i = 0; i < cutEdges.length; i++) {
    out.push(edgePath(view, cutEdges[i]));
  }
  return out;
}

/** Extracted only when the network changes; the resulting data identity stays stable per frame. */
export function markedPaths(view: GraphView, marked: Uint8Array, exclude?: Uint8Array): MarkedPaths {
  const out: MarkedPaths = [];
  for (let e = 0; e < view.E; e++) {
    if (marked[e] && !exclude?.[e]) out.push(edgePath(view, e));
  }
  return out;
}

/** An ordinary road closure: a neutral short dash over the full affected geometry. */
export function closureLayer(paths: MarkedPaths, palette: Palette): PathLayer {
  return new PathLayer({
    id: 'closed-roads',
    data: paths,
    getPath: (d: [number, number][]) => d,
    getColor: palette.closed,
    getWidth: 10,
    widthUnits: 'meters',
    widthMinPixels: 3,
    widthMaxPixels: 12,
    getDashArray: [2, 2],
    dashJustified: true,
    getOffset: OFFSET,
    extensions: [dashedOffset],
    pickable: false,
    parameters: { depthCompare: 'always' },
  });
}

/** Contraflow: a blue long dash along the whole reversed corridor, separate from closure. */
export function contraflowLayer(paths: MarkedPaths, palette: Palette): PathLayer {
  return new PathLayer({
    id: 'contraflow-roads',
    data: paths,
    getPath: (d: [number, number][]) => d,
    getColor: palette.contraflow,
    getWidth: 10,
    widthUnits: 'meters',
    widthMinPixels: 3,
    widthMaxPixels: 12,
    getDashArray: [8, 2],
    dashJustified: true,
    getOffset: OFFSET,
    extensions: [dashedOffset],
    pickable: false,
    parameters: { depthCompare: 'always' },
  });
}

/**
 * Drawn over the load rather than instead of it, so the road underneath still shows how full
 * it is. `pulse` scales the width: §13.2's accessors are recomputed for every object each
 * frame, `widthScale` is not.
 */
export function cutLayer(paths: CutPaths, palette: Palette, pulse: number): PathLayer {
  return new PathLayer({
    id: 'cut',
    data: paths,
    getPath: (d: [number, number][]) => d,
    getColor: palette.cut,
    // Far wider than a road: the cut is a handful of short exit edges, and at city zoom the
    // honest width of four forty-metre stubs is four specks nobody sees.
    getWidth: 70,
    widthScale: pulse,
    widthUnits: 'meters',
    widthMinPixels: 7,
    widthMaxPixels: 26,
    // A dash so the cut is still the cut in a screenshot, where the pulse says nothing.
    getDashArray: [4, 3],
    dashJustified: true,
    getOffset: OFFSET,
    extensions: [dashedOffset],
    opacity: 0.55 + 0.45 * (pulse - 1),
    parameters: { depthCompare: 'always' },
  });
}
