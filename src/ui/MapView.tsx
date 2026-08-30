// Owns the map and the deck.gl overlay. Frames are written straight into the colour buffer
// here; nothing about a frame goes through React state.
//
// Drawing is driven by requestAnimationFrame, not by the arrival of a frame: at x1 a frame is
// a whole second away, and the cut has to keep pulsing between frames. The cars advance on
// SIMULATED time -- see simT below.

import { useEffect, useRef } from 'react';
import { initMap, BASEMAP, type MapHandle, type PickHit } from '../render/map.ts';
import {
  createGraphView,
  cutLayer,
  cutPaths,
  paint,
  roadLayer,
  type CutPaths,
  type GraphView,
} from '../render/layers.ts';
import {
  advance,
  carPosition,
  createTracers,
  cumulative,
  dotError,
  onFrame,
  parkedSlotAt,
  replayRoute,
  toMeterOffsets,
  setNetwork,
  writeParked,
  writePositions,
  ARRIVED,
  MOVING,
  PARKED,
  STUCK,
  type TracerField,
} from '../render/tracers.ts';
import {
  carsLayer,
  edgePaths,
  followLayer,
  parkedLayer,
  stuckLayer,
  trailLayer,
} from '../render/carLayers.ts';
import { PALETTE, type Palette } from '../render/palette.ts';
import { attachRenderer, client } from '../main/app.ts';
import { setState, useStore, type FollowedCar } from '../main/state.ts';

const PULSE_MS = 1400;
/** Averaged over wall time, not over a frame count: at a low frame rate a 30-frame window
 *  leaves the readout showing the first seconds of the run for half a minute. */
const PERF_WINDOW_MS = 500;
/** How fast the simulated clock estimate follows a change in the achieved acceleration. */
const RATE_TAU_MS = 1000;
/** Authority the lag term has over the rate. Bounded so simT can never run backwards. */
const CATCHUP = 0.25;
/** The panel is React; it gets the followed car on the same throttle as the clock. */
const FOLLOW_INTERVAL_MS = 200;

type Scene = {
  view: GraphView;
  storage: Float32Array;
  cut: CutPaths;
  n: Float32Array;
  field: TracerField;
  origin: [lon: number, lat: number];
  /** Simulated seconds, interpolated between frames. */
  simT: number;
  /** Simulated seconds per wall second, as actually achieved by the worker. */
  rate: number;
  /** Newest frame's t, the anchor the lag term corrects towards. */
  targetT: number;
  lastT: number;
  lastWallMs: number;
  /** Wall clock of the previous rAF, for the simulated-time step. */
  lastRafMs: number;
  followed: number;
  trail: Array<Array<[number, number]>>;
  trailHops: number;
};

