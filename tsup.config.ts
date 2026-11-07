import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { bv: 'src/cli/bundle.ts' },
  outDir: 'scripts',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: false,
  dts: false,
  shims: false,
  // The published artifact must be exactly `scripts/bv.mjs`.
  outExtension: () => ({ js: '.mjs' }),
  // Playwright must be required at runtime from node_modules: it ships the
  // browser binaries, and bundling it would be both huge and wrong.
  // The Anthropic SDK is an optional dependency, lazily loaded only when
  // an exact token count is asked for.
  external: ['playwright', 'playwright-core', '@anthropic-ai/sdk'],
  banner: { js: '#!/usr/bin/env node' },
  esbuildOptions(options) {
    options.platform = 'node';
    options.conditions = ['node', 'import'];
  },
});
