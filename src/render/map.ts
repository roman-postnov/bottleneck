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

export const DARK_BASEMAP = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

export type MapHandle = {
  map: MapLibreMap;
  deck: Deck;
  setLayers(layers: Layer[]): void;
  flyTo(center: [number, number], zoom: number): void;
  onPick(cb: (index: number | null) => void): void;
  destroy(): void;
};

export function initMap(
  container: HTMLElement,
  center: [number, number],
  zoom: number,
  styleUrl: string | null = DARK_BASEMAP,
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

  const sync = (): void => deck.setProps({ viewState: viewState() });
  map.on('move', sync);
  map.on('resize', sync);

  let pickCb: ((index: number | null) => void) | null = null;
  map.on('click', (ev) => {
    if (!pickCb) return;
    const info = deck.pickObject({ x: ev.point.x, y: ev.point.y, radius: 4, layerIds: ['roads'] });
    pickCb(info ? info.index : null);
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
    destroy() {
      deck.finalize();
      map.remove();
      container.innerHTML = '';
    },
  };
}
