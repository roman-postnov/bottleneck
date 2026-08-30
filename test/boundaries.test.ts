// The layer boundaries of CONTRACTS.md §15 and the bans of §10 and §16.5, checked
// mechanically. The contract says "checked by a linter"; there is no linter and adding one
// would mean adding a dependency, so the rules are asserted against the sources directly.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

function sources(dir: string): string[] {
  const abs = join(ROOT, dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(join(ROOT, p)).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

/** Comments explain the rules; only code should be searched for violations. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('§10: determinism', () => {
  it('src/core and src/worker never call Math.random', () => {
    for (const f of [...sources('src/core'), ...sources('src/worker')]) {
      expect(stripComments(read(f)), f).not.toMatch(/Math\s*\.\s*random/);
    }
  });
});

describe('§15: src/core is pure', () => {
  it('no DOM, no deck.gl, no maplibre', () => {
    for (const f of sources('src/core')) {
      const src = stripComments(read(f));
      expect(src, f).not.toMatch(/\bdocument\s*\./);
      expect(src, f).not.toMatch(/\bwindow\s*\./);
      expect(src, f).not.toMatch(/from '(deck\.gl|@deck\.gl|maplibre-gl|react)/);
    }
  });

  it('the only network call is loadCity, which §5 puts here by name', () => {
    for (const f of sources('src/core')) {
      if (f.endsWith('city.ts')) continue;
      expect(stripComments(read(f)), f).not.toMatch(/\bfetch\s*\(/);
    }
  });
});

describe('§15: layers do not reach across', () => {
  it('src/render does not import src/core -- it only knows the frame format', () => {
    for (const f of sources('src/render')) {
      expect(read(f), f).not.toMatch(/from '.*core\//);
    }
  });

  it('nothing under src imports tools', () => {
    for (const f of sources('src')) {
      expect(read(f), f).not.toMatch(/from '.*tools\//);
    }
  });

  it('postMessage lives only in src/worker and src/main', () => {
    for (const f of [...sources('src/core'), ...sources('src/render'), ...sources('src/ui')]) {
      expect(stripComments(read(f)), f).not.toMatch(/postMessage/);
    }
  });
});

describe('§16.5: nothing chatty in the hot path', () => {
  it('no console.log in the tick', () => {
    for (const f of ['src/core/sim.ts', 'src/core/nodeModel.ts', 'src/core/mobilization.ts']) {
      expect(stripComments(read(f)), f).not.toMatch(/console\s*\.\s*log/);
    }
  });
});

describe('the boundary test can actually see the sources', () => {
  it('finds the modules it claims to check', () => {
    expect(sources('src/core').length).toBeGreaterThan(5);
  });
});
