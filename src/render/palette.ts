// Load palette of CONTRACTS.md §13.2, precomputed as a lookup table.

const LUT_SIZE = 256;

type Stops = [number, number, number, number][];

/**
 * §13.2's ramp with both ends re-lit, and the reason is the same at both ends: loudness has to
 * climb with load. Verbatim, the empty city screamed green while the one jammed artery was
 * `#3a1113` on a near-black basemap -- findable only by the dots crawling along it. The three
 * middle hues are the contract's; the ends are not.
 */
const DARK: Stops = [
  [0.0, 0x13, 0x3a, 0x2e],
  [0.25, 0x1a, 0x7f, 0x5a],
  [0.5, 0xe8, 0xc3, 0x3a],
  [0.8, 0xd9, 0x44, 0x36],
  [1.0, 0xff, 0x6a, 0x52],
];

/**
 * The same ramp re-lit for a light basemap, and deliberately not a tint of the dark one.
 * §13.2's green is loud on white, so an empty city came out a solid green mass and the jam --
 * the near-black end, the only part worth looking at -- was the quietest thing on screen. Here
 * the empty end recedes into the basemap and loudness climbs with load.
 */
const LIGHT: Stops = [
  [0.0, 0xa9, 0xc6, 0xba],
  [0.25, 0x3f, 0x9b, 0x76],
  [0.5, 0xd9, 0x77, 0x06],
  [0.8, 0xc0, 0x25, 0x1a],
  [1.0, 0x2b, 0x0a, 0x0c],
];

function ramp(stops: Stops): Uint8Array {
  const lut = new Uint8Array(LUT_SIZE * 3);
  for (let i = 0; i < LUT_SIZE; i++) {
    const x = i / (LUT_SIZE - 1);
    let k = 0;
    while (k < stops.length - 2 && x > stops[k + 1][0]) k++;
    const [x0, r0, g0, b0] = stops[k];
    const [x1, r1, g1, b1] = stops[k + 1];
    const f = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
    lut[i * 3] = Math.round(r0 + (r1 - r0) * f);
    lut[i * 3 + 1] = Math.round(g0 + (g1 - g0) * f);
    lut[i * 3 + 2] = Math.round(b0 + (b1 - b0) * f);
  }
  return lut;
}

export type Theme = 'dark' | 'light';

export type Palette = {
  load: Uint8Array;
  cut: [number, number, number];
  /**
   * Cars. It has to read against the road it sits on, and the road it sits on is dark exactly
   * when it is full -- which is when there are cars to show. So the dot is the opposite of the
   * jam colour, not of the basemap.
   */
  particle: [number, number, number];
  /** The dot needs an outline: a road is pale when empty and near-black when full, and no
   *  single fill reads on both. */
  particleEdge: [number, number, number];
  /**
   * A car drawn without an outline, which is what it gets when it is barely a pixel across and
   * the outline would BE the dot. One fill has to read on the basemap and on a jammed road at
   * once, which the note above says is impossible -- so this is the one that reads on the
   * basemap, because an empty road is a hairline and the basemap is what a dot sits on. That
   * makes it dark on the light theme and light on the dark one: the opposite of `particle`.
   */
  carDense: [number, number, number];
  /**
   * Cars still standing in a driveway. Quiet, because at t = 0 the whole fleet is parked and a
   * loud yard would read as a city already in gridlock -- which is the opposite of the truth.
   */
  parked: [number, number, number, number];
  /**
   * Cars the network has stranded: no route out from where they stand. These are §11's
   * `stranded`, and this is the first time that number is visible on the map at all.
   */
  stuck: [number, number, number];
  /** The route of the car being followed. */
  trail: [number, number, number];
};

export const PALETTE: Record<Theme, Palette> = {
  dark: {
    load: ramp(DARK),
    cut: [0xff, 0x3b, 0x30],
    particle: [0xf2, 0xf6, 0xfa],
    particleEdge: [0x0a, 0x12, 0x1a],
    carDense: [0xf2, 0xf6, 0xfa],
    parked: [0x93, 0xa6, 0xb8, 0x70],
    stuck: [0xb0, 0x5c, 0xe8],
    trail: [0x38, 0xd6, 0xff],
  },
  light: {
    load: ramp(LIGHT),
    cut: [0xe1, 0x1d, 0x48],
    particle: [0xff, 0xff, 0xff],
    particleEdge: [0x16, 0x2a, 0x3d],
    carDense: [0x16, 0x2a, 0x3d],
    parked: [0x74, 0x86, 0x99, 0x78],
    stuck: [0x7c, 0x3a, 0xed],
    trail: [0x0e, 0x76, 0xd6],
  },
};

export { LUT_SIZE };
