// The scenario is the application state, the permalink and the preset, all at once (§9).
// Two identical scenarios must produce identical results, so everything that can influence
// a run lives here and nothing else does.

import { DEFAULTS } from './params.ts';
import type { Edit, Params, Scenario } from './types.ts';

export const DEFAULT_SEED = 20261101;

export function defaultScenario(city: string): Scenario {
  return {
    v: 1,
    city,
    seed: DEFAULT_SEED,
    demand: {
      occupancy: DEFAULTS.occupancy,
      participation: DEFAULTS.participation,
      mobilizationHalfMin: DEFAULTS.mobilizationHalfMin,
    },
    supply: {
      satFlowPerLane: DEFAULTS.satFlowPerLane,
      jamSpacingM: DEFAULTS.jamSpacingM,
      speedFactor: 1.0,
      srcInjectLanes: DEFAULTS.srcInjectLanes,
    },
    routing: {
      informed: DEFAULTS.informed,
      reoptSec: DEFAULTS.reoptSec,
      logitTheta: DEFAULTS.logitTheta,
      splitEpsilon: DEFAULTS.splitEpsilon,
      ttSmoothing: DEFAULTS.ttSmoothing,
    },
    edits: [],
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/**
 * `routing.mode: 'static' | 'reactive'` was the two ends of what is now the `informed` dial.
 * Permalinks carrying it are already out in the world, and a scenario that silently loses its
 * routing would reproduce a different run under the same link (§10).
 */
function legacyRouting(
  input: DeepPartial<Scenario['routing']> | undefined,
): DeepPartial<Scenario['routing']> | undefined {
  if (!input) return input;
  const mode = (input as { mode?: unknown }).mode;
  if (mode === undefined || input.informed !== undefined) return input;
  const { ...rest } = input;
  delete (rest as { mode?: unknown }).mode;
  return { ...rest, informed: mode === 'reactive' ? 1 : 0 };
}

/** Fill in every omitted field from the defaults of §2. A partial scenario is never run. */
export function normalizeScenario(input: DeepPartial<Scenario> & { city: string }): Scenario {
  const d = defaultScenario(input.city);
  const s: Scenario = {
    v: 1,
    city: input.city,
    seed: input.seed ?? d.seed,
    demand: { ...d.demand, ...input.demand } as Scenario['demand'],
    supply: { ...d.supply, ...input.supply } as Scenario['supply'],
    routing: { ...d.routing, ...legacyRouting(input.routing) } as Scenario['routing'],
    edits: (input.edits as Edit[] | undefined) ?? [],
  };
  if (input.exits) s.exits = [...(input.exits as number[])];
  if (input.hazard) s.hazard = input.hazard as Scenario['hazard'];
  return s;
}

/** Flatten a scenario into the numeric struct the simulation reads every tick. */
export function resolveParams(s: Scenario): Params {
  return {
    seed: s.seed,

    occupancy: s.demand.occupancy,
    participation: s.demand.participation,
    mobilizationHalfMin: s.demand.mobilizationHalfMin,
    staging: s.demand.staging ?? null,

    satFlowPerLane: s.supply.satFlowPerLane,
    jamSpacingM: s.supply.jamSpacingM,
    speedFactor: s.supply.speedFactor,
    srcInjectLanes: s.supply.srcInjectLanes,

    exits: s.exits ?? null,

    informed: s.routing.informed,
    reoptSec: s.routing.reoptSec,
    logitTheta: s.routing.logitTheta,
    splitEpsilon: s.routing.splitEpsilon,
    ttSmoothing: s.routing.ttSmoothing,

    spillbackLoadThreshold: DEFAULTS.spillbackLoadThreshold,
    hazardCheckSec: s.hazard?.checkSec ?? DEFAULTS.hazardCheckSec,
    busSeats: DEFAULTS.busSeats,
    horizonSec: DEFAULTS.horizonSec,
  };
}

// ------------------------------------------------------------------ permalink

async function pipeThrough(bytes: Uint8Array, stream: TransformStream): Promise<Uint8Array> {
  const src = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(src).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** `?s=<base64url(deflate(json))>` -- the whole run in a URL (§9). */
export async function encodeScenario(s: Scenario): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(s));
  return toBase64Url(await pipeThrough(json, new CompressionStream('deflate-raw')));
}

export async function decodeScenario(text: string): Promise<Scenario> {
  const raw = await pipeThrough(fromBase64Url(text), new DecompressionStream('deflate-raw'));
  const parsed = JSON.parse(new TextDecoder().decode(raw)) as Scenario;
  if (parsed.v !== 1) throw new Error(`scenario version ${parsed.v}, only 1 is supported`);
  return normalizeScenario(parsed);
}
