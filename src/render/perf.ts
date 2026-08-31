// The frame-cost profiler behind the perf panel. Split out of MapView because it is arithmetic
// over four numbers and has no business inside a React component.

/** Timings for the four stages of a rendered frame. */
export type FrameCostCells = {
  paint: number;
  step: number;
  place: number;
  upload: number;
};

/** Averaged over wall time, not over a frame count: at a low frame rate a 30-frame window
 *  leaves the readout showing the first seconds of the run for half a minute. */
const PERF_WINDOW_MS = 500;

const ZERO: FrameCostCells = { paint: 0, step: 0, place: 0, upload: 0 };

export class FrameProfiler {
  private samples: FrameCostCells[] = [];
  private windowAt = 0;

  /** The cells for the frame being measured. The caller writes into it as the frame runs. */
  begin(): FrameCostCells {
    return { ...ZERO };
  }

  /** Returns the window's means when one is due, and null otherwise. */
  end(cells: FrameCostCells, nowMs: number): FrameCostCells | null {
    this.samples.push(cells);
    if (this.windowAt === 0) this.windowAt = nowMs;
    if (nowMs - this.windowAt < PERF_WINDOW_MS) return null;
    this.windowAt = nowMs;
    const n = this.samples.length;
    const mean = (k: keyof FrameCostCells): number => this.samples.reduce((a, c) => a + c[k], 0) / n;
    const out = { paint: mean('paint'), step: mean('step'), place: mean('place'), upload: mean('upload') };
    this.samples = [];
    return out;
  }
}
