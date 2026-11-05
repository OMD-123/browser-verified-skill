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
  // Playwright must be required at runtime from node_modules (it ships browser binaries),
  // and the Anthropic/MCP SDKs are lazy-loaded optional deps.
  external: ['playwright', 'playwright-core', '@anthropic-ai/sdk', '@modelcontextprotocol/sdk'],
  banner: { js: '#!/usr/bin/env node' },
  esbuildOptions(options) {
    options.platform = 'node';
    options.conditions = ['node', 'import'];
  },
});