export function MapView(): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapHandle | null>(null);
  const sceneRef = useRef<Scene | null>(null);

  const showCut = useStore((s) => s.showCut);
  const running = useStore((s) => s.status === 'running');
  const theme = useStore((s) => s.theme);
  const particles = useStore((s) => s.particles);
  const showParked = useStore((s) => s.showParked);

  // Read inside the animation loop without restarting it on every toggle.
  const opts = useRef({ showCut, theme, particles, showParked, running });
  opts.current = { showCut, theme, particles, showParked, running };
  const repaint = useRef(true);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handle = initMap(host, [37.76, -122.44], 12, BASEMAP[opts.current.theme]);
    mapRef.current = handle;
    handle.onPick((hit) => pick(sceneRef.current, hit));

    let raf = 0;
    let window_: number[][] = [];
    let windowAt = 0;
    let followAt = 0;

    const loop = (now: number): void => {
      raf = requestAnimationFrame(loop);
      const s = sceneRef.current;
      if (!s) return;
      const palette = PALETTE[opts.current.theme];
      const zoom = handle.map.getZoom();
      const cost = [0, 0, 0, 0];

      // Paused means paused: the cars stand still. They are the only thing on screen that
      // claims to be a vehicle, and crawling ones on a stopped clock read as a running model.
      // Freezing the rate rather than resetting it makes resume instant instead of a ramp.
      advanceSimT(s, now, opts.current.running);

      let t = performance.now();
      if (repaint.current) {
        paint(s.view, s.n, s.storage, palette);
        repaint.current = false;
      }
      cost[0] = performance.now() - t;

      const layers: unknown[] = [roadLayer(s.view)];

      if (opts.current.particles) {
        t = performance.now();
        advance(s.field, s.simT);
        cost[1] = performance.now() - t;

        t = performance.now();
        // The cull is worth having at the zooms where a dot means something; at z12 the whole
        // city is in the window anyway and the bounds test just costs an edge compare.
        writePositions(s.field, viewBounds(handle, s.origin));
        cost[2] = performance.now() - t;

        if (opts.current.showParked) {
          writeParked(s.field);
          layers.push(parkedLayer(s.field, palette, s.origin, zoom, s.field.parkedRevision));
        }
        if (s.field.stuckCount > 0) {
          layers.push(stuckLayer(s.field, palette, s.origin, s.field.stuckRevision));
        }
        layers.push(carsLayer(s.field, palette, s.origin, zoom, now));
        pushTrail(s, layers, palette);
      } else {
        s.field.count = 0;
      }

      t = performance.now();
      if (opts.current.showCut) {
        const pulse = 1 + 0.5 * Math.sin(((now % PULSE_MS) / PULSE_MS) * 2 * Math.PI);
        layers.push(cutLayer(s.cut, palette, pulse));
      }
      handle.setLayers(layers as never);
      cost[3] = performance.now() - t;

      if (now - followAt >= FOLLOW_INTERVAL_MS) {
        followAt = now;
        publishFollowed(s);
      }

      window_.push(cost);
      if (windowAt === 0) windowAt = now;
      if (now - windowAt >= PERF_WINDOW_MS) {
        windowAt = now;
        const mean = (i: number): number =>
          window_.reduce((a, c) => a + c[i], 0) / window_.length;
        const cells = [mean(0), mean(1), mean(2), mean(3)];
        window_ = [];
        setState({
          perf: {
            total: cells[0] + cells[1] + cells[2] + cells[3],
            paint: cells[0],
            step: cells[1],
            place: cells[2],
            upload: cells[3],
            dots: s.field.count,
            parked: s.field.parkedCount,
            stuck: s.field.stuckCount,
            dotErr: dotError(s.field),
            zoom,
          },
        });
      }
    };

    attachRenderer({
      onReady(msg) {
        const view = createGraphView(msg.E, msg.positions, msg.startIndices);
        const origin: [number, number] = [msg.meta.center[1], msg.meta.center[0]];
        const vertsM = toMeterOffsets(msg.positions, msg.meta.center);
        const { cum, edgeLen } = cumulative(msg.startIndices, vertsM, msg.E);
        sceneRef.current = {
          view,
          storage: msg.storage,
          cut: cutPaths(view, msg.cutEdges),
          n: new Float32Array(msg.E),
          field: createTracers({
            E: msg.E,
            V: msg.V,
            totalVeh: msg.totalVeh,
            seed: msg.seed,
            csrOff: msg.csrOff,
            edgeTo: msg.edgeTo,
            isExit: msg.isExit,
            ttSec: msg.ttSec,
            split: msg.split,
            demand0: msg.demand0,
            demandNodes: msg.demandNodes,
            nodeXY: msg.nodeXY,
            maxOutDeg: msg.maxOutDeg,
            bldOff: msg.bldOff,
            bldXY: msg.bldXY,
            storage: msg.storage,
            startIndices: msg.startIndices,
            vertsM,
            cum,
            edgeLen,
          }),
          origin,
          simT: 0,
          rate: 0,
          targetT: 0,
          lastT: 0,
          lastWallMs: 0,
          lastRafMs: 0,
          followed: -1,
          trail: [],
          trailHops: -1,
        };
        repaint.current = true;
        setState({ followed: null });
        handle.flyTo(msg.meta.center, msg.meta.zoom);
      },
      onFrame(msg) {
        const s = sceneRef.current;
        if (!s) return;
        // The buffers are recycled the moment this returns (§8), and the animation loop reads
        // `n` on every tick, so it has to be a copy rather than the message's array. onFrame on
        // the field copies what it needs for the same reason.
        s.n.set(msg.n);
        onFrame(s.field, msg.n, msg.outflow, msg.departed, msg.split, s.simT);
        observeRate(s, msg.t, performance.now());
        repaint.current = true;
      },
      onNetwork(msg) {
        const s = sceneRef.current;
        if (!s) return;
        // A lanes or contraflow edit rewrites storage, and the renderer used to keep the one it
        // was handed at configure time -- so load, colour and every queue length went stale.
        s.storage = msg.storage;
        setNetwork(s.field, msg.storage, msg.blocked, msg.ttSec);
        repaint.current = true;
      },
    });

    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      attachRenderer(null);
      handle.destroy();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    mapRef.current?.setBasemap(BASEMAP[theme]);
    repaint.current = true;
  }, [theme]);

  return <div className="map" ref={hostRef} />;
}

