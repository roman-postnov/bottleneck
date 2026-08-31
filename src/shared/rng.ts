// The splitmix32 mixer (docs/CONTRACTS.md §10), in the one place both sides of the §15 boundary can
// reach. src/core needs the stateful generator; src/render needs a single mix of a slot index,
// and §15 forbids it to import src/core. This file imports nothing, so it can sit under both.

const GAMMA = 0x9e3779b9;

/** One mixing round over an already-advanced state word. */
function mixWord(x: number): number {
  let z = x;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  return (z ^ (z >>> 15)) >>> 0;
}

/** splitmix32 of `a`: advance once and mix. Stateless, so the same input always maps here. */
export function mix32(a: number): number {
  return mixWord((a + GAMMA) | 0);
}

/** The stateful generator: successive calls walk the state forward. */
export function splitmix32(seed: number): () => number {
  let x = seed | 0;
  return () => {
    x = (x + GAMMA) | 0;
    return mixWord(x);
  };
}
