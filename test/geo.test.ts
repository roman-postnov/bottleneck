// The projection of CONTRACTS.md §13.2, pinned to deck.gl instead of to a second copy of itself.
//
// This is the test whose absence WAS the bug. The equirectangular 111320/110540 that used to live
// here was pinned worker-to-render, so both copies agreed and both were wrong: the dots are drawn
// in deck.gl's 'meter-offsets' and deck.gl's shader is what unprojects them, with its own
// constants. A dot ended up 18 m off the road at 3 km from centre and 438 m off on the Keys.

import { WebMercatorViewport } from '@deck.gl/core';
import { describe, expect, it } from 'vitest';
import { meterOffsets, projectX, projectY, toMeterOffsets, unprojectLat, unprojectLon } from '../src/shared/geo.ts';

/** The four shipped cities, plus the equator and the southern hemisphere. */
const CENTRES: [lat: number, lon: number][] = [
  [37.76, -122.44],
  [39.76, -121.62],
  [24.55, -81.8],
  [47.57, -122.22],
  [0, 0],
  [-33.9, 151.2],
];

const KM = [0.1, 1, 3, 6, 55];

function viewport(center: [lat: number, lon: number]): WebMercatorViewport {
  return new WebMercatorViewport({ longitude: center[1], latitude: center[0], zoom: 12, width: 800, height: 600 });
}

/**
 * deck.gl's exported DistanceScales type declares only unitsPerMeter, but Viewport.getDistanceScales
 * with an origin asks for highPrecision and the object it returns carries unitsPerMeter2 -- which is
 * the term the shader applies. The cast reads the value the shader reads, not the one the type
 * admits to.
 */
type Scales = { unitsPerMeter: number[]; unitsPerMeter2: number[] };

function scalesAt(center: [lat: number, lon: number]): Scales {
  return viewport(center).getDistanceScales([center[1], center[0]]) as unknown as Scales;
}

/** Rough ground metres between two lon/lat points, for reporting an error as a distance. */
function groundM(lon: number, lat: number, lon2: number, lat2: number): number {
  return Math.hypot((lon2 - lon) * 111320 * Math.cos((lat * Math.PI) / 180), (lat2 - lat) * 111132);
}

/** A point `km` from `center` on bearing `a`/8 turns, in lon/lat. */
function around(center: [lat: number, lon: number], km: number, a: number): [lon: number, lat: number] {
  const th = (a * Math.PI) / 4;
  const lat = center[0] + (km * 1000 * Math.cos(th)) / 111132;
  const lon = center[1] + (km * 1000 * Math.sin(th)) / (111320 * Math.cos((center[0] * Math.PI) / 180));
  return [lon, lat];
}

