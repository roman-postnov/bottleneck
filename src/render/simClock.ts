// The simulated clock the dots are drawn on (docs/CONTRACTS.md §13.2). Frames arrive at whatever
// cadence the worker manages; the cars have to move smoothly between them, so this integrates
// simulated time and corrects the RATE against the newest frame rather than the value.
//
// Pure arithmetic over numbers: no deck.gl, no React, no map. That is what lets it be tested.

/** How fast the estimate follows a change in the achieved acceleration. */
const RATE_TAU_MS = 1000;
/** Authority the lag term has over the rate. Bounded so simT can never run backwards. */
const CATCHUP = 0.25;

export class SimClock {
  /** Simulated seconds, interpolated between frames. */
  simT = 0;
  /** Simulated seconds per wall second, as actually achieved by the worker. */
  rate = 0;
  /** Newest frame's t, the anchor the lag term corrects towards. */
  private targetT = 0;
  private lastT = 0;
  private lastWallMs = 0;
  /** Wall clock of the previous rAF, for the simulated-time step. */
  private lastRafMs = 0;

  /**
   * Measures the acceleration the worker actually achieved, rather than trusting the requested
   * speedX: the worker drops whatever ticks do not fit its 12 ms slice, so at x600 the real
   * rate is lower and cars driven by the request would run ahead of the simulation.
   *
   * Frames with dt = 0 are ignored -- `edit` and `configure` force a frame out at the same t,
   * and dividing by it would crash the estimate to zero.
   *
   * Separate from the `actualX` readout in src/main/app.ts on purpose: that one is throttled to
   * 200 ms for React, and feeding a control loop a lagged rate makes the dots move in steps.
   */
  observe(t: number, nowMs: number): void {
    this.targetT = t;
    const dt = t - this.lastT;
    const dw = (nowMs - this.lastWallMs) / 1000;
    if (this.lastWallMs === 0 || dt <= 0 || dw <= 0) {
      this.lastT = t;
      this.lastWallMs = nowMs;
      if (this.rate === 0) this.simT = t;
      return;
    }
    const a = Math.min(1, (dw * 1000) / RATE_TAU_MS);
    this.rate += (dt / dw - this.rate) * a;
    this.lastT = t;
    this.lastWallMs = nowMs;
  }

  /**
   * Re-anchoring simT to each arriving frame would step it backwards whenever the rate was
   * over-estimated, and with one dot per car a backward step is glaring. Clamping it to the
   * newest frame instead would break x1, where the worker sleeps a whole second and then jumps
   * t by one: the cars would sprint for a fraction of a second and freeze for the rest.
   */
  advance(nowMs: number, running: boolean): void {
    const dtWall = this.lastRafMs === 0 ? 0.016 : Math.min(0.25, (nowMs - this.lastRafMs) / 1000);
    this.lastRafMs = nowMs;
    if (!running) return;
    const err = this.targetT - this.simT;
    // A big gap means something discontinuous happened -- stepTo, a backgrounded tab, a long
    // GC pause -- and catching up at 25% would take minutes.
    if (Math.abs(err) > Math.max(10, this.rate * 4)) {
      this.simT = this.targetT;
      return;
    }
    const eff = this.rate * (1 + Math.max(-CATCHUP, Math.min(CATCHUP, err / Math.max(1, this.rate))));
    this.simT += Math.max(0, eff) * dtWall;
  }
}
