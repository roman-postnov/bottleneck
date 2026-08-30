// Pacing for the run loop of CONTRACTS.md §1.1: how many whole ticks are due, and when a frame
// is allowed out. Ticks are never dropped for the clock's convenience; frames are thinned.

/** Frames are thinned to this cadence; ticks are never dropped, only frames (§1.1). */
const FRAME_INTERVAL_MS = 16;

export type TickPlan = {
  /** Whole ticks due now. 0 means nothing is due yet. */
  want: number;
  /** When `want` is 0, how long to sleep before asking again. */
  sleepMs: number;
};

export class TickClock {
  /** Separate from lastStepAt: a timestamp of 0 is a real instant, not "never stepped". */
  private started = false;
  private lastStepAt = 0;
  /** Fractional ticks carried between turns; flooring per turn would ignore slow speeds. */
  private debt = 0;
  private lastFrameAt = 0;

  reset(): void {
    this.restart();
    this.lastFrameAt = 0;
  }

  /** Called when the loop resumes, so a pause does not bank ticks for the whole pause. */
  restart(): void {
    this.started = false;
    this.lastStepAt = 0;
    this.debt = 0;
  }

  plan(nowMs: number, speedX: number): TickPlan {
    const dtSec = this.started ? (nowMs - this.lastStepAt) / 1000 : 1 / 60;
    this.started = true;
    this.lastStepAt = nowMs;

    // Capping elapsed time instead of the debt would break slow speeds: at x1 the worker
    // sleeps a whole second between ticks, and a 0.1 s cap would turn x1 into x0.1.
    this.debt = Math.min(this.debt + speedX * dtSec, speedX * 0.25 + 1);
    const want = Math.floor(this.debt);
    if (want < 1) {
      // Not a whole tick due yet. Sleeping until it is keeps x1 at x1 instead of running as
      // fast as the scheduler will fire.
      return { want: 0, sleepMs: Math.max(1, ((1 - this.debt) / speedX) * 1000) };
    }
    this.debt -= want;
    return { want, sleepMs: 0 };
  }

  /** Whatever did not fit in the compute slice is dropped, not carried (§1.1). */
  dropRemainder(): void {
    this.debt = 0;
  }

  /** Asked before a buffer is taken, so a frame skipped for want of one does not count. */
  frameDue(nowMs: number, force: boolean): boolean {
    return force || nowMs - this.lastFrameAt >= FRAME_INTERVAL_MS;
  }

  markFrame(nowMs: number): void {
    this.lastFrameAt = nowMs;
  }
}
