// Owns the map and the deck.gl overlay. Frames are written straight into the colour buffer
// here; nothing about a frame goes through React state.

import { useEffect, useRef } from 'react';
import { initMap, type MapHandle } from '../render/map.ts';
import { createGraphView, paint, paintCut, roadLayer, type GraphView } from '../render/layers.ts';
import { attachRenderer, client } from '../main/app.ts';
import { useStore } from '../main/state.ts';

export function MapView(): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapHandle | null>(null);
  const viewRef = useRef<GraphView | null>(null);
  const storageRef = useRef<Float32Array | null>(null);
  const cutRef = useRef<Uint32Array | null>(null);
  const showCut = useStore((s) => s.showCut);
  // Read inside the frame callback without re-registering it on every toggle.
  const showCutRef = useRef(showCut);
  showCutRef.current = showCut;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handle = initMap(host, [37.76, -122.44], 12);
    mapRef.current = handle;
    handle.onPick((index) => {
      if (index !== null) client.probe(index);
    });

    attachRenderer({
      onReady(msg) {
        const view = createGraphView(msg.E, msg.positions, msg.startIndices);
        viewRef.current = view;
        storageRef.current = msg.storage;
        cutRef.current = msg.cutEdges;
        paint(view, new Float32Array(msg.E), msg.storage);
        handle.flyTo(msg.meta.center, msg.meta.zoom);
        handle.setLayers([roadLayer(view)]);
      },
      onFrame(msg) {
        const view = viewRef.current;
        const storage = storageRef.current;
        if (!view || !storage) return;
        paint(view, msg.n, storage);
        if (cutRef.current && showCutRef.current) paintCut(view, cutRef.current);
        handle.setLayers([roadLayer(view)]);
      },
    });

    return () => {
      attachRenderer(null);
      handle.destroy();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    const handle = mapRef.current;
    const storage = storageRef.current;
    if (!view || !handle || !storage) return;
    if (showCut && cutRef.current) paintCut(view, cutRef.current);
    handle.setLayers([roadLayer(view)]);
  }, [showCut]);

  return <div className="map" ref={hostRef} />;
}
