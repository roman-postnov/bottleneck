// Shared inverse of deck.gl's meter-offset projection (docs/CONTRACTS.md §13.2). Worker and
// renderer use the same constants so parked and moving cars align with road geometry.

const TILE_SIZE = 512;
const EARTH_CIRCUMFERENCE = 40.03e6;
const D2R = Math.PI / 180;

/**
 * One lane, metres, to the right of the direction of travel. Baked into the edge polyline in
 * src/worker/geometry.ts rather than applied by a shader, so the road line, the cars on it, the
 * trail and the closure dashes are all one geometry (§13.1). Equal to WIDTH_EMPTY in
 * src/render/layers.ts.
 */
export const LANE_OFFSET_M = 4;

/**
 * Per-centre constants of deck.gl's METER_OFFSETS mapping. `uPM`/`uPM2` are equal, bit for bit,
 * to `new WebMercatorViewport({...}).getDistanceScales([lon0, lat0])`'s `unitsPerMeter[0]` and
 * `unitsPerMeter2[0]` -- pinned in test/geo.test.ts.
 */
export type MeterOffsets = {
  lat0: number;
  lon0: number;
  uPM: number;
  /**
   * The second-order term, in y. Its y counterpart is ZERO in deck.gl, which is the only reason
   * the inverse below is closed form rather than an iteration; test/geo.test.ts asserts it.
   */
  uPM2: number;
  /** Mercator isometric latitude of the origin. */
  psi0: number;
};

export function meterOffsets(center: [lat: number, lon: number]): MeterOffsets {
  const lat0 = center[0];
  const lon0 = center[1];
  const cos0 = Math.cos(lat0 * D2R);
  const uPM = TILE_SIZE / EARTH_CIRCUMFERENCE / cos0;
  const latCosine2 = (D2R * Math.tan(lat0 * D2R)) / cos0;
  const uPM2 = (((TILE_SIZE / EARTH_CIRCUMFERENCE) * latCosine2) / (TILE_SIZE / 360 / cos0)) * uPM;
  const psi0 = Math.log(Math.tan(Math.PI / 4 + (lat0 * D2R) / 2));
  return { lat0, lon0, uPM, uPM2, psi0 };
}

/** Metres north of the origin. Exact mercator: deck.gl carries no second-order term in y. */
export function projectY(p: MeterOffsets, latDeg: number): number {
  const psi = Math.log(Math.tan(Math.PI / 4 + (latDeg * D2R) / 2));
  return ((TILE_SIZE / (2 * Math.PI)) * (psi - p.psi0)) / p.uPM;
}

/** Metres east of the origin. Needs `y` first: deck.gl scales x by a term linear in y. */
export function projectX(p: MeterOffsets, lonDeg: number, y: number): number {
  return ((TILE_SIZE / 360) * (lonDeg - p.lon0)) / (p.uPM + p.uPM2 * y);
}

export function unprojectLat(p: MeterOffsets, y: number): number {
  const psi = p.psi0 + (y * p.uPM * 2 * Math.PI) / TILE_SIZE;
  return (2 * Math.atan(Math.exp(psi)) - Math.PI / 2) / D2R;
}

export function unprojectLon(p: MeterOffsets, x: number, y: number): number {
  return p.lon0 + (x * (p.uPM + p.uPM2 * y) * 360) / TILE_SIZE;
}

/** Lon/lat degrees to metre offsets from `center`, which is [lat, lon] as everywhere in §5. */
export function toMeterOffsets(positions: Float64Array, center: [lat: number, lon: number]): Float32Array {
  const out = new Float32Array(positions.length);
  const p = meterOffsets(center);
  for (let k = 0; k < positions.length; k += 2) {
    const y = projectY(p, positions[k + 1]);
    out[k] = projectX(p, positions[k], y);
    out[k + 1] = y;
  }
  return out;
}
