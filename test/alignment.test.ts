// The complaint this exists for: the dots did not ride the lines. A car is drawn by a
// ScatterplotLayer from a metre offset (§13.2) and its road by a PathLayer from lon/lat (§13.1),
// and the two agree only if our projection is deck.gl's own. It was not, so the fleet sat beside
// the network -- 29 m off on Paradise, 44 m on San Francisco, 431 m at the far end of the Keys.
//
// So the assertion is end to end over the shipped city files: take the vertex the road line is
// drawn from, run it through the projection the dots use, put it through the arithmetic deck.gl's
// shader actually performs, and it must come back to the same place.

import { WebMercatorViewport } from '@deck.gl/core';
import { describe, expect, it } from 'vitest';
import { toMeterOffsets } from '../src/shared/geo.ts';
import { buildEdgeGeometry } from '../src/worker/geometry.ts';
import { publicCity, publicCityMeta } from './helpers.ts';

/** getDistanceScales with an origin returns the high-precision object; the exported type omits it. */
type Scales = { unitsPerMeter: number[]; unitsPerMeter2: number[] };

/** Ground metres between two lon/lat points. */
function groundM(lon: number, lat: number, lon2: number, lat2: number): number {
  return Math.hypot((lon2 - lon) * 111320 * Math.cos((lat * Math.PI) / 180), (lat2 - lat) * 111132);
}

describe('§13.1/§13.2: a car is drawn on the line it is driving on', () => {
  for (const id of ['paradise', 'keys', 'sf', 'mercer']) {
    it(id, () => {
      const city = publicCity(id);
      const center = publicCityMeta(id).center;
      const geo = buildEdgeGeometry(city, center);
      const vertsM = toMeterOffsets(geo.positions, center);

      const vp = new WebMercatorViewport({
        longitude: center[1],
        latitude: center[0],
        zoom: 14,
        width: 900,
        height: 700,
      });
      const scales = vp.getDistanceScales([center[1], center[0]]) as unknown as Scales;
      const origin = vp.projectPosition([center[1], center[0], 0]);

      // Every vertex on the smaller cities; a fixed sample on the larger ones, because this runs
      // the full shader arithmetic per point.
      const total = geo.startIndices[city.E];
      const step = Math.max(1, Math.floor(total / 4000));
      let worst = 0;
      for (let k = 0; k < total; k += step) {
        const x = vertsM[k * 2];
        const y = vertsM[k * 2 + 1];
        const cx = origin[0] + x * (scales.unitsPerMeter[0] + scales.unitsPerMeter2[0] * y);
        const cy = origin[1] + y * (scales.unitsPerMeter[1] + scales.unitsPerMeter2[1] * y);
        const [lon2, lat2] = vp.unprojectFlat([cx, cy]);
        const d = groundM(geo.positions[k * 2], geo.positions[k * 2 + 1], lon2, lat2);
        if (d > worst) worst = d;
      }
      // A centimetre. What is left is the Float32 step of the dot buffer, which reaches ~4 mm at
      // the 82 km end of the Keys and is under a millimetre everywhere else.
      expect(worst).toBeLessThan(0.01);
    });
  }
});