describe('§13.2: the metre offsets are deck.gl’s, exactly', () => {
  it('agrees with deck.gl’s own distance scales, bit for bit', () => {
    for (const c of CENTRES) {
      const scales = scalesAt(c);
      const p = meterOffsets(c);
      // toBe, not toBeCloseTo: this is the same arithmetic, and anything less would let the drift
      // that caused the bug back in under a tolerance.
      expect(p.uPM, `uPM at ${c}`).toBe(scales.unitsPerMeter[0]);
      expect(p.uPM2, `uPM2 at ${c}`).toBe(scales.unitsPerMeter2[0]);
    }
  });

  it('rests on deck.gl having no second-order term in y', () => {
    // The closed-form inverse exists only because of this zero. If a deck.gl release adds a term
    // here, projectY stops being exact and every dot drifts north again -- silently, unless this
    // assertion says so first.
    for (const c of CENTRES) {
      expect(scalesAt(c).unitsPerMeter2[1], `at ${c}`).toBe(0);
    }
  });

  it('a point projected here lands on itself when deck.gl unprojects it', () => {
    for (const c of CENTRES) {
      const vp = viewport(c);
      const scales = scalesAt(c);
      const origin = vp.projectPosition([c[1], c[0], 0]);
      const p = meterOffsets(c);
      for (const km of KM) {
        for (let a = 0; a < 8; a++) {
          const [lon, lat] = around(c, km, a);
          const y = projectY(p, lat);
          const x = projectX(p, lon, y);
          // project_offset_ from deck.gl's project.glsl: linear, plus the second order in dy.
          const cx = origin[0] + x * (scales.unitsPerMeter[0] + scales.unitsPerMeter2[0] * y);
          const cy = origin[1] + y * (scales.unitsPerMeter[1] + scales.unitsPerMeter2[1] * y);
          const [lon2, lat2] = vp.unprojectFlat([cx, cy]);
          expect(groundM(lon, lat, lon2, lat2), `${c} ${km} km bearing ${a}`).toBeLessThan(1e-6);
        }
      }
    }
  });

  it('inverts itself', () => {
    for (const c of CENTRES) {
      const p = meterOffsets(c);
      for (const km of KM) {
        for (let a = 0; a < 8; a++) {
          const [lon, lat] = around(c, km, a);
          const y = projectY(p, lat);
          const x = projectX(p, lon, y);
          expect(unprojectLat(p, y), `lat ${c} ${km} km`).toBeCloseTo(lat, 11);
          expect(unprojectLon(p, x, y), `lon ${c} ${km} km`).toBeCloseTo(lon, 11);
        }
      }
    }
  });

  it('survives the Float32 buffer the dots are actually drawn from', () => {
    for (const c of CENTRES) {
      const vp = viewport(c);
      const scales = scalesAt(c);
      const origin = vp.projectPosition([c[1], c[0], 0]);
      const flat: number[] = [];
      const want: [number, number][] = [];
      for (const km of KM) {
        for (let a = 0; a < 8; a++) {
          const pt = around(c, km, a);
          flat.push(pt[0], pt[1]);
          want.push(pt);
        }
      }
      const m = toMeterOffsets(Float64Array.from(flat), c);
      for (let i = 0; i < want.length; i++) {
        const x = m[i * 2];
        const y = m[i * 2 + 1];
        const cx = origin[0] + x * (scales.unitsPerMeter[0] + scales.unitsPerMeter2[0] * y);
        const cy = origin[1] + y * (scales.unitsPerMeter[1] + scales.unitsPerMeter2[1] * y);
        const [lon2, lat2] = vp.unprojectFlat([cx, cy]);
        // Millimetres, from the Float32 step alone -- the same step nodeXY and bldXY already pay.
        expect(groundM(want[i][0], want[i][1], lon2, lat2), `${c} point ${i}`).toBeLessThan(0.01);
      }
    }
  });

  it('is the same arithmetic whether entered per point or per buffer', () => {
    const c: [number, number] = [37.76, -122.44];
    const p = meterOffsets(c);
    const positions = Float64Array.from([-122.4, 37.8, -122.5, 37.7, -122.44, 37.76]);
    const m = toMeterOffsets(positions, c);
    for (let k = 0; k < positions.length; k += 2) {
      const y = projectY(p, positions[k + 1]);
      expect(m[k + 1]).toBe(Math.fround(y));
      expect(m[k]).toBe(Math.fround(projectX(p, positions[k], y)));
    }
  });

  it('the equirectangular projection it replaced was off by the metres that were measured', () => {
    // Kept so that "simplifying" the projection back to a pair of constants goes red, with the
    // numbers from the report attached: 18 m at 3 km, 37 m at 6 km, 438 m at 55 km.
    const oldLat = 110540;
    const oldLon = (lat: number): number => 111320 * Math.cos((lat * Math.PI) / 180);
    for (const [c, km, floor] of [
      [CENTRES[1], 3, 15],
      [CENTRES[0], 6, 30],
      [CENTRES[2], 55, 400],
    ] as [[number, number], number, number][]) {
      const vp = viewport(c);
      const scales = scalesAt(c);
      const origin = vp.projectPosition([c[1], c[0], 0]);
      const [lon, lat] = around(c, km, 0);
      const x = (lon - c[1]) * oldLon(c[0]);
      const y = (lat - c[0]) * oldLat;
      const cx = origin[0] + x * (scales.unitsPerMeter[0] + scales.unitsPerMeter2[0] * y);
      const cy = origin[1] + y * (scales.unitsPerMeter[1] + scales.unitsPerMeter2[1] * y);
      const [lon2, lat2] = vp.unprojectFlat([cx, cy]);
      expect(groundM(lon, lat, lon2, lat2), `${km} km`).toBeGreaterThan(floor);
    }
  });
});
