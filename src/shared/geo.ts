// The equirectangular projection of CONTRACTS.md §13.2, in the one place both sides of the §15
// boundary can reach. The worker places the parked cars and src/render places the moving ones,
// so the two have to agree to the metre; they used to agree by copy and a drift test. This file
// imports nothing, so it can sit under both.

/** Metres per degree of latitude is a constant; per degree of longitude it shrinks with cos(lat). */
export const M_PER_DEG_LAT = 110540;

export const mPerDegLon = (latDeg: number): number => 111320 * Math.cos(latDeg * (Math.PI / 180));

/** Lon/lat degrees to metre offsets from `center`, which is [lat, lon] as everywhere in §5. */
export function toMeterOffsets(positions: Float64Array, center: [lat: number, lon: number]): Float32Array {
  const out = new Float32Array(positions.length);
  const mPerLon = mPerDegLon(center[0]);
  for (let k = 0; k < positions.length; k += 2) {
    out[k] = (positions[k] - center[1]) * mPerLon;
    out[k + 1] = (positions[k + 1] - center[0]) * M_PER_DEG_LAT;
  }
  return out;
}
