// The bans of CONTRACTS.md §10, §15 and §16.5 that a linter cannot state.
//
// The import half of §15 lives in biome.jsonc, where noRestrictedImports names the three
// forbidden directions. What is left here is about calls, not imports -- `Math.random` in the
// core, `fetch` outside the loader, `postMessage` outside the worker -- and no rule expresses
// those, so they are asserted against the source text.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('§10: determinism', () => {
  it('src/core and src/worker never call Math.random', () => {
    for (const f of [...sources('src/core'), ...sources('src/worker')]) {
      expect(stripComments(read(f)), f).not.toMatch(/Math\s*\.\s*random/);
    }
  });
});

/**
 * Globals the platform provides and node does not owe us. `document.`/`window.` alone let
 * base64 and deflate through unnoticed, which is exactly how src/core/scenario.ts came to
 * depend on the browser without any rule noticing.
 */
const PLATFORM_GLOBALS = [
  'btoa',
  'atob',
  'Blob',
  'CompressionStream',
  'DecompressionStream',
  'Response',
  'localStorage',
  'sessionStorage',
  'requestAnimationFrame',
  'XMLHttpRequest',
  'navigator',
];

/** §9 puts the permalink in core, and base64 and deflate are not in the language. */
const CODEC = 'src/core/scenario.ts';

describe('§15: src/core is pure', () => {
  it('never touches the DOM', () => {
    for (const f of sources('src/core')) {
      const src = stripComments(read(f));
      expect(src, f).not.toMatch(/\bdocument\s*\./);
      expect(src, f).not.toMatch(/\bwindow\s*\./);
    }
  });

  it('reaches for no platform global outside the permalink codec', () => {
    for (const f of sources('src/core')) {
      if (f === CODEC) continue;
      const src = stripComments(read(f));
      for (const g of PLATFORM_GLOBALS) {
        expect(src, `${f}: ${g}`).not.toMatch(new RegExp(`\\b${g}\\b`));
      }
    }
  });

  // The exemption has to expire with its cause: once the codec stops needing the platform,
  // this goes red rather than quietly licensing the next such import.
  it('the codec exemption is still earned', () => {
    const src = stripComments(read(CODEC));
    expect(
      PLATFORM_GLOBALS.some((g) => new RegExp(`\\b${g}\\b`).test(src)),
      CODEC,
    ).toBe(true);
  });

  it('the only network call is loadCity, which §5 puts here by name', () => {
    for (const f of sources('src/core')) {
      if (f.endsWith('city.ts')) continue;
      expect(stripComments(read(f)), f).not.toMatch(/\bfetch\s*\(/);
    }
  });
});

describe('§15: layers do not reach across', () => {
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
