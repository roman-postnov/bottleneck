// Wiring: the catalogue, the worker, the store and the renderer.
// Frames go straight from the worker to the renderer callback; only a throttled summary
// reaches React (see state.ts).

import { SimClient } from './simClient.ts';
import { getState, setState } from './state.ts';
import { defaultScenario, normalizeScenario } from '../core/scenario.ts';
import type { CityMeta, Edit, Scenario } from '../core/types.ts';
import type { FrameMessage, ReadyMessage } from '../worker/protocol.ts';

const CLOCK_INTERVAL_MS = 200;
/** Acceleration is averaged over a second: at x1 a 200 ms window reads 0 or 5, never 1. */
const SPEED_WINDOW_MS = 1000;

export type FrameSink = {
  onReady(msg: ReadyMessage): void;
  onFrame(msg: FrameMessage): void;
};

let sink: FrameSink | null = null;
let lastClockAt = 0;
let lastSpeedAt = 0;
let lastSpeedT = 0;
let actualX = 0;
let lastReady: ReadyMessage | null = null;

export const client = new SimClient();

export function attachRenderer(next: FrameSink | null): void {
  sink = next;
  if (sink && lastReady) sink.onReady(lastReady);
}

client.on('ready', (msg) => {
  lastReady = msg;
  lastClockAt = 0;
  lastSpeedAt = 0;
  lastSpeedT = 0;
  actualX = 0;
  setState({
    status: 'ready',
    error: null,
    ready: {
      E: msg.E,
      V: msg.V,
      meta: msg.meta,
      totalVeh: msg.totalVeh,
      maxFlowVehH: msg.maxFlowVehH,
      cutEdges: msg.cutEdges,
    },
    clock: { t: 0, evacuated: 0, enRoute: 0, notDeparted: msg.totalVeh, actualX: 0 },
    curve: [],
    metrics: null,
  });
  sink?.onReady(msg);
});

client.on('frame', (msg) => {
  sink?.onFrame(msg);
  const now = performance.now();
  // §1.1: the acceleration actually achieved. Measured from simulated time over wall time,
  // which survives the frames the worker skips; counting ticks per frame would not.
  if (lastSpeedAt === 0) {
    lastSpeedAt = now;
    lastSpeedT = msg.t;
  } else if (now - lastSpeedAt >= SPEED_WINDOW_MS) {
    actualX = ((msg.t - lastSpeedT) / (now - lastSpeedAt)) * 1000;
    lastSpeedAt = now;
    lastSpeedT = msg.t;
  }

  const dtWall = now - lastClockAt;
  if (dtWall < CLOCK_INTERVAL_MS) return;
  lastClockAt = now;
  setState({
    clock: {
      t: msg.t,
      evacuated: msg.evacuated,
      enRoute: msg.enRoute,
      notDeparted: msg.notDeparted,
      actualX: Math.max(0, actualX),
    },
  });
});

client.on('curve', (msg) => {
  setState({ curve: [...getState().curve, ...msg.points] });
});

client.on('done', (msg) => {
  setState({ status: 'done', metrics: msg.metrics });
});

client.on('probeResult', (msg) => {
  setState({ probe: msg });
});

client.on('error', (msg) => {
  setState({ status: 'error', error: `${msg.where}: ${msg.message}` });
});

export async function boot(): Promise<void> {
  setState({ status: 'loading' });
  try {
    const res = await fetch('cities/index.json');
    if (!res.ok) throw new Error(`cities/index.json: ${res.status}`);
    const cities = (await res.json()) as CityMeta[];
    setState({ cities });
    const first = new URLSearchParams(location.search).get('city') ?? cities[0]?.id;
    if (first) await selectCity(first);
  } catch (e) {
    setState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
  }
}

export async function selectCity(id: string): Promise<void> {
  const meta = getState().cities.find((c) => c.id === id);
  if (!meta) return;
  setState({ status: 'loading', cityId: id, probe: null, showCut: false });
  lastReady = null;
  // Absolute: a module worker resolves a relative fetch against its own script URL,
  // not against the page, so `cities/x.bin` would land under /src/worker/.
  client.init(new URL(`cities/${id}.bin`, location.href).href, meta);
  const scenario = defaultScenario(id);
  setState({ scenario });
  client.configure(scenario);
  client.speed(getState().speedX);
}

export function updateScenario(patch: (s: Scenario) => Scenario): void {
  const current = getState().scenario;
  if (!current) return;
  const next = normalizeScenario(patch(current));
  setState({ scenario: next, status: 'ready', curve: [], metrics: null });
  client.configure(next);
  client.speed(getState().speedX);
}

export function play(): void {
  setState({ status: 'running' });
  client.play();
}

export function pause(): void {
  setState({ status: 'paused' });
  client.pause();
}

export function reset(): void {
  setState({ status: 'ready', curve: [], metrics: null, probe: null });
  client.reset();
}

export function setSpeed(x: number): void {
  setState({ speedX: x });
  client.speed(x);
}

export function applyEdit(edits: Edit[]): void {
  setState({ curve: getState().curve, metrics: null });
  client.edit(edits);
}
