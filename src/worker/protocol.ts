// The worker protocol of CONTRACTS.md §8, as a discriminated union.
// Both sides import this file, so a protocol drift is a compile error rather than a blank
// screen thirty hours in.

import type { CityMeta, Edit, Metrics, Scenario } from '../core/types.ts';

export type MainToWorker =
  | { type: 'init'; cityUrl: string; meta: CityMeta }
  | { type: 'configure'; scenario: Scenario }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'speed'; ticksPerFrame: number }
  | { type: 'stepTo'; tSec: number }
  | { type: 'reset' }
  | { type: 'edit'; edits: Edit[] }
  | { type: 'recycle'; n: Float32Array }
  | { type: 'probe'; edgeId: number }
  | { type: 'names'; edgeIds: number[] };

export type ReadyMessage = {
  type: 'ready';
  meta: CityMeta;
  E: number;
  V: number;
  totalVeh: number;
  /** [E] -- the frame carries only n, and load = n / storage (§8). */
  storage: Float32Array;
  /** Flattened [lon, lat] pairs for every vertex of every edge polyline (§13). */
  positions: Float64Array;
  /** [E+1] vertex index where each edge's polyline starts. Uint32, never Uint16 (§13.1). */
  startIndices: Uint32Array;
  vertexOff: Uint32Array;
  maxFlowVehH: number;
  cutEdges: Uint32Array;
};

export type FrameMessage = {
  type: 'frame';
  t: number;
  n: Float32Array;
  evacuated: number;
  enRoute: number;
  notDeparted: number;
  ticksInFrame: number;
  wallMs: number;
};

export type WorkerToMain =
  | ReadyMessage
  | FrameMessage
  | { type: 'curve'; points: Float32Array }
  | { type: 'done'; metrics: Metrics }
  | {
      type: 'probeResult';
      edgeId: number;
      name: string;
      lanes: number;
      capVehH: number;
      n: number;
      storage: number;
      ttSec: number;
      load: number;
      /** 0xFFFFFFFF when the road has no opposite direction: §9.3 cannot contraflow it. */
      twin: number;
      blocked: boolean;
    }
  | { type: 'names'; names: Record<number, string> }
  | { type: 'error'; where: string; message: string };

/**
 * The worker's own global, narrowed to what we use. Pulling in the full WebWorker lib
 * alongside DOM makes TypeScript fight itself over `self`, and this is three lines.
 */
export interface WorkerScope {
  postMessage(message: WorkerToMain, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent<MainToWorker>) => void): void;
}
