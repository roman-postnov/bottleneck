// Owns the map and the deck.gl overlay. Frames are written straight into the colour buffer
// here; nothing about a frame goes through React state.
//
// Drawing is driven by requestAnimationFrame, not by the arrival of a frame: at ×1 a frame is
// a whole second away, and the cut has to keep pulsing between frames. The dots advance only
// while the run does -- see the dtSec below.

import { useEffect, useRef } from 'react';
import { initMap, BASEMAP, type MapHandle } from '../render/map.ts';
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
  createParticles,
  particleLayer,
  step,
  writePositions,
  type ParticleField,
} from '../render/particles.ts';
import { PALETTE } from '../render/palette.ts';
import { attachRenderer, client } from '../main/app.ts';
import { setState, useStore } from '../main/state.ts';

const PULSE_MS = 1400;
/** Averaged over wall time, not over a frame count: at a low frame rate a 30-frame window
 *  leaves the readout showing the first seconds of the run for half a minute. */
const PERF_WINDOW_MS = 500;

type Scene = {
  view: GraphView;
  storage: Float32Array;
  cut: CutPaths;
  n: Float32Array;
  field: ParticleField;
};

export function MapView(): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapHandle | null>(null);
  const sceneRef = useRef<Scene | null>(null);

  const showCut = useStore((s) => s.showCut);
  const running = useStore((s) => s.status === 'running');
  const theme = useStore((s) => s.theme);
  const particles = useStore((s) => s.particles);
  const particleCap = useStore((s) => s.particleCap);

  // Read inside the animation loop without restarting it on every toggle.
  const opts = useRef({ showCut, theme, particles, running });
  opts.current = { showCut, theme, particles, running };
  const repaint = useRef(true);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handle = initMap(host, [37.76, -122.44], 12, BASEMAP[opts.current.theme]);
    mapRef.current = handle;
    handle.onPick((index) => {
      if (index !== null) client.probe(index);
    });

    let raf = 0;
    let lastAt = 0;
    let window_: number[][] = [];
    let windowAt = 0;

    const loop = (now: number): void => {
      raf = requestAnimationFrame(loop);
      const s = sceneRef.current;
      if (!s) return;
      // Paused means paused: the dots stand still. They are the only thing on screen that
      // claims to be a vehicle, and crawling ones on a stopped clock read as a running model.
      const elapsed = lastAt === 0 ? 0.016 : Math.min(0.1, (now - lastAt) / 1000);
      const dtSec = opts.current.running ? elapsed : 0;
      lastAt = now;
      const palette = PALETTE[opts.current.theme];
      const zoom = handle.map.getZoom();
      const cost = [0, 0, 0, 0];

      let t = performance.now();
      if (repaint.current) {
        paint(s.view, s.n, s.storage, palette);
        repaint.current = false;
      }
      cost[0] = performance.now() - t;

      const layers: unknown[] = [roadLayer(s.view)];

      if (opts.current.particles) {
        t = performance.now();
        step(s.field, s.n, s.storage, dtSec, zoom);
        cost[1] = performance.now() - t;
        t = performance.now();
        writePositions(s.field, s.view);
        cost[2] = performance.now() - t;
        layers.push(particleLayer(s.field, palette, now));
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
            zoom,
          },
        });
      }
    };

    attachRenderer({
      onReady(msg) {
        const view = createGraphView(msg.E, msg.positions, msg.startIndices);
        sceneRef.current = {
          view,
          storage: msg.storage,
          cut: cutPaths(view, msg.cutEdges),
          n: new Float32Array(msg.E),
          field: createParticles(view, msg.storage, particleCap),
        };
        repaint.current = true;
        handle.flyTo(msg.meta.center, msg.meta.zoom);
      },
      onFrame(msg) {
        const s = sceneRef.current;
        if (!s) return;
        // The buffer is recycled the moment this returns (§8), and the animation loop reads
        // `n` on every tick, so it has to be a copy rather than the message's array.
        s.n.set(msg.n);
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

  useEffect(() => {
    const s = sceneRef.current;
    if (s) s.field = createParticles(s.view, s.storage, particleCap);
  }, [particleCap]);

  return <div className="map" ref={hostRef} />;
}
