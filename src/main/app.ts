// Wiring: the catalogue, the worker, the store and the renderer.
// Frames go straight from the worker to the renderer callback; only a throttled summary
// reaches React (see state.ts).

import { decodeScenario, defaultScenario, encodeScenario, normalizeScenario } from '../core/scenario.ts';
import type { CityMeta, Edit, Scenario } from '../core/types.ts';
import type { FrameMessage, ReadyMessage, WorkerToMain } from '../worker/protocol.ts';
import { SimClient } from './simClient.ts';
import { getState, type PresetInfo, setState } from './state.ts';

const CLOCK_INTERVAL_MS = 200;
/** Acceleration is averaged over a second: at x1 a 200 ms window reads 0 or 5, never 1. */
const SPEED_WINDOW_MS = 1000;

export type NetworkMessage = Extract<WorkerToMain, { type: 'network' }>;

export type FrameSink = {
  onReady: (msg: ReadyMessage) => void;
  onFrame: (msg: FrameMessage) => void;
  /** An edit changed storage, blocked or ttSec under the running network (§9.3). */
  onNetwork: (msg: NetworkMessage) => void;
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

client.on('network', (msg) => {
  sink?.onNetwork(msg);
});

client.on('curve', (msg) => {
  setState({ curve: [...getState().curve, ...msg.points] });
});

client.on('done', (msg) => {
  const s = getState();
  const clean = s.scenario !== null && s.scenario.edits.length === 0;
  setState({
    status: 'done',
    metrics: msg.metrics,
    baselineT90: clean ? msg.metrics.t90Sec : s.baselineT90,
  });
});

client.on('names', (msg) => {
  setState({ edgeNames: { ...getState().edgeNames, ...msg.names } });
});

client.on('probeResult', (msg) => {
  setState({
    probe: msg,
    edgeNames: { ...getState().edgeNames, [msg.edgeId]: msg.name },
  });
});

client.on('error', (msg) => {
  setState({ status: 'error', error: `${msg.where}: ${msg.message}` });
});

/** Every rejection the UI can start ends up here, and from here in the error banner. */
export function reportError(e: unknown): void {
  setState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
}

export async function boot(): Promise<void> {
  setState({ status: 'loading' });
  try {
    const res = await fetch('cities/index.json');
    if (!res.ok) throw new Error(`cities/index.json: ${res.status}`);
    const cities = (await res.json()) as CityMeta[];
    setState({ cities, presets: await presetIndex() });
    const query = new URLSearchParams(location.search);

    // ?s= carries the whole run (§9). It wins over ?city=: a scenario names its own city, and
    // opening a shared link on a different graph would silently show something else.
    const packed = query.get('s');
    if (packed) {
      const scenario = await decodeScenario(packed);
      selectCity(scenario.city);
      updateScenario(() => scenario);
      return;
    }

    const preset = query.get('preset');
    if (preset) {
      await selectPreset(preset);
      return;
    }

    const first = query.get('city') ?? cities[0]?.id;
    if (first) selectCity(first);
  } catch (e) {
    reportError(e);
  }
}

/** The presets of §18 are files; without a list of them the app can only reach one by URL. */
async function presetIndex(): Promise<PresetInfo[]> {
  try {
    const r = await fetch('scenarios/index.json');
    return r.ok ? ((await r.json()) as PresetInfo[]) : [];
  } catch {
    return [];
  }
}

export async function selectPreset(id: string): Promise<void> {
  const r = await fetch(`scenarios/${id}.json`);
  if (!r.ok) throw new Error(`scenarios/${id}.json: ${r.status}`);
  const scenario = normalizeScenario((await r.json()) as Scenario);
  selectCity(scenario.city);
  updateScenario(() => scenario);
  setState({ presetId: id });
}

export function selectCity(id: string): void {
  const meta = getState().cities.find((c) => c.id === id);
  if (!meta) return;
  setState({
    status: 'loading',
    cityId: id,
    presetId: null,
    probe: null,
    showCut: false,
    baselineT90: null,
    link: null,
  });
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
  setState({ scenario: next, status: 'ready', curve: [], metrics: null, link: null });
  client.configure(next);
  client.speed(getState().speedX);
  askNames(next);
}

/** A permalink carries edge ids and nothing else (§9.2), so a scenario opened from a link
 *  would list "road #3842" where the whole point is that it is Pentz Road. */
function askNames(s: Scenario): void {
  const known = getState().edgeNames;
  const want = s.edits
    .map((e) => (e.op === 'addRoad' ? -1 : e.edgeId))
    .filter((id) => id >= 0 && known[id] === undefined);
  if (want.length > 0) client.names([...new Set(want)]);
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

/**
 * An intervention made while the run is going (§9.1). It is applied hot AND written into the
 * scenario stamped with the minute it happened, which is the only reason the permalink
 * reproduces what was on screen rather than a run where the road closed at zero.
 *
 * `configure` is deliberately not called: it would restart the evacuation under the user.
 */
export function applyEdit(edit: Edit): void {
  const s = getState();
  if (!s.scenario) return;
  const stamped: Edit = edit.op === 'addRoad' ? edit : { ...edit, atMin: Math.round(getState().clock.t / 60) };
  setState({
    scenario: { ...s.scenario, edits: [...s.scenario.edits, stamped] },
    metrics: null,
    link: null,
  });
  client.edit([stamped]);
}

/** Removing an edit cannot be undone hot -- the network has to be rebuilt, and the run with
 *  it. The UI says so before calling this. */
export function removeEdit(from: number, to: number = from): void {
  const s = getState();
  if (!s.scenario) return;
  const edits = s.scenario.edits.filter((_, i) => i < from || i > to);
  updateScenario((sc) => ({ ...sc, edits }));
}

export async function copyLink(): Promise<void> {
  const s = getState();
  if (!s.scenario) return;
  const url = new URL(location.href);
  url.search = `?s=${await encodeScenario(s.scenario)}`;
  const link = url.toString();
  setState({ link });
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    // Clipboard needs a permission the page may not have; the link is shown either way.
  }
}
