import type { CityMeta } from '../core/types.ts';

const FEATURED_CITY_IDS = ['sf', 'mercer', 'keys', 'paradise'] as const;
const DEFAULT_CITY_ID = 'sf';

const rank = new Map<string, number>(FEATURED_CITY_IDS.map((id, i) => [id, i]));

/** Put the strongest demo cases first without making generated catalogue order significant. */
export function orderCities(cities: CityMeta[]): CityMeta[] {
  return cities
    .map((city, position) => ({ city, position }))
    .sort((a, b) => {
      const aRank = rank.get(a.city.id) ?? Number.POSITIVE_INFINITY;
      const bRank = rank.get(b.city.id) ?? Number.POSITIVE_INFINITY;
      return aRank - bRank || a.position - b.position;
    })
    .map(({ city }) => city);
}

/** A valid explicit city wins; otherwise the public demo opens on San Francisco. */
export function initialCityId(cities: CityMeta[], requested: string | null): string | undefined {
  if (requested && cities.some((city) => city.id === requested)) return requested;
  return cities.find((city) => city.id === DEFAULT_CITY_ID)?.id ?? cities[0]?.id;
}
