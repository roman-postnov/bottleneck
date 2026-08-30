// The simulation worker (CONTRACTS.md §8). Owns the city and the SimState; the main thread
// only ever sees frames.

import { loadCity } from '../core/city.ts';
import { maxFlow } from '../core/maxflow.ts';
import { networkTotals } from '../core/metrics.ts';
import { resolveParams } from '../core/scenario.ts';
import { applyEdits, createSim, metrics, tick, updateFrameStats } from '../core/sim.ts';
import type { City, Metrics, Scenario, SimState } from '../core/types.ts';
import { FramePool } from './bufferPool.ts';
import { TickClock } from './clock.ts';
import { buildBuildingXY, buildEdgeGeometry, buildNodeXY } from './geometry.ts';
import type { WorkerScope, WorkerToMain } from './protocol.ts';

const ctx = globalThis as unknown as WorkerScope;

/** Compute slice per scheduling turn. Keeps the worker answering messages while it runs. */
const SLICE_MS = 12;
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
let stopAt = Number.POSITIVE_INFINITY;

const pool = new FramePool();
const clock = new TickClock();
let sentFieldRev = -1;
let curve: number[] = [];
let nextCurveAt = 0;
let finishedSent = false;

function post(msg: WorkerToMain, transfer: Transferable[] = []): void {
  ctx.postMessage(msg, transfer);
}

function fail(where: string, err: unknown): void {
  post({ type: 'error', where, message: err instanceof Error ? err.message : String(err) });
}

function configure(next: Scenario): void {
  if (!city) throw new Error('configure before init');
  scenario = next;
  const params = resolveParams(next);
  const s = createSim(city, params, next.edits);

  const mf = maxFlow(city, params, s.blocked, s.lanes);
  s.maxFlowVehH = mf.valueVehH;
  sim = s;

  pool.reset(city.E, city.V);
  clock.reset();
  sentFieldRev = s.fieldRev;
  curve = [];
  nextCurveAt = 0;
  finishedSent = false;

  const geo = buildEdgeGeometry(city);
  const storage = Float32Array.from(s.storage);

  // Copies, not the city's own views, and not s.ttSec either. Every section of city.bin is a
  // view on one ArrayBuffer (§5) and s.ttSec IS s.ringLen -- transferring any of them would
  // detach the buffer the simulation is still running on.
  const csrOff = Uint32Array.from(city.csrOff);
  const edgeTo = Uint32Array.from(city.edgeTo);
  const isExit = Uint8Array.from(city.isExit);
  const ttSec = Uint16Array.from(s.ttSec);
  const split = Float32Array.from(s.field.split);
  const demand0 = Float32Array.from(s.demand0);
  const nodeXY = buildNodeXY(city, (city.meta as ReadyMeta).center);
  const bldOff = Uint32Array.from(city.bldOff);
  const bldXY = buildBuildingXY(city, (city.meta as ReadyMeta).center);

  const nodes: number[] = [];
  for (let v = 0; v < city.V; v++) if (demand0[v] > 0) nodes.push(v);
  const demandNodes = Uint32Array.from(nodes);

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
      seed: params.seed,
      csrOff,
      edgeTo,
      isExit,
      ttSec,
      split,
      demand0,
      demandNodes,
      nodeXY,
      maxOutDeg: city.maxOutDeg,
      bldOff,
      bldXY,
    },
    [
      storage.buffer,
      geo.positions.buffer,
      geo.startIndices.buffer,
      csrOff.buffer,
      edgeTo.buffer,
      isExit.buffer,
      ttSec.buffer,
      split.buffer,
      demand0.buffer,
      demandNodes.buffer,
      nodeXY.buffer,
      bldOff.buffer,
      bldXY.buffer,
    ],
  );
  emitFrame(0, 0, true);
}

type ReadyMeta = Extract<WorkerToMain, { type: 'ready' }>['meta'];

