// The pacing and buffer rules of docs/CONTRACTS.md §1.1 and §8.

import { describe, expect, it } from 'vitest';
import { FramePool } from '../src/worker/bufferPool.ts';
import { TickClock } from '../src/worker/clock.ts';

describe('§1.1: the tick clock never invents or loses whole ticks', () => {
  it('at x1 it waits for a whole second rather than spinning', () => {
    const c = new TickClock();
    const first = c.plan(0, 1);
    expect(first.want).toBe(0);
    // The first turn assumes one frame at 60 Hz, so a whisker under a second remains.
    expect(first.sleepMs).toBeGreaterThan(900);
    expect(first.sleepMs).toBeLessThanOrEqual(1000);

    expect(c.plan(1000, 1).want).toBe(1);
  });

  it('a fractional remainder is carried, not floored away', () => {
    const c = new TickClock();
    c.plan(0, 10);
    // Three 40 ms turns at x10 are 0.4 ticks each: flooring per turn would yield nothing.
    expect(c.plan(40, 10).want).toBe(0);
    expect(c.plan(80, 10).want).toBe(0);
    expect(c.plan(120, 10).want).toBe(1);
  });

  it('a stalled tab cannot bank an unbounded backlog', () => {
    const c = new TickClock();
    c.plan(0, 600);
    // Ten seconds away at x600 is 6000 ticks; the cap is speedX * 0.25 + 1.
    expect(c.plan(10_000, 600).want).toBeLessThanOrEqual(151);
  });

  it('what did not fit the compute slice is dropped, not carried', () => {
    const c = new TickClock();
    c.plan(0, 100);
    c.plan(1000, 100);
    c.dropRemainder();
    // With the debt cleared, a turn of zero elapsed time owes nothing.
    expect(c.plan(1000, 100).want).toBe(0);
  });

  it('resuming does not pay for the pause', () => {
    const c = new TickClock();
    c.plan(0, 60);
    c.restart();
    // A minute paused at x60 is 3600 ticks if the gap is honoured; the restart forgets it.
    expect(c.plan(60_000, 60).want).toBeLessThanOrEqual(1);
  });
});

describe('§1.1: frames are thinned, ticks are not', () => {
  it('a frame inside the interval is refused unless forced', () => {
    const c = new TickClock();
    // configure() forces the first frame out; nothing is due on its own at t = 0.
    expect(c.frameDue(0, false)).toBe(false);
    expect(c.frameDue(0, true)).toBe(true);
    c.markFrame(0);
    expect(c.frameDue(8, false)).toBe(false);
    expect(c.frameDue(8, true)).toBe(true);
    expect(c.frameDue(16, false)).toBe(true);
  });

  it('asking does not commit, so a frame skipped for want of a buffer still comes', () => {
    const c = new TickClock();
    c.markFrame(0);
    expect(c.frameDue(20, false)).toBe(true);
    // No markFrame -- the caller found no free buffer and gave up.
    expect(c.frameDue(21, false)).toBe(true);
  });
});

describe('§8: the frame pool', () => {
  it('hands out one set per in-flight frame and no more', () => {
    const p = new FramePool();
    p.reset(4, 3);
    const a = p.takeSet();
    const b = p.takeSet();
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(p.takeSet()).toBeUndefined();

    expect(a?.n.length).toBe(4);
    expect(a?.outflow.length).toBe(4);
    expect(a?.departed.length).toBe(3);
  });

  it('a recycled set is handed out again', () => {
    const p = new FramePool();
    p.reset(2, 2);
    const a = p.takeSet();
    p.takeSet();
    expect(p.takeSet()).toBeUndefined();
    if (a) p.giveSet(a);
    expect(p.takeSet()).toBe(a);
  });

  it('splits are pooled apart from the sets, so one cannot starve the other', () => {
    const p = new FramePool();
    p.reset(5, 5);
    p.takeSet();
    p.takeSet();
    expect(p.takeSet()).toBeUndefined();
    expect(p.takeSplit()?.length).toBe(5);
  });

  it('reset drops the old buffers rather than mixing two cities', () => {
    const p = new FramePool();
    p.reset(2, 2);
    const a = p.takeSet();
    if (a) p.giveSet(a);
    p.reset(9, 9);
    expect(p.takeSet()?.n.length).toBe(9);
  });
});
