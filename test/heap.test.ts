// The Dijkstra heap of §6.3: typed arrays, reusable, decrease-key.

import { describe, it, expect } from 'vitest';
import { IndexedMinHeap } from '../src/core/heap.ts';
import { createRng } from '../src/core/rng.ts';

describe('IndexedMinHeap', () => {
  it('pops in non-decreasing key order', () => {
    const n = 500;
    const key = new Float32Array(n);
    const rng = createRng(3);
    for (let i = 0; i < n; i++) key[i] = rng.next() * 1000;

    const h = new IndexedMinHeap(n);
    h.reset(key);
    for (let i = 0; i < n; i++) h.pushOrDecrease(i);

    let prev = -Infinity;
    const out: number[] = [];
    while (h.size > 0) {
      const v = h.pop();
      expect(key[v]).toBeGreaterThanOrEqual(prev);
      prev = key[v];
      out.push(v);
    }
    expect(out.length).toBe(n);
    expect(new Set(out).size).toBe(n);
  });

  it('honours a key lowered after insertion', () => {
    const key = Float32Array.from([5, 6, 7, 8]);
    const h = new IndexedMinHeap(4);
    h.reset(key);
    for (let i = 0; i < 4; i++) h.pushOrDecrease(i);
    key[3] = 1;
    h.pushOrDecrease(3);
    expect(h.pop()).toBe(3);
    expect(h.pop()).toBe(0);
  });

  it('reset empties it and can be reused with another key array', () => {
    const h = new IndexedMinHeap(4);
    h.reset(Float32Array.from([1, 2, 3, 4]));
    h.pushOrDecrease(2);
    expect(h.size).toBe(1);
    h.reset(Float32Array.from([9, 8, 7, 6]));
    expect(h.size).toBe(0);
    expect(h.has(2)).toBe(false);
    h.pushOrDecrease(3);
    h.pushOrDecrease(0);
    expect(h.pop()).toBe(3);
  });
});