/**
 * Measures the acceleration the worker actually achieved, rather than trusting the requested
 * speedX: the worker drops whatever ticks do not fit its 12 ms slice, so at x600 the real rate
 * is lower and cars driven by the request would run ahead of the simulation.
 *
 * Frames with dt = 0 are ignored -- `edit` and `configure` force a frame out at the same t, and
 * dividing by it would crash the estimate to zero.
 */
function observeRate(s: Scene, t: number, nowMs: number): void {
  s.targetT = t;
  const dt = t - s.lastT;
  const dw = (nowMs - s.lastWallMs) / 1000;
  if (s.lastWallMs === 0 || dt <= 0 || dw <= 0) {
    s.lastT = t;
    s.lastWallMs = nowMs;
    if (s.rate === 0) s.simT = t;
    return;
  }
  const a = Math.min(1, (dw * 1000) / RATE_TAU_MS);
  s.rate += (dt / dw - s.rate) * a;
  s.lastT = t;
  s.lastWallMs = nowMs;
}

/**
 * Integrates the simulated clock and corrects the RATE, never the value. Re-anchoring simT to
 * each arriving frame would step it backwards whenever the rate was over-estimated, and with
 * one dot per car a backward step is glaring. Clamping it to the newest frame instead would
 * break x1, where the worker sleeps a whole second and then jumps t by one: the cars would
 * sprint for a fraction of a second and freeze for the rest.
 */
function advanceSimT(s: Scene, nowMs: number, running: boolean): void {
  const dtWall = s.lastRafMs === 0 ? 0.016 : Math.min(0.25, (nowMs - s.lastRafMs) / 1000);
  s.lastRafMs = nowMs;
  if (!running) return;
  const err = s.targetT - s.simT;
  // A big gap means something discontinuous happened -- stepTo, a backgrounded tab, a long GC
  // pause -- and catching up at 25% would take minutes.
  if (Math.abs(err) > Math.max(10, s.rate * 4)) {
    s.simT = s.targetT;
    return;
  }
  const eff = s.rate * (1 + Math.max(-CATCHUP, Math.min(CATCHUP, err / Math.max(1, s.rate))));
  s.simT += Math.max(0, eff) * dtWall;
}

function viewBounds(
  handle: MapHandle,
  origin: [lon: number, lat: number],
): { x0: number; y0: number; x1: number; y1: number } {
  const b = handle.map.getBounds();
  const mPerLon = 111320 * Math.cos(origin[1] * (Math.PI / 180));
  // A margin, so a car does not pop in at the edge of the window.
  const pad = 200;
  return {
    x0: (b.getWest() - origin[0]) * mPerLon - pad,
    y0: (b.getSouth() - origin[1]) * 110540 - pad,
    x1: (b.getEast() - origin[0]) * mPerLon + pad,
    y1: (b.getNorth() - origin[1]) * 110540 + pad,
  };
}

