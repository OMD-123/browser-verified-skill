import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.test.ts'],
    // E2E tests drive a real Chromium; keep them serialized and bounded.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    teardownTimeout: 30_000,
    pool: 'forks',
    // E2E tests drive a real Chromium; keep them bounded but able to run
    // files in parallel.
    maxWorkers: 4,
    fileParallelism: true,
    globalSetup: ['./test/globalSetup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/index.ts'],
      thresholds: {
        // The global thresholds apply to what has been built so far. As the
        // later phases add modules, their thresholds are added alongside
        // them; the numbers here are never lowered to make a run pass.
        //
        // See docs/DECISIONS.md (D-0031) for the reasoning and
        // docs/KNOWN_LIMITATIONS.md for what is not yet covered.
        'src/safety/**/*.ts': {
          // Security-critical decision code must be exhaustively covered.
          branches: 100,
          lines: 90,
          functions: 90,
          statements: 90,
        },
        'src/perception/**/*.ts': {
          branches: 78,
          lines: 94,
          functions: 96,
          statements: 90,
        },
        'src/actions/**/*.ts': {
          branches: 44,
          lines: 50,
          functions: 44,
          statements: 50,
        },
        'src/core/**/*.ts': {
          branches: 41,
          lines: 52,
          functions: 50,
          statements: 50,
        },
        'src/cli/**/*.ts': {
          branches: 20,
          lines: 43,
          functions: 47,
          statements: 42,
        },
        'src/verify/**/*.ts': {
          branches: 72,
          lines: 80,
          functions: 76,
          statements: 76,
        },
        'src/compile/**/*.ts': {
          branches: 61,
          lines: 79,
          functions: 87,
          statements: 78,
        },
        'src/memory/**/*.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/interaction/**/*.ts': {
          branches: 87,
          lines: 94,
          functions: 91,
          statements: 94,
        },
        'src/testing/**/*.ts': {
          branches: 69,
          lines: 89,
          functions: 90,
          statements: 89,
        },
        'src/llm/**/*.ts': {
          branches: 90,
          lines: 90,
          functions: 90,
          statements: 90,
        },
        'src/mcp/**/*.ts': {
          branches: 78,
          lines: 96,
          functions: 93,
          statements: 96,
        },
      },
    },
  },
});
