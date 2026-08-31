// Owns the map and the deck.gl overlay. Frames are written straight into the colour buffer
// here; nothing about a frame goes through React state.
//
// Drawing is driven by requestAnimationFrame, not by the arrival of a frame: at x1 a frame is
// a whole second away, and the cut has to keep pulsing between frames. The cars advance on
// SIMULATED time -- see simT below.

import { useEffect, useLayoutEffect, useRef } from 'react';
import { attachRenderer, client } from '../main/app.ts';
import { type FollowedCar, setState, useStore } from '../main/state.ts';
import { carsLayer, edgePaths, followLayer, parkedLayer, stuckLayer, trailLayer } from '../render/carLayers.ts';
import {
  type CutPaths,
  closureLayer,
  contraflowLayer,
  createGraphView,
  cutLayer,
  cutPaths,
  type GraphView,
  type MarkedPaths,
  markedPaths,
  paint,
  roadLayer,
} from '../render/layers.ts';
import { BASEMAP, initMap, type MapHandle, type PickHit } from '../render/map.ts';
import { PALETTE, type Palette } from '../render/palette.ts';
import { FrameProfiler } from '../render/perf.ts';
import { SimClock } from '../render/simClock.ts';
import {
  ARRIVED,
  advance,
  carPosition,
  carSnapshot,
  clearDrawn,
  createTracers,
  cumulative,
  dotError,
  drawnCounts,
  MOVING,
  onFrame,
  PARKED,
  pickedSlot,
  replayRoute,
  STUCK,
  setNetwork,
  type TracerField,
  writeParked,
  writePositions,
} from '../render/tracers.ts';
import { type MeterOffsets, meterOffsets, projectX, projectY, toMeterOffsets } from '../shared/geo.ts';

const PULSE_MS = 1400;
/** The panel is React; it gets the followed car on the same throttle as the clock. */
const FOLLOW_INTERVAL_MS = 200;

