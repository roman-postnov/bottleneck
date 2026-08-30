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
  | { type: 'recycle'; n: Float32Array; outflow: Float32Array; departed: Float32Array }
  | { type: 'recycleField'; split: Float32Array }
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

  // Everything below exists for the tracers of §13.2: one dot per vehicle, walking the graph.
  // The renderer still imports nothing from src/core (§15) -- the graph arrives as data.
  /** scenario.seed, so a dot's route is reproducible without src/render reaching into src/main. */
  seed: number;
  /** [V+1] the out-edges of node v are exactly the range [csrOff[v], csrOff[v+1]). */
  csrOff: Uint32Array;
  /** [E] head node of each edge. */
  edgeTo: Uint32Array;
  /** [V] 1 where a dot has left the city. */
  isExit: Uint8Array;
  /** [E] free-flow seconds, the model's own traversal time. */
  ttSec: Uint16Array;
  /** [E] split shares at t=0; later versions arrive on the frame. */
  split: Float32Array;
  /** [V] vehicles that start in each node's driveway. */
  demand0: Float32Array;
  /** Nodes with demand0 > 0. Two thirds of V on San Francisco, so worth the 37 KB. */
  demandNodes: Uint32Array;
  /** [V*2] node coordinates as metre offsets from meta.center -- see METER_OFFSETS in §13.2. */
  nodeXY: Float32Array;
  /** Gates the 4-bit route encoding of the trail: it needs maxOutDeg <= 16. */
  maxOutDeg: number;
  /** [V+1] CSR over building centroids by node. All zeros when the city has none. */
  bldOff: Uint32Array;
  /** [B*2] building centroids as metre offsets from meta.center, like nodeXY. */
  bldXY: Float32Array;
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

  /**
   * [E] moveOut summed over the ticks this frame covers -- a DELTA, not a level. The tracers
   * need the FIFO discharge of each edge, and it has to be moveOut rather than cap: under
   * spillback the node model drops moveOut to zero while cap is unchanged.
   *
   * A delta rather than a cumulative array because cumulative moveOut on an exit edge reaches
   * ~1e5, where a Float32 step is 0.008; the renderer accumulates into Float64 instead.
   */
  outflow: Float32Array;
  /** [V] moveSrc summed likewise: how many cars left each driveway. Drives dot departures. */
  departed: Float32Array;
  /**
   * Sum of n[e]. NOT enRoute, which also counts cars still queued in driveways and would
   * therefore overstate how many dots should be on a road.
   */
  onNetwork: number;
  /** SimState.fieldRev. `split` is attached only on the frame where this changes. */
  fieldRev: number;
  split?: Float32Array;
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
  /**
   * Sent only when an edit changes the network (§9.3). `storage` is here because the renderer
   * was reading the one from `ready` forever, and setLanes rewrites it -- so load, colour and
   * the queue length of a dot were all computed against a stale array after any lanes edit.
   */
  | { type: 'network'; storage: Float32Array; blocked: Uint8Array; ttSec: Uint16Array }
  | { type: 'error'; where: string; message: string };

/**
 * The worker's own global, narrowed to what we use. Pulling in the full WebWorker lib
 * alongside DOM makes TypeScript fight itself over `self`, and this is three lines.
 */
export interface WorkerScope {
  postMessage(message: WorkerToMain, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent<MainToWorker>) => void): void;
}
