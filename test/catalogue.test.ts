import { describe, expect, it } from 'vitest';
import type { CityMeta } from '../src/core/types.ts';
import { initialCityId, orderCities } from '../src/main/catalogue.ts';

const city = (id: string): CityMeta => ({ id, name: id, center: [0, 0], zoom: 1 });

describe('city catalogue presentation', () => {
  const input = ['paradise', 'fixture-a', 'keys', 'sf', 'fixture-b', 'mercer'].map(city);

  it('features San Francisco, Mercer Island and the Florida Keys before Paradise', () => {
    expect(orderCities(input).map((entry) => entry.id)).toEqual([
      'sf',
      'mercer',
      'keys',
      'paradise',
      'fixture-a',
      'fixture-b',
    ]);
  });

  it('uses a valid requested city before the default', () => {
    expect(initialCityId(input, 'keys')).toBe('keys');
  });

  it('defaults to San Francisco when the request is absent or invalid', () => {
    expect(initialCityId(input, null)).toBe('sf');
    expect(initialCityId(input, 'missing')).toBe('sf');
  });

  it('falls back to the first available city when San Francisco is unavailable', () => {
    expect(initialCityId([city('mercer'), city('keys')], null)).toBe('mercer');
    expect(initialCityId([], null)).toBeUndefined();
  });
});
