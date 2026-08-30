// The loader of CONTRACTS.md §5, and the module §3 and §5 name: everything about a city.bin
// is reached through this file. The parts live next door -- format.ts holds the byte layout
// and the parser, graph.ts the geometry decoder and Tarjan, validate.ts the §3.3 invariants --
// because a file that is at once a format, a graph algorithm and a validator is three files
// sharing a name. §16.6 keeps the split invisible: the API here is unchanged.

import { parseCity } from './format.ts';
import type { City, CityMeta } from './types.ts';

// biome-ignore lint/performance/noBarrelFile: §16.6 -- the contract names one module; these are its internals
export {
  classOf,
  FLAG,
  FORMAT_VERSION,
  GEOM_SCALE,
  HEADER_BYTES,
  MAGIC,
  MAX_EDGE_LEN_M,
  NO_TWIN,
  parseCity,
  SECTION,
  SECTION_SLOTS,
} from './format.ts';
export { edgePolyline, stronglyConnectedComponents } from './graph.ts';
export { validateCity } from './validate.ts';

/** Network load. The only I/O in core; the parsing itself lives in parseCity. */
export async function loadCity(url: string, meta: CityMeta | Record<string, never> = {}): Promise<City> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`city.bin: ${res.status} ${res.statusText} for ${url}`);
  return parseCity(await res.arrayBuffer(), meta);
}
