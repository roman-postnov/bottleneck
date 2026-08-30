// A small typed store. The application state IS the scenario (§9), plus whatever the run
// has reported so far; there is nothing here worth a state library.
//
// Frames never pass through this store. At sixty frames a second over tens of thousands of
// edges, a React render per frame is the one mistake a React shell invites.

import { useSyncExternalStore } from 'react';
import type { CityMeta, Metrics, Scenario } from '../core/types.ts';
import type { Theme } from '../render/palette.ts';
import type { ReadyMessage, WorkerToMain } from '../worker/protocol.ts';

export type RunStatus = 'idle' | 'loading' | 'ready' | 'running' | 'paused' | 'done' | 'error';

export type ProbeResult = Extract<WorkerToMain, { type: 'probeResult' }>;

export type PresetInfo = { id: string; city: string; label: string };

/**
 * What the UI needs off the ready message, and nothing else. Picked field by field rather than
 * Omit-ed: `ready` now also carries the graph for the tracers (§13.2), and a dozen typed arrays
 * the length of E have no business sitting in React state.
 */
export type ReadyInfo = Pick<
  ReadyMessage,
  'E' | 'V' | 'meta' | 'totalVeh' | 'maxFlowVehH' | 'cutEdges'
>;

/** Milliseconds per frame, split the way §13 splits the frame loop. */
export type FrameCost = {
  total: number;
  paint: number;
  step: number;
  place: number;
  upload: number;
  dots: number;
  parked: number;
  stuck: number;
  /** max |dots on an edge - n[e]|: the self-check on the Newell placement of §13.2. */
  dotErr: number;
  zoom: number;
};

/** The car being followed. Pushed through the store on a throttle, never per frame. */
export type FollowedCar = {
  /** Slot index, which is a stable car id for the whole run: slots are never reused. */
  slot: number;
  state: 'parked' | 'moving' | 'arrived' | 'stuck';
  /** Simulated seconds. -1 before it left the driveway. */
  departedAt: number;
  /** Simulated seconds. -1 until it leaves the city. */
  arrivedAt: number;
  /** Simulated seconds it has been travelling. */
  elapsed: number;
  hops: number;
  routeTruncated: boolean;
  originEdgeId: number;
  currentEdgeId: number;
};

export type UiState = {
  cities: CityMeta[];
  presets: PresetInfo[];
  presetId: string | null;
  cityId: string | null;
  scenario: Scenario | null;
  status: RunStatus;
  error: string | null;
  ready: ReadyInfo | null;
  clock: { t: number; evacuated: number; enRoute: number; notDeparted: number; actualX: number };
  curve: number[];
  metrics: Metrics | null;
  probe: ProbeResult | null;
  speedX: number;
  showCut: boolean;
  theme: Theme;
  particles: boolean;
  /** Cars still in a driveway. The whole fleet at t = 0, so it is worth being able to hide. */
  showParked: boolean;
  followed: FollowedCar | null;
  perf: FrameCost | null;
  /** T90 of the last completed run that carried no edits, for the delta an intervention
   *  is judged by. Cleared when the city changes. */
  baselineT90: number | null;
  link: string | null;
  /** Road names for the edges the user has probed, so the edit list can say "Skyway" rather
   *  than an edge id. Not part of the scenario: a permalink carries ids only (§9.2). */
  edgeNames: Record<number, string>;
};

const initial: UiState = {
  cities: [],
  presets: [],
  presetId: null,
  cityId: null,
  scenario: null,
  status: 'idle',
  error: null,
  ready: null,
  clock: { t: 0, evacuated: 0, enRoute: 0, notDeparted: 0, actualX: 0 },
  curve: [],
  metrics: null,
  probe: null,
  speedX: 60,
  showCut: false,
  theme: 'light',
  particles: true,
  showParked: true,
  followed: null,
  perf: null,
  baselineT90: null,
  link: null,
  edgeNames: {},
};

let state = initial;
const listeners = new Set<() => void>();

export function getState(): UiState {
  return state;
}

export function setState(patch: Partial<UiState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(select: (s: UiState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => select(state),
    () => select(initial),
  );
}
