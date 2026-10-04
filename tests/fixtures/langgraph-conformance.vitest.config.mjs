// #1562 — vitest config for the official checkpointer conformance suite only.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/fixtures/langgraph-conformance.vspec.mjs'],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
