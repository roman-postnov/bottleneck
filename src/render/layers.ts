// The binary PathLayer of CONTRACTS.md §13.1.
// The renderer knows vertices and a frame, never a graph (§15).

import { PathLayer } from '@deck.gl/layers';
import { LOAD_LUT, LUT_SIZE, CUT_COLOR } from './palette.ts';

export type GraphView = {
  E: number;
  positions: Float64Array;
  /** Uint32, not Uint16: the documented example uses Uint16 and folds a big city silently. */
  startIndices: Uint32Array;
  /** One colour per VERTEX, not per path -- length is vertexCount * 3. */
  colors: Uint8Array;
  vertexCount: number;
  revision: number;
};

export function createGraphView(
  E: number,
  positions: Float64Array,
  startIndices: Uint32Array,
): GraphView {
  const vertexCount = startIndices[E];
  return {
    E,
    positions,
    startIndices,
    colors: new Uint8Array(vertexCount * 3),
    vertexCount,
    revision: 0,
  };
}

/** Writes into the existing colour buffer; the data object is never recreated. */
export function paint(view: GraphView, n: Float32Array, storage: Float32Array): void {
  const { startIndices, colors, E } = view;
  for (let e = 0; e < E; e++) {
    let load = n[e] / storage[e];
    if (!(load > 0)) load = 0;
    else if (load > 1) load = 1;
    const c = (((load * (LUT_SIZE - 1)) | 0) * 3) | 0;
    const r = LOAD_LUT[c];
    const g = LOAD_LUT[c + 1];
    const b = LOAD_LUT[c + 2];
    for (let k = startIndices[e]; k < startIndices[e + 1]; k++) {
      const o = k * 3;
      colors[o] = r;
      colors[o + 1] = g;
      colors[o + 2] = b;
    }
  }
  view.revision++;
}

export function paintCut(view: GraphView, cutEdges: Uint32Array): void {
  const { startIndices, colors } = view;
  for (let i = 0; i < cutEdges.length; i++) {
    const e = cutEdges[i];
    for (let k = startIndices[e]; k < startIndices[e + 1]; k++) {
      const o = k * 3;
      colors[o] = CUT_COLOR[0];
      colors[o + 1] = CUT_COLOR[1];
      colors[o + 2] = CUT_COLOR[2];
    }
  }
  view.revision++;
}

export function roadLayer(view: GraphView): PathLayer {
  return new PathLayer({
    id: 'roads',
    data: {
      length: view.E,
      startIndices: view.startIndices,
      attributes: {
        getPath: { value: view.positions, size: 2 },
        getColor: { value: view.colors, size: 3 },
      },
    },
    // Without this deck.gl normalises the data and the whole point of binary paths is lost.
    _pathType: 'open',
    pickable: true,
    widthUnits: 'meters',
    getWidth: 8,
    widthMinPixels: 1.4,
    widthMaxPixels: 8,
    capRounded: true,
    jointRounded: true,
    updateTriggers: { getColor: view.revision },
  });
}
