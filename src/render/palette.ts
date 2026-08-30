// Load palette of CONTRACTS.md §13.2, precomputed as a lookup table.
// Dark green -> yellow -> red -> almost black, on a dark basemap.

const STOPS: Array<[number, number, number, number]> = [
  [0.0, 0x1a, 0x7f, 0x5a],
  [0.5, 0xe8, 0xc3, 0x3a],
  [0.8, 0xd9, 0x44, 0x36],
  [1.0, 0x3a, 0x11, 0x13],
];

export const LUT_SIZE = 256;

export const LOAD_LUT = ((): Uint8Array => {
  const lut = new Uint8Array(LUT_SIZE * 3);
  for (let i = 0; i < LUT_SIZE; i++) {
    const x = i / (LUT_SIZE - 1);
    let k = 0;
    while (k < STOPS.length - 2 && x > STOPS[k + 1][0]) k++;
    const [x0, r0, g0, b0] = STOPS[k];
    const [x1, r1, g1, b1] = STOPS[k + 1];
    const f = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
    lut[i * 3] = Math.round(r0 + (r1 - r0) * f);
    lut[i * 3 + 1] = Math.round(g0 + (g1 - g0) * f);
    lut[i * 3 + 2] = Math.round(b0 + (b1 - b0) * f);
  }
  return lut;
})();

export const CUT_COLOR: [number, number, number] = [0xff, 0x3b, 0x30];
