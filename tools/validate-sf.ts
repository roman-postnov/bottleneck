// docs/VALIDATION.md §7, checks S5 and S6: the ones that need a full run.
//
// Not a vitest file. Three runs of 377 thousand vehicles are minutes of wall clock, and a
// gate that slow on every merge gets switched off within a week -- better to say so than to
// discover it switched off. S1-S4 are milliseconds and live in test/sf.test.ts.
//
//     npm run validate:sf

import { readFileSync } from 'node:fs';
import { parseCity } from '../src/core/city.ts';
import { maxFlow } from '../src/core/maxflow.ts';
import { normalizeScenario, resolveParams } from '../src/core/scenario.ts';
import { createSim, metrics, tick, updateFrameStats } from '../src/core/sim.ts';
import type { City, Metrics, Scenario } from '../src/core/types.ts';

// The full horizon of §2, not the twelve hours Paradise needs: with the Bay Bridge gone the
// city is still emptying after a day and a half, and a run cut short reports t90 as "never"
// rather than as a number S6 can compare.
const UNTIL = 48 * 3600;

function publicCity(id: string): City {
  const b = readFileSync(`public/cities/${id}.bin`);
  return parseCity(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
}

const sf = publicCity('sf');

function go(name: string, mode?: 'static' | 'reactive'): Metrics {
  const s0 = normalizeScenario(JSON.parse(readFileSync(`public/scenarios/${name}.json`, 'utf8')) as Scenario);
  const p = resolveParams(mode ? { ...s0, routing: { ...s0.routing, mode } } : s0);
  const s = createSim(sf, p, s0.edits);
  s.maxFlowVehH = maxFlow(sf, p, s.blocked, s.lanes).valueVehH;
  const t0 = Date.now();
  while (s.t < UNTIL && s.evacuated < s.totalVeh - 1e-6) {
    tick(s);
    if (s.t % 60 === 0) updateFrameStats(s);
  }
  const m = metrics(s);
  console.log(
    `${name}${mode ? ` (${mode})` : ''}`.padEnd(30),
    `t50 ${hours(m.t50Sec)}  t90 ${hours(m.t90Sec)}  peak ${Math.round(m.peakOutflowVehH).toLocaleString('ru')} veh/h` +
      `  ${(m.efficiency * 100).toFixed(0)}% of ceiling  jam ${(m.maxSpillbackM / 1000).toFixed(0)} km` +
      `  [${((Date.now() - t0) / 1000).toFixed(0)} s]`,
  );
  return m;
}

function hours(sec: number | null): string {
  if (sec === null) return '—';
  const total = Math.round(sec / 60);
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
}

const base = go('sf-baseline');
const informed = go('sf-baseline', 'reactive');
const closed = go('sf-bridge-closed');

const fail: string[] = [];
if (base.t90Sec === null || base.t90Sec < 6 * 3600 || base.t90Sec > 24 * 3600) {
  fail.push(`S5: t90 ${hours(base.t90Sec)} outside 6-24 h`);
}
const t90 = (m: Metrics): number => m.t90Sec ?? Infinity;
if (base.t90Sec === null || t90(closed) <= t90(base)) {
  fail.push(`S6: closing the Bay Bridge did not raise t90 (${hours(base.t90Sec)} -> ${hours(closed.t90Sec)})`);
}

console.log(
  `\nwhat knowing where the jam is buys: ${hours(base.t90Sec)} -> ${hours(informed.t90Sec)}`,
);
for (const f of fail) console.error(`MISS  ${f}`);
process.exit(fail.length === 0 ? 0 : 1);
