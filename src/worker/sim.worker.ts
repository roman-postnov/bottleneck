// The simulation worker (CONTRACTS.md §8). Owns the city and the SimState; the main thread
// only ever sees frames.

import { parseCity } from '../core/city.ts';
import { createSim, tick, applyEdits, metrics, updateFrameStats } from '../core/sim.ts';
import { maxFlow } from '../core/maxflow.ts';
import { resolveParams } from '../core/scenario.ts';
import { buildEdgeGeometry } from './geometry.ts';
import type { City, Metrics, Scenario, SimState } from '../core/types.ts';
import type { WorkerScope, WorkerToMain } from './protocol.ts';

const ctx = self as unknown as WorkerScope;

/** Compute slice per scheduling turn. Keeps the worker answering messages while it runs. */
const SLICE_MS = 12;
/** Frames are thinned to this cadence; ticks are never dropped, only frames (§1.1). */
const FRAME_INTERVAL_MS = 16;
const CURVE_EVERY_SEC = 60;

let city: City | null = null;
/** init loads over the network; configure arrives right behind it and has to wait. */
let cityReady: Promise<City> | null = null;
let sim: SimState | null = null;
let scenario: Scenario | null = null;

let playing = false;
/**
 * §8 calls this ticksPerFrame and §1.1 calls it target acceleration; taken here as
 * simulated seconds per wall second, which is the only reading under which the 1..600 range
 * and the word "acceleration" agree.
 */
let speedX = 60;
let stopAt = Infinity;

const pool: Float32Array[] = [];
let lastFrameAt = 0;
let lastStepAt = 0;
/** Fractional ticks carried between turns; flooring per turn would ignore slow speeds. */
let tickDebt = 0;
let curve: number[] = [];
let nextCurveAt = 0;
let finishedSent = false;

function post(msg: WorkerToMain, transfer: Transferable[] = []): void {
  ctx.postMessage(msg, transfer);
}

function fail(where: string, err: unknown): void {
  post({ type: 'error', where, message: err instanceof Error ? err.message : String(err) });
}

async function loadCityFrom(url: string): Promise<City> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return parseCity(await res.arrayBuffer());
}

function configure(next: Scenario): void {
  if (!city) throw new Error('configure before init');
  scenario = next;
  const params = resolveParams(next);
  const s = createSim(city, params, next.edits);

  const mf = maxFlow(city, params, s.blocked, s.lanes);
  s.maxFlowVehH = mf.valueVehH;
  sim = s;

  pool.length = 0;
  pool.push(new Float32Array(city.E), new Float32Array(city.E));
  curve = [];
  nextCurveAt = 0;
  finishedSent = false;
  lastFrameAt = 0;
  lastStepAt = 0;

  const geo = buildEdgeGeometry(city);
  const storage = Float32Array.from(s.storage);
  post(
    {
      type: 'ready',
      meta: city.meta as ReadyMeta,
      E: city.E,
      V: city.V,
      totalVeh: s.totalVeh,
      storage,
      positions: geo.positions,
      startIndices: geo.startIndices,
      vertexOff: Uint32Array.from(geo.startIndices),
      maxFlowVehH: mf.valueVehH,
      cutEdges: mf.cutEdges,
    },
    [storage.buffer, geo.positions.buffer, geo.startIndices.buffer],
  );
  emitFrame(0, 0, true);
}

type ReadyMeta = Extract<WorkerToMain, { type: 'ready' }>['meta'];

function totals(s: SimState): { enRoute: number; notDeparted: number } {
  let enRoute = 0;
  let notDeparted = 0;
  for (let v = 0; v < s.city.V; v++) {
    notDeparted += s.waiting[v];
    enRoute += s.queued[v];
  }
  for (let e = 0; e < s.city.E; e++) enRoute += s.n[e];
  return { enRoute, notDeparted };
}

function emitFrame(ticksInFrame: number, wallMs: number, force = false): void {
  const s = sim;
  if (!s) return;
  const now = performance.now();
  if (!force && now - lastFrameAt < FRAME_INTERVAL_MS) return;

  // No free buffer means the main thread has not returned one yet -- skip the frame and
  // keep simulating. Waiting here would make the simulator look hung (§8).
  const buf = pool.pop();
  if (!buf) return;

  lastFrameAt = now;
  updateFrameStats(s);
  buf.set(s.n);
  const { enRoute, notDeparted } = totals(s);
  post(
    {
      type: 'frame',
      t: s.t,
      n: buf,
      evacuated: s.evacuated,
      enRoute,
      notDeparted,
      ticksInFrame,
      wallMs,
    },
    [buf.buffer],
  );
}

function emitCurve(): void {
  const s = sim;
  if (!s || s.t < nextCurveAt) return;
  while (nextCurveAt <= s.t) nextCurveAt += CURVE_EVERY_SEC;
  curve.push(s.t, s.totalVeh > 0 ? s.evacuated / s.totalVeh : 0);
  // Small batches: the main thread reads T50/T90 off this curve while the run is going,
  // and a fat batch would show the crossing minutes of simulated time after it happened.
  if (curve.length >= 8) {
    const points = Float32Array.from(curve);
    curve = [];
    post({ type: 'curve', points }, [points.buffer]);
  }
}

