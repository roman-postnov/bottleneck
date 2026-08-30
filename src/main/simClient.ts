// The typed client for the simulation worker (CONTRACTS.md §8).
// The only place in the main thread that knows postMessage exists.

import type { CityMeta, Edit, Scenario } from '../core/types.ts';
import type { FrameMessage, MainToWorker, WorkerToMain } from '../worker/protocol.ts';

type Handlers = {
  [K in WorkerToMain['type']]: Array<(msg: Extract<WorkerToMain, { type: K }>) => void>;
};

export class SimClient {
  private readonly worker: Worker;
  private readonly handlers: Handlers = {
    ready: [],
    frame: [],
    curve: [],
    done: [],
    probeResult: [],
    names: [],
    network: [],
    error: [],
  };

  constructor() {
    this.worker = new Worker(new URL('../worker/sim.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.addEventListener('message', (ev: MessageEvent<WorkerToMain>) => {
      const msg = ev.data;
      for (const h of this.handlers[msg.type]) (h as (m: WorkerToMain) => void)(msg);
      // Frames are recycled the moment the listeners return, so a listener must copy
      // whatever it needs rather than keep the buffer (§8: main must give buffers back).
      if (msg.type === 'frame') this.recycle(msg as FrameMessage);
    });
  }

  on<K extends WorkerToMain['type']>(type: K, cb: (msg: Extract<WorkerToMain, { type: K }>) => void): () => void {
    const list = this.handlers[type] as Array<(m: Extract<WorkerToMain, { type: K }>) => void>;
    list.push(cb);
    return () => {
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
  }

  private send(msg: MainToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  init(cityUrl: string, meta: CityMeta): void {
    this.send({ type: 'init', cityUrl, meta });
  }
  configure(scenario: Scenario): void {
    this.send({ type: 'configure', scenario });
  }
  play(): void {
    this.send({ type: 'play' });
  }
  pause(): void {
    this.send({ type: 'pause' });
  }
  speed(ticksPerFrame: number): void {
    this.send({ type: 'speed', ticksPerFrame });
  }
  stepTo(tSec: number): void {
    this.send({ type: 'stepTo', tSec });
  }
  reset(): void {
    this.send({ type: 'reset' });
  }
  edit(edits: Edit[]): void {
    this.send({ type: 'edit', edits });
  }
  probe(edgeId: number): void {
    this.send({ type: 'probe', edgeId });
  }
  names(edgeIds: number[]): void {
    this.send({ type: 'names', edgeIds });
  }
  private recycle(frame: FrameMessage): void {
    this.send({ type: 'recycle', n: frame.n, outflow: frame.outflow, departed: frame.departed }, [
      frame.n.buffer,
      frame.outflow.buffer,
      frame.departed.buffer,
    ]);
    // The split snapshot rides along only on the frames where the field was rebuilt, and it
    // has its own pool in the worker, so it goes back on its own message.
    if (frame.split) this.send({ type: 'recycleField', split: frame.split }, [frame.split.buffer]);
  }

  dispose(): void {
    this.worker.terminate();
  }
}
