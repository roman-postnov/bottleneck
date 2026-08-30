// Indexed binary min-heap on typed arrays, for the reverse Dijkstra of §6.
// buildField runs every reoptSec simulated seconds, so the heap is created once and reset,
// never reallocated (§6.3).

export class IndexedMinHeap {
  private readonly heap: Uint32Array;
  private readonly pos: Int32Array;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read as `const { key } = this` in siftUp and siftDown, which the rule does not follow
  private key: Float32Array;
  size = 0;

  constructor(capacity: number) {
    this.heap = new Uint32Array(capacity);
    this.pos = new Int32Array(capacity);
    this.key = new Float32Array(0);
    this.pos.fill(-1);
  }

  /** Point the heap at the caller's key array and empty it. O(capacity). */
  reset(key: Float32Array): void {
    this.key = key;
    this.size = 0;
    this.pos.fill(-1);
  }

  has(node: number): boolean {
    return this.pos[node] >= 0;
  }

  /** Insert the node, or sift it up if its key has dropped since insertion. */
  pushOrDecrease(node: number): void {
    let i = this.pos[node];
    if (i < 0) {
      i = this.size++;
      this.heap[i] = node;
      this.pos[node] = i;
    }
    this.siftUp(i);
  }

  pop(): number {
    const top = this.heap[0];
    this.pos[top] = -1;
    const last = --this.size;
    if (last > 0) {
      this.heap[0] = this.heap[last];
      this.pos[this.heap[0]] = 0;
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(start: number): void {
    const { heap, pos, key } = this;
    let i = start;
    const node = heap[i];
    const k = key[node];
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const pn = heap[parent];
      if (key[pn] <= k) break;
      heap[i] = pn;
      pos[pn] = i;
      i = parent;
    }
    heap[i] = node;
    pos[node] = i;
  }

  private siftDown(start: number): void {
    const { heap, pos, key, size } = this;
    let i = start;
    const node = heap[i];
    const k = key[node];
    for (;;) {
      let child = 2 * i + 1;
      if (child >= size) break;
      const right = child + 1;
      if (right < size && key[heap[right]] < key[heap[child]]) child = right;
      const cn = heap[child];
      if (key[cn] >= k) break;
      heap[i] = cn;
      pos[cn] = i;
      i = child;
    }
    heap[i] = node;
    pos[node] = i;
  }
}