function flushCurve(): void {
  if (curve.length === 0) return;
  const points = Float32Array.from(curve);
  curve = [];
  post({ type: 'curve', points }, [points.buffer]);
}

function finished(s: SimState): boolean {
  return (
    s.t >= stopAt ||
    s.t >= s.params.horizonSec ||
    (s.totalVeh > 0 && s.evacuated >= s.totalVeh * (1 - 1e-6))
  );
}

function step(): void {
  const s = sim;
  if (!s || !playing) return;

  const now = performance.now();
  const dtSec = lastStepAt === 0 ? 1 / 60 : (now - lastStepAt) / 1000;
  lastStepAt = now;

  // Capping elapsed time instead of the debt would break slow speeds: at x1 the worker
  // sleeps a whole second between ticks, and a 0.1 s cap would turn x1 into x0.1.
  tickDebt = Math.min(tickDebt + speedX * dtSec, speedX * 0.25 + 1);
  const want = Math.floor(tickDebt);
  if (want < 1) {
    // Not a whole tick due yet. Sleeping until it is keeps x1 at x1 instead of running as
    // fast as the scheduler will fire.
    setTimeout(step, Math.max(1, ((1 - tickDebt) / speedX) * 1000));
    return;
  }
  tickDebt -= want;

  const t0 = performance.now();
  let ticks = 0;
  const cursorBefore = s.scheduleCursor;
  while (ticks < want && !finished(s)) {
    tick(s);
    ticks++;
    if (performance.now() - t0 >= SLICE_MS) break;
  }
  // A scheduled closure changes the ceiling the run is measured against (§11), and the panel
  // would otherwise keep quoting the max-flow of a road that is no longer there.
  if (s.scheduleCursor !== cursorBefore && city) {
    s.maxFlowVehH = maxFlow(city, s.params, s.blocked, s.lanes).valueVehH;
  }
  // Whatever did not fit in the slice is dropped, not carried: the hardware is the limit
  // and the UI shows the acceleration actually achieved (§1.1).
  tickDebt = 0;
  const wallMs = performance.now() - t0;

  emitFrame(ticks, wallMs);
  emitCurve();

  if (finished(s)) {
    playing = false;
    emitFrame(ticks, wallMs, true);
    flushCurve();
    if (!finishedSent) {
      finishedSent = true;
      post({ type: 'done', metrics: metrics(s) as Metrics });
    }
    return;
  }
  setTimeout(step, 0);
}

function resume(): void {
  if (!sim || playing) return;
  playing = true;
  lastStepAt = 0;
  tickDebt = 0;
  setTimeout(step, 0);
}

ctx.addEventListener('message', (ev) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'init': {
        const url = msg.cityUrl;
        const meta = msg.meta;
        cityReady = loadCityFrom(url).then((c) => {
          c.meta = meta;
          city = c;
          return c;
        });
        cityReady.catch((e) => fail('init', e));
        break;
      }

      case 'configure': {
        playing = false;
        stopAt = Infinity;
        if (!cityReady) {
          fail('configure', new Error('configure before init'));
          break;
        }
        const scenarioToRun = msg.scenario;
        void cityReady
          .then(() => configure(scenarioToRun))
          .catch((e) => fail('configure', e));
        break;
      }

      case 'play':
        stopAt = Infinity;
        resume();
        break;

      case 'pause':
        playing = false;
        break;

      case 'speed':
        speedX = Math.max(1, msg.ticksPerFrame);
        break;

      case 'stepTo':
        stopAt = msg.tSec;
        resume();
        break;

      case 'reset':
        if (scenario) configure(scenario);
        break;

      case 'edit':
        if (sim) {
          applyEdits(sim, msg.edits);
          if (city) sim.maxFlowVehH = maxFlow(city, sim.params, sim.blocked, sim.lanes).valueVehH;
          emitFrame(0, 0, true);
        }
        break;

      case 'recycle':
        if (city && msg.n.length === city.E) pool.push(msg.n);
        break;

      case 'names': {
        // Deferred like `configure`: the names of a preset's edits are asked for in the same
        // breath as the scenario, and the city is still being fetched then.
        const ids = msg.edgeIds;
        void cityReady?.then(() => {
          const s = sim;
          if (!s || !city) return;
          const names: Record<number, string> = {};
          for (const id of ids) {
            const e = s.indexOfEdgeId.get(id);
            if (e !== undefined) names[id] = city.nameOf(e);
          }
          post({ type: 'names', names });
        });
        break;
      }

      case 'probe': {
        const s = sim;
        if (!s || !city) break;
        const e = s.indexOfEdgeId.get(msg.edgeId);
        if (e === undefined) break;
        post({
          type: 'probeResult',
          edgeId: msg.edgeId,
          name: city.nameOf(e),
          lanes: s.lanes[e],
          capVehH: Math.round(s.cap[e] * 3600),
          n: s.n[e],
          storage: s.storage[e],
          ttSec: s.ttSec[e],
          load: s.n[e] / s.storage[e],
          twin: city.twin[e],
          blocked: s.blocked[e] === 1,
        });
        break;
      }
    }
  } catch (e) {
    fail(msg.type, e);
  }
});