/** A click on a car follows it; a click on a road probes the road, as it always did. */
function pick(s: Scene | null, hit: PickHit | null): void {
  if (!s) return;
  if (!hit) {
    s.followed = -1;
    s.trailHops = -1;
    setState({ followed: null });
    return;
  }
  if (hit.layerId === 'roads') {
    client.probe(hit.index);
    return;
  }
  let slot = -1;
  // The picked index is a place in a compacted buffer, not a car. Only the moving buffer keeps
  // a slot map; the yards are contiguous ranges, so a parked pick is resolved by walking them,
  // which is fine for something that happens on a click.
  if (hit.layerId === 'cars') slot = s.field.slotOf[hit.index];
  else if (hit.layerId === 'stuck') slot = s.field.stuckList[hit.index];
  else if (hit.layerId === 'parked') slot = parkedSlotAt(s.field, hit.index);
  if (slot < 0) return;
  s.followed = slot;
  s.trailHops = -1;
  publishFollowed(s);
  // Cars sit on top of the roads and win the pick, so without this the road under them becomes
  // unreachable and §9.3's interventions cannot be aimed anywhere there is traffic. One click
  // now fills both panels: the car it hit, and the road that car is on.
  const e = s.field.dEdge[slot];
  if (s.field.dState[slot] === MOVING || s.field.dState[slot] === STUCK) client.probe(e);
}

function pushTrail(s: Scene, layers: unknown[], palette: Palette): void {
  const slot = s.followed;
  if (slot < 0) return;
  const hops = s.field.dHops[slot];
  // Rebuilt on a hop, not on a frame: the geometry only changes when the car turns.
  if (hops !== s.trailHops) {
    s.trailHops = hops;
    const { edges } = replayRoute(s.field, slot);
    s.trail = edges.length > 0 ? edgePaths(s.view, edges) : [];
  }
  if (s.trail.length > 0) layers.push(trailLayer(s.trail, palette));
  const at = carPosition(s.field, slot);
  if (at) layers.push(followLayer(at, palette, s.origin, s.simT));
}

const STATE_NAME = ['parked', 'moving', 'arrived', 'stuck'] as const;

function publishFollowed(s: Scene): void {
  const slot = s.followed;
  if (slot < 0) return;
  const f = s.field;
  const state = f.dState[slot];
  const departedAt = state === PARKED ? -1 : f.dSpawnT[slot];
  const arrivedAt = state === ARRIVED ? f.dArriveT[slot] : -1;
  const { edges, truncated } = replayRoute(f, slot);
  const followed: FollowedCar = {
    slot,
    state: STATE_NAME[state] ?? 'parked',
    departedAt,
    arrivedAt,
    elapsed: departedAt < 0 ? 0 : (arrivedAt >= 0 ? arrivedAt : s.simT) - departedAt,
    hops: f.dHops[slot],
    routeTruncated: truncated,
    // Base edges carry edgeId === index (§9.2), which is what the probe and names messages want.
    originEdgeId: edges.length > 0 ? edges[0] : -1,
    currentEdgeId: state === MOVING || state === STUCK ? f.dEdge[slot] : -1,
  };
  setState({ followed });
  // Base edges carry edgeId === index (§9.2), and app.ts already caches whatever comes back.
  const want: number[] = [];
  if (followed.originEdgeId >= 0) want.push(followed.originEdgeId);
  if (followed.currentEdgeId >= 0) want.push(followed.currentEdgeId);
  // The tail of the route too: at x600 a car changes roads faster than the round trip, and
  // asking one edge at a time leaves the panel unable to name the road it is on.
  for (let i = Math.max(0, edges.length - 8); i < edges.length; i++) want.push(edges[i]);
  if (want.length > 0) client.names(want);
}
