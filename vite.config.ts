import { defineConfig } from 'vitest/config';

export default defineConfig({
  worker: { format: 'es' },
  build: { target: 'es2022' },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Sanity check 17 measures heap growth over 10 000 ticks; without an explicit gc the
    // reading is uncollected garbage rather than a leak.
    pool: 'forks',
    poolOptions: { forks: { execArgv: ['--expose-gc'] } },
  },
});
