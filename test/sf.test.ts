// docs/VALIDATION.md §7, checks S1-S4 and S6: San Francisco.
//
// No documented evacuation exists for this city, so these check capacity against what is
// known about the corridors, not an outcome against what happened. Everything here is graph
// and max-flow, which is milliseconds; S5 needs a full run of 377 thousand vehicles and lives
// in tools/validate-sf.ts behind `npm run validate:sf`.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSim } from '../src/core/sim.ts';
import { maxFlow } from '../src/core/maxflow.ts';
import { normalizeScenario, resolveParams } from '../src/core/scenario.ts';
import { FLAG } from '../src/core/city.ts';
import { publicCity } from './helpers.ts';
import type { Scenario } from '../src/core/types.ts';

const sf = publicCity('sf');

const preset = (name: string): Scenario =>
  normalizeScenario(JSON.parse(readFileSync(`public/scenarios/${name}.json`, 'utf8')) as Scenario);

function ceiling(name: string): { valueVehH: number; cutNames: string[] } {
  const s0 = preset(name);
  const p = resolveParams(s0);
  const s = createSim(sf, p, s0.edits);
  const mf = maxFlow(sf, p, s.blocked, s.lanes);
  return { valueVehH: mf.valueVehH, cutNames: [...mf.cutEdges].map((e) => sf.nameOf(e)) };
}

describe('S1: how many ways out the preprocessor found', () => {
  it('is between 4 and 20', () => {
    expect(sf.X).toBeGreaterThanOrEqual(4);
    expect(sf.X).toBeLessThanOrEqual(20);
  });
});

describe('S2: the min cut names the corridors, not the neighbourhoods', () => {
  // The bridge decks themselves are not in the graph: §4 step 11 keeps only what is reachable
  // from the largest component, and everything past the last on-ramp is dropped. What carries
  // the name at the city line is the approach -- Presidio Parkway for the Golden Gate, and
  // I-80's ceremonial name for the Bay Bridge.
  const { cutNames } = ceiling('sf-baseline');

  it('includes the Bay Bridge', () => {
    expect(cutNames).toContain('Dwight D. Eisenhower Highway');
  });

  it('includes the Golden Gate approach', () => {
    expect(cutNames).toContain('Presidio Parkway');
  });

  it('includes both southern freeways', () => {
    expect(cutNames).toContain('James Lick Freeway');
    expect(cutNames).toContain('John F Foran Freeway');
  });
});

describe('S3: the ceiling of the open network', () => {
  it('is between 20 000 and 60 000 veh/h', () => {
    const { valueVehH } = ceiling('sf-baseline');
    expect(valueVehH).toBeGreaterThanOrEqual(20_000);
    expect(valueVehH).toBeLessThanOrEqual(60_000);
  });
});

describe('S4: how many vehicles the city has to move', () => {
  it('is between 340 000 and 420 000', () => {
    const s = createSim(sf, resolveParams(preset('sf-baseline')));
    expect(s.totalVeh).toBeGreaterThanOrEqual(340_000);
    expect(s.totalVeh).toBeLessThanOrEqual(420_000);
  });
});

describe('S6: closing the Bay Bridge costs the city capacity', () => {
  it('lowers the ceiling', () => {
    expect(ceiling('sf-bridge-closed').valueVehH).toBeLessThan(ceiling('sf-baseline').valueVehH);
  });

  it('closes every lane of the crossing, not just the named way', () => {
    const edits = preset('sf-bridge-closed').edits;
    const lanes = edits.reduce((n, e) => n + sf.lanes[(e as { edgeId: number }).edgeId], 0);
    expect(edits.length).toBe(2);
    expect(lanes).toBe(6);
    for (const e of edits) expect(sf.flags[(e as { edgeId: number }).edgeId] & FLAG.EXIT_EDGE).toBeTruthy();
  });
});
