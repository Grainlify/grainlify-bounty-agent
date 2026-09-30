import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The escrow tests need a validator and are not part of the agent's own suite:
// they run from here, on demand, with ESCROW_PROGRAM_ID set.
export default defineConfig({
  // Run from the repository root (pnpm needs a manifest where it is invoked),
  // but resolve tests relative to this directory.
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
