#!/usr/bin/env node
/**
 * Executable entry point for the source tree.
 *
 * The published artifact is `scripts/bv.mjs` (built by tsup); this file is the
 * equivalent entry for running from source with `tsx src/cli/main.ts`.
 */
import { main } from './main.js';

await main(process.argv);
