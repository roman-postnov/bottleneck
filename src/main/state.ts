// A small typed store. The application state IS the scenario (§9), plus whatever the run
// has reported so far; there is nothing here worth a state library.
//
// Frames never pass through this store. At sixty frames a second over tens of thousands of
// edges, a React render per frame is the one mistake a React shell invites.

import { useSyncExternalStore } from 'react';
import type { CityMeta, Metrics, Scenario } from '../core/types.ts';
import type { ReadyMessage, WorkerToMain } from '../worker/protocol.ts';

export type RunStatus = 'idle' | 'loading' | 'ready' | 'running' | 'paused' | 'done' | 'error';

export type ProbeResult = Extract<WorkerToMain, { type: 'probeResult' }>;

export type UiState = {
  cities: CityMeta[];
  cityId: string | null;
  scenario: Scenario | null;
  status: RunStatus;
  error: string | null;
  ready: Omit<ReadyMessage, 'type' | 'positions' | 'startIndices' | 'vertexOff' | 'storage'> | null;
  clock: { t: number; evacuated: number; enRoute: number; notDeparted: number; actualX: number };
  curve: number[];
  metrics: Metrics | null;
  probe: ProbeResult | null;
  speedX: number;
  showCut: boolean;
};

const initial: UiState = {
  cities: [],
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
