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
        lines: 85,
        functions: 80,
        branches: 75,
        statements: 85,
        // Security-critical decision code must be exhaustively covered.
        'src/safety/**/*.ts': {
          branches: 100,
          lines: 90,
          functions: 90,
          statements: 90,
        },
      },
    },
  },
});