function emitFrame(ticksInFrame: number, wallMs: number, force = false): void {
  const s = sim;
  if (!s) return;
  const now = performance.now();
  if (!clock.frameDue(now, force)) return;

  // No free buffer means the main thread has not returned one yet -- skip the frame and
  // keep simulating. Waiting here would make the simulator look hung (§8).
  const set = pool.takeSet();
  if (!set) return;

  clock.markFrame(now);
  updateFrameStats(s);
  set.n.set(s.n);
  // Drained, not read: the accumulators are cleared only here, on a post that is definitely
  // going out, so a frame skipped for want of a buffer folds into the next one instead of
  // losing its flows. The renderer places one dot per vehicle and a lost departure is a
  // car that never appears.
  set.outflow.set(s.outAccum);
  s.outAccum.fill(0);
  set.departed.set(s.depAccum);
  s.depAccum.fill(0);

  const transfer: Transferable[] = [set.n.buffer, set.outflow.buffer, set.departed.buffer];
  let split: Float32Array | undefined;
  if (s.fieldRev !== sentFieldRev) {
    const buf = pool.takeSplit();
    // Nothing free: leave sentFieldRev alone so the next frame tries again. The tracers keep
    // routing on the previous field for a few frames, which is what they already do between
    // reoptimisations anyway.
    if (buf) {
      buf.set(s.field.split);
      split = buf;
      transfer.push(buf.buffer);
      sentFieldRev = s.fieldRev;
    }
  }

  const { enRoute, notDeparted, onNetwork } = networkTotals(s);
  post(
    {
      type: 'frame',
      t: s.t,
      n: set.n,
      evacuated: s.evacuated,
      enRoute,
      notDeparted,
      ticksInFrame,
      wallMs,
      outflow: set.outflow,
      departed: set.departed,
      onNetwork,
      fieldRev: s.fieldRev,
      split,
    },
    transfer,
  );
}

/**
 * §9.3 changes storage, blocked and cap under a running network. The renderer used to keep the
 * `storage` it got at configure time forever, so every load, colour and queue length went stale
 * after a lanes or contraflow edit. Rare and user-driven, so fresh arrays rather than a pool.
 */
function postNetwork(s: SimState): void {
  const storage = Float32Array.from(s.storage);
  const blocked = Uint8Array.from(s.blocked);
  const ttSec = Uint16Array.from(s.ttSec);
  post({ type: 'network', storage, blocked, ttSec }, [storage.buffer, blocked.buffer, ttSec.buffer]);
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
  return s.t >= stopAt || s.t >= s.params.horizonSec || (s.totalVeh > 0 && s.evacuated >= s.totalVeh * (1 - 1e-6));
}

function step(): void {
  const s = sim;
  if (!(s && playing)) return;

  const { want, sleepMs } = clock.plan(performance.now(), speedX);
  if (want < 1) {
    setTimeout(step, sleepMs);
    return;
  }

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
    postNetwork(s);
  }
  // Whatever did not fit in the slice is dropped, not carried: the hardware is the limit
  // and the UI shows the acceleration actually achieved (§1.1).
  clock.dropRemainder();
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

/**
 * Deferred like `configure`: the names of a preset's edits are asked for in the same breath as
 * the scenario, and the city is still being fetched then.
 */
function answerNames(edgeIds: number[]): void {
  cityReady
    ?.then(() => {
      const s = sim;
      if (!(s && city)) return;
      const names: Record<number, string> = {};
      for (const id of edgeIds) {
        const e = s.indexOfEdgeId.get(id);
        if (e !== undefined) names[id] = city.nameOf(e);
      }
      post({ type: 'names', names });
    })
    .catch((e) => fail('names', e));
}

function answerProbe(edgeId: number): void {
  const s = sim;
  if (!(s && city)) return;
  const e = s.indexOfEdgeId.get(edgeId);
  if (e === undefined) return;
  post({
    type: 'probeResult',
    edgeId,
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
}

function resume(): void {
  if (!sim || playing) return;
  playing = true;
  clock.restart();
  setTimeout(step, 0);
}

ctx.addEventListener('message', (ev) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'init': {
        const url = msg.cityUrl;
        const meta = msg.meta;
        cityReady = loadCity(url, meta).then((c) => {
          city = c;
          return c;
        });
        cityReady.catch((e) => fail('init', e));
        break;
      }

      case 'configure': {
        playing = false;
        stopAt = Number.POSITIVE_INFINITY;
        if (!cityReady) {
          fail('configure', new Error('configure before init'));
          break;
        }
        const scenarioToRun = msg.scenario;
        cityReady.then(() => configure(scenarioToRun)).catch((e) => fail('configure', e));
        break;
      }

      case 'play':
        stopAt = Number.POSITIVE_INFINITY;
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
          postNetwork(sim);
          emitFrame(0, 0, true);
        }
        break;

      case 'recycle':
        if (city && msg.n.length === city.E && msg.departed.length === city.V) {
          pool.giveSet({ n: msg.n, outflow: msg.outflow, departed: msg.departed });
        }
        break;

      case 'recycleField':
        if (city && msg.split.length === city.E) pool.giveSplit(msg.split);
        break;

      case 'names':
        answerNames(msg.edgeIds);
        break;

      case 'probe':
        answerProbe(msg.edgeId);
        break;
      default:
        throw new Error(`unknown message ${JSON.stringify(msg)}`);
    }
  } catch (e) {
    fail(msg.type, e);
  }
});
