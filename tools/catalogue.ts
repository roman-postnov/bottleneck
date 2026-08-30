// public/cities/index.json, §4. Merged rather than rewritten: the synthetic generator and the
// OSM preprocessor both publish into it, and either one overwriting the file would delete the
// other one's cities.

import { readFileSync, writeFileSync } from 'node:fs';
import type { CityMeta } from '../src/core/types.ts';

const PATH = 'public/cities/index.json';

/** `front` puts the entries at the head of the list, which is where the app looks for the
 *  city to open on: a real city is a better first impression than a 20x20 grid. */
export function upsertCatalogue(metas: CityMeta[], front = false): void {
  let list: CityMeta[] = [];
  try {
    list = JSON.parse(readFileSync(PATH, 'utf8')) as CityMeta[];
  } catch {
    list = [];
  }
  for (const meta of metas) {
    const i = list.findIndex((c) => c.id === meta.id);
    if (i >= 0) list.splice(i, 1);
    if (front) list.unshift(meta);
    else list.push(meta);
  }
  writeFileSync(PATH, `${JSON.stringify(list, null, 2)}\n`);
}
