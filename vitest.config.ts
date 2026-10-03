import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'services/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // Database-backed suites create a fresh database and run every migration
    // (19 now) in beforeAll. Right after the backend's 15-minute stage on a
    // busy machine that took over vitest's 10 s hook default, and a timed-out
    // hook skips the whole file. Room here, not in each file.
    hookTimeout: 30_000,
    testTimeout: 15_000,
  },
});
