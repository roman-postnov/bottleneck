// The transferable frame buffers of CONTRACTS.md §8. A frame's arrays are transferred to the
// main thread, so the worker does not own them again until a `recycle` message hands them back.

/**
 * One set per in-flight frame. Three arrays travel together (§8): n, the per-edge outflow
 * delta and the per-node departure delta, so they are pooled and recycled together -- a pool
 * per array would let one run dry while another had spares and skip frames for no reason.
 */
export type FrameSet = { n: Float32Array; outflow: Float32Array; departed: Float32Array };

/** One set in flight, one being filled. A third buys nothing: the main thread returns each. */
const DEPTH = 2;

export class FramePool {
  private sets: FrameSet[] = [];
  /** Split snapshots, pooled separately: they ride along only when the field is rebuilt. */
  private splits: Float32Array[] = [];

  reset(E: number, V: number): void {
    this.sets = [];
    for (let i = 0; i < DEPTH; i++) {
      this.sets.push({ n: new Float32Array(E), outflow: new Float32Array(E), departed: new Float32Array(V) });
    }
    this.splits = [];
    for (let i = 0; i < DEPTH; i++) this.splits.push(new Float32Array(E));
  }

  /** undefined means the main thread still holds every buffer; the caller skips the frame. */
  takeSet(): FrameSet | undefined {
    return this.sets.pop();
  }

  takeSplit(): Float32Array | undefined {
    return this.splits.pop();
  }

  giveSet(set: FrameSet): void {
    this.sets.push(set);
  }

  giveSplit(split: Float32Array): void {
    this.splits.push(split);
  }
}
