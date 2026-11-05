/**
 * Bundle entry point.
 *
 * tsup bundles this file into `scripts/bv.mjs`, a single self-contained ESM
 * file. The shebang is added by tsup's banner option.
 */
import { main } from './main.js';

await main(process.argv);