type Scene = {
  view: GraphView;
  /** deck.gl's metre space at meta.center, so the cull agrees with the dots it is culling. */
  proj: MeterOffsets;
  storage: Float32Array;
  cut: CutPaths;
  closures: MarkedPaths;
  contraflow: MarkedPaths;
  n: Float32Array;
  field: TracerField;
  origin: [lon: number, lat: number];
  clock: SimClock;
  followed: number;
  trail: [number, number][][];
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

  // Read inside the animation loop without restarting it on every toggle. Written in a layout
  // effect rather than during render: a render-phase write is a side effect, and it runs twice
  // under StrictMode. Layout effects run before the mount effect below reads opts.current.
  const opts = useRef({ showCut, theme, particles, showParked, running });
  useLayoutEffect(() => {
    opts.current = { showCut, theme, particles, showParked, running };
  });
  const repaint = useRef(true);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handle = initMap(host, [37.76, -122.44], 12, BASEMAP[opts.current.theme]);
    mapRef.current = handle;
    handle.onPick((hit) => pick(sceneRef.current, hit));

    let raf = 0;
    const profiler = new FrameProfiler();
    let followAt = 0;

    const loop = (now: number): void => {
      raf = requestAnimationFrame(loop);
      const s = sceneRef.current;
      if (!s) return;
      const palette = PALETTE[opts.current.theme];
      const zoom = handle.map.getZoom();
      const cost = profiler.begin();

      // Paused means paused: the cars stand still. They are the only thing on screen that
      // claims to be a vehicle, and crawling ones on a stopped clock read as a running model.
      // Freezing the rate rather than resetting it makes resume instant instead of a ramp.
      s.clock.advance(now, opts.current.running);

      let t = performance.now();
      if (repaint.current) {
        paint(s.view, s.n, s.storage, palette);
        repaint.current = false;
      }
      cost.paint = performance.now() - t;

      const layers: unknown[] = [roadLayer(s.view)];
      if (s.closures.length > 0) layers.push(closureLayer(s.closures, palette));
      if (s.contraflow.length > 0) layers.push(contraflowLayer(s.contraflow, palette));

      if (opts.current.particles) {
        t = performance.now();
        advance(s.field, s.clock.simT);
        cost.step = performance.now() - t;

        t = performance.now();
        // The cull is worth having at the zooms where a dot means something; at z12 the whole
        // city is in the window anyway and the bounds test just costs an edge compare.
        writePositions(s.field, viewBounds(handle, s.proj));
        cost.place = performance.now() - t;

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
        clearDrawn(s.field);
      }

      t = performance.now();
      if (opts.current.showCut) {
        const pulse = 1 + 0.5 * Math.sin(((now % PULSE_MS) / PULSE_MS) * 2 * Math.PI);
        layers.push(cutLayer(s.cut, palette, pulse));
      }
      handle.setLayers(layers as never);
      cost.upload = performance.now() - t;

      if (now - followAt >= FOLLOW_INTERVAL_MS) {
        followAt = now;
        publishFollowed(s);
      }

      const mean = profiler.end(cost, now);
      if (mean) {
        setState({
          perf: {
            total: mean.paint + mean.step + mean.place + mean.upload,
            ...mean,
            ...drawnCounts(s.field),
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
        const field = createTracers({
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
        });
        setNetwork(field, msg.storage, msg.blocked, msg.ttSec);
        sceneRef.current = {
          view,
          proj: meterOffsets(msg.meta.center),
          storage: msg.storage,
          cut: cutPaths(view, msg.cutEdges),
          closures: markedPaths(view, msg.blocked, msg.contraflow),
          contraflow: markedPaths(view, msg.contraflow),
          n: new Float32Array(msg.E),
          field,
          origin,
          clock: new SimClock(),
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
        onFrame(s.field, msg.n, msg.outflow, msg.departed, msg.split, s.clock.simT);
        s.clock.observe(msg.t, performance.now());
        repaint.current = true;
      },
      onNetwork(msg) {
        const s = sceneRef.current;
        if (!s) return;
        // Lane and contraflow edits change the arrays used for load, colour, and queue placement.
        s.storage = msg.storage;
        s.closures = markedPaths(s.view, msg.blocked, msg.contraflow);
        s.contraflow = markedPaths(s.view, msg.contraflow);
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

function viewBounds(handle: MapHandle, p: MeterOffsets): { x0: number; y0: number; x1: number; y1: number } {
  const b = handle.map.getBounds();
  const yS = projectY(p, b.getSouth());
  const yN = projectY(p, b.getNorth());
  // Four corners, not two: deck.gl's second-order term makes x a function of y, so the window is
  // not an axis-aligned box in metre offsets.
  const xW = Math.min(projectX(p, b.getWest(), yS), projectX(p, b.getWest(), yN));
  const xE = Math.max(projectX(p, b.getEast(), yS), projectX(p, b.getEast(), yN));
  // A margin, so a car does not pop in at the edge of the window.
  const pad = 200;
  return { x0: xW - pad, y0: yS - pad, x1: xE + pad, y1: yN + pad };
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
  const slot = pickedSlot(s.field, hit.layerId, hit.index);
  if (slot < 0) return;
  s.followed = slot;
  s.trailHops = -1;
  publishFollowed(s);
  // Cars sit on top of the roads and win the pick, so without this the road under them becomes
  // unreachable and §9.3's interventions cannot be aimed anywhere there is traffic. One click
  // now fills both panels: the car it hit, and the road that car is on.
  const car = carSnapshot(s.field, slot);
  if (car.state === MOVING || car.state === STUCK) client.probe(car.edge);
}

function pushTrail(s: Scene, layers: unknown[], palette: Palette): void {
  const slot = s.followed;
  if (slot < 0) return;
  const hops = carSnapshot(s.field, slot).hops;
  // Rebuilt on a hop, not on a frame: the geometry only changes when the car turns.
  if (hops !== s.trailHops) {
    s.trailHops = hops;
    const { edges } = replayRoute(s.field, slot);
    s.trail = edges.length > 0 ? edgePaths(s.view, edges) : [];
  }
  if (s.trail.length > 0) layers.push(trailLayer(s.trail, palette));
  const at = carPosition(s.field, slot);
  if (at) layers.push(followLayer(at, palette, s.origin, s.clock.simT));
}

const STATE_NAME = ['parked', 'moving', 'arrived', 'stuck'] as const;

function publishFollowed(s: Scene): void {
  const slot = s.followed;
  if (slot < 0) return;
  const f = s.field;
  const car = carSnapshot(f, slot);
  const state = car.state;
  const departedAt = state === PARKED ? -1 : car.spawnT;
  const arrivedAt = state === ARRIVED ? car.arriveT : -1;
  const { edges, truncated } = replayRoute(f, slot);
  const followed: FollowedCar = {
    slot,
    state: STATE_NAME[state] ?? 'parked',
    departedAt,
    arrivedAt,
    elapsed: departedAt < 0 ? 0 : (arrivedAt >= 0 ? arrivedAt : s.clock.simT) - departedAt,
    hops: car.hops,
    routeTruncated: truncated,
    // Base edges carry edgeId === index (§9.2), which is what the probe and names messages want.
    originEdgeId: edges.length > 0 ? edges[0] : -1,
    currentEdgeId: state === MOVING || state === STUCK ? car.edge : -1,
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
