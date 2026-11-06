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
          branches: 70,
          lines: 85,
          functions: 85,
          statements: 85,
        },
        'src/actions/**/*.ts': {
          branches: 50,
          lines: 70,
          functions: 80,
          statements: 70,
        },
        'src/core/**/*.ts': {
          branches: 45,
          lines: 65,
          functions: 70,
          statements: 65,
        },
        'src/cli/**/*.ts': {
          branches: 40,
          lines: 70,
          functions: 70,
          statements: 70,
        },
      },
    },
  },
});
