import { describe, expect, it } from 'vitest';
import { createGraphView, paint, roadLayer } from '../src/render/layers.ts';
import { LUT_SIZE, PALETTE } from '../src/render/palette.ts';

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
