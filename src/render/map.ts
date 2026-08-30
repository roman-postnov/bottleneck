// MapLibre basemap with a deck.gl canvas above it (CONTRACTS.md §13).
//
// The map owns all interaction and deck follows it. The alternative -- inserting deck into
// the maplibre layer stack -- couples us to a compatibility layer across two fast-moving
// major versions, and buys only the ability to draw roads under map labels.

import { Deck } from '@deck.gl/core';
import type { Layer, MapViewState } from '@deck.gl/core';
import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';

setWorkerUrl(maplibreWorkerUrl);

export const BASEMAP = {
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
} as const;

/** Which layer a click landed on, and the index within it. */
export type PickHit = { layerId: string; index: number };

export type MapHandle = {
  map: MapLibreMap;
  deck: Deck;
  setLayers(layers: Layer[]): void;
  flyTo(center: [number, number], zoom: number): void;
  onPick(cb: (hit: PickHit | null) => void): void;
  setBasemap(url: string | null): void;
  destroy(): void;
};

export function initMap(
  container: HTMLElement,
  center: [number, number],
  zoom: number,
  styleUrl: string | null = BASEMAP.light,
): MapHandle {
  container.style.position = 'relative';

  const mapDiv = document.createElement('div');
  mapDiv.style.cssText = 'position:absolute;inset:0;';
  container.appendChild(mapDiv);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
  container.appendChild(canvas);

  const map = new MapLibreMap({
    container: mapDiv,
    // An empty style keeps the app usable with no network, which is where the synthetic
    // fixtures live anyway -- they have no real geography to sit on.
    style: styleUrl ?? { version: 8, sources: {}, layers: [] },
    center: [center[1], center[0]],
    zoom,
    attributionControl: { compact: true },
  });

  const viewState = (): MapViewState => {
    const c = map.getCenter();
    return {
      longitude: c.lng,
      latitude: c.lat,
      zoom: map.getZoom(),
      pitch: map.getPitch(),
      bearing: map.getBearing(),
    };
  };

  const deck = new Deck({
    canvas,
    controller: false,
    viewState: viewState(),
    layers: [],
    useDevicePixels: true,
  });

  /**
   * Both CARTO styles draw their own full street grid, and on a city the size of San Francisco
   * it is as loud as ours -- an empty road of theirs and a jammed road of ours end up the same
   * weight. Theirs is context, so it gets pushed back.
   */
  const dimBasemapRoads = (): void => {
    for (const layer of map.getStyle()?.layers ?? []) {
      if (layer.type !== 'line') continue;
      if (!/road|street|bridge|tunnel|highway|motorway|transit/i.test(layer.id)) continue;
      try {
        map.setPaintProperty(layer.id, 'line-opacity', 0.28);
      } catch {
        // A style can declare a paint property this layer does not accept; skipping it is the
        // whole handling.
      }
    }
  };
  map.on('style.load', dimBasemapRoads);

  const sync = (): void => deck.setProps({ viewState: viewState() });
  map.on('move', sync);
  map.on('resize', sync);

  let pickCb: ((hit: PickHit | null) => void) | null = null;
  map.on('click', (ev) => {
    if (!pickCb) return;
    const x = ev.point.x;
    const y = ev.point.y;
    // Cars first and with a fatter halo: a dot is a four-pixel disc at best and unaimable at
    // z12. Two passes cost nothing -- deck renders the picking buffer on demand, so this runs
    // on a click and never per frame.
    for (const id of ['cars', 'stuck', 'parked']) {
      const hit = deck.pickObject({ x, y, radius: 8, layerIds: [id] });
      if (hit) {
        pickCb({ layerId: id, index: hit.index });
        return;
      }
    }
    const road = deck.pickObject({ x, y, radius: 4, layerIds: ['roads'] });
    pickCb(road ? { layerId: 'roads', index: road.index } : null);
  });

  return {
    map,
    deck,
    setLayers(layers) {
      deck.setProps({ layers });
    },
    flyTo(c, z) {
      map.jumpTo({ center: [c[1], c[0]], zoom: z });
      sync();
    },
    onPick(cb) {
      pickCb = cb;
    },
    setBasemap(url) {
      map.setStyle(url ?? { version: 8, sources: {}, layers: [] });
    },
    destroy() {
      deck.finalize();
      map.remove();
      container.innerHTML = '';
    },
  };
}
