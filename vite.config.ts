import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

function normalizeBasePath(raw: string | undefined): string {
  if (!raw || raw.trim() === '/') return '/';
  const path = raw.trim().replace(/^\/+|\/+$/g, '');
  return path ? `/${path}/` : '/';
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    worker: { format: 'es' },
    base: normalizeBasePath(env.PAGES_BASE_PATH),
    build: { target: 'es2022' },
    test: {
      include: ['test/**/*.test.ts'],
      environment: 'node',
      // Sanity check 17 measures heap growth over 10 000 ticks; without an explicit gc the
      // reading is uncollected garbage rather than a leak.
      pool: 'forks',
      execArgv: ['--expose-gc'],
    },
  };
});
