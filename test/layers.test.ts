import { describe, expect, it } from 'vitest';
import {
  closureLayer,
  contraflowLayer,
  createGraphView,
  markedPaths,
  paint,
  roadLayer,
  WIDTH_EMPTY,
} from '../src/render/layers.ts';
import { LUT_SIZE, PALETTE } from '../src/render/palette.ts';
import { LANE_OFFSET_M } from '../src/shared/geo.ts';

function graphView() {
  return createGraphView(3, new Float64Array(12), Uint32Array.from([0, 2, 4, 6]));
}

function colorAt(load: number): number[] {
  const offset = (((load * (LUT_SIZE - 1)) | 0) * 3) | 0;
  return Array.from(PALETTE.light.load.slice(offset, offset + 3));
}

describe('road load layer', () => {
  it('maps edge occupancy to every vertex colour and width', () => {
    const view = graphView();
    paint(view, Float32Array.from([0, 5, 10]), Float32Array.from([10, 10, 10]), PALETTE.light);

    const empty = colorAt(0);
    const half = colorAt(0.5);
    const full = colorAt(1);
    expect(Array.from(view.colors)).toEqual([...empty, ...empty, ...half, ...half, ...full, ...full]);
    expect(view.widths[0]).toBe(4);
    expect(view.widths[2]).toBeCloseTo(4.4);
    expect(view.widths[4]).toBeCloseTo(4.8);
  });

  it('refreshes dynamic binary descriptors without recreating geometry data', () => {
    const view = graphView();
    const data = view.data;
    const pathAttribute = data.attributes.getPath;
    const colorAttribute = data.attributes.getColor;
    const widthAttribute = data.attributes.getWidth;

    paint(view, Float32Array.from([0, 5, 10]), Float32Array.from([10, 10, 10]), PALETTE.light);

    expect(view.data).toBe(data);
    expect(view.data.attributes.getPath).toBe(pathAttribute);
    expect(view.data.attributes.getColor).not.toBe(colorAttribute);
    expect(view.data.attributes.getWidth).not.toBe(widthAttribute);
    expect(view.data.attributes.getColor.value).toBe(view.colors);
    expect(view.data.attributes.getWidth.value).toBe(view.widths);

    const paintedColorAttribute = view.data.attributes.getColor;
    const paintedWidthAttribute = view.data.attributes.getWidth;
    paint(view, new Float32Array(3), Float32Array.from([10, 10, 10]), PALETTE.dark);

    expect(view.data.attributes.getColor).not.toBe(paintedColorAttribute);
    expect(view.data.attributes.getWidth).not.toBe(paintedWidthAttribute);
    const layer = roadLayer(view);
    expect(layer.props.updateTriggers?.getColor).toBe(view.revision);
    expect(layer.props.updateTriggers?.getWidth).toBe(view.revision);
  });
});

describe('closed road layer', () => {
  it('extracts every marked edge while excluding another network state', () => {
    const view = createGraphView(
      3,
      Float64Array.from([0, 0, 1, 0, 10, 0, 11, 0, 20, 0, 21, 0]),
      Uint32Array.from([0, 2, 4, 6]),
    );

    expect(markedPaths(view, Uint8Array.from([1, 1, 1]), Uint8Array.from([0, 1, 0]))).toEqual([
      [
        [0, 0],
        [1, 0],
      ],
      [
        [20, 0],
        [21, 0],
      ],
    ]);
  });

  it('draws an ordinary closure as a neutral short dash over the full path', () => {
    const paths = [
      [
        [10, 0],
        [11, 0],
      ],
    ] as [number, number][][];
    const layer = closureLayer(paths, PALETTE.light);
    const extensionProps = layer.props as typeof layer.props & { getDashArray: number[] };

    expect(layer.id).toBe('closed-roads');
    expect(layer.props.data).toBe(paths);
    expect(layer.props.getColor).toBe(PALETTE.light.closed);
    expect(extensionProps.getDashArray).toEqual([2, 2]);
    expect(layer.props.pickable).toBe(false);
  });

  it('separates the directions in the geometry, not with a shader offset', () => {
    // The offset used to be PathStyleExtension({offset: true}) with getOffset: 1, which moved the
    // ribbon and left the cars on the centreline. It is now LANE_OFFSET_M, baked into the polyline
    // by the worker, and it is this number -- one lane wide, one lane over.
    expect(LANE_OFFSET_M).toBe(WIDTH_EMPTY);
    expect(roadLayer(graphView()).props.extensions).toEqual([]);

    const paths = [
      [
        [10, 0],
        [11, 0],
      ],
    ] as [number, number][][];
    for (const layer of [closureLayer(paths, PALETTE.light), contraflowLayer(paths, PALETTE.light)]) {
      const [ext] = layer.props.extensions as { opts: Record<string, unknown> }[];
      expect(ext.opts, layer.id).toMatchObject({ dash: true, offset: false });
    }
  });

  it('draws contraflow with its own colour and longer dash', () => {
    const paths = [
      [
        [10, 0],
        [11, 0],
      ],
    ] as [number, number][][];
    const layer = contraflowLayer(paths, PALETTE.dark);
    const extensionProps = layer.props as typeof layer.props & { getDashArray: number[] };

    expect(layer.id).toBe('contraflow-roads');
    expect(layer.props.getColor).toBe(PALETTE.dark.contraflow);
    expect(extensionProps.getDashArray).toEqual([8, 2]);
    expect(layer.props.pickable).toBe(false);
  });
});
