/**
 * Check that the generated docs are up to date.
 *
 * `scripts/generate-tree.ts` REWRITES the README's source tree. This
 * one checks it instead: it computes what the tree would be and fails
 * if the README says something else.
 *
 * A doc that is out of date is a doc that is wrong, and a wrong doc
 * erodes trust in a trust tool.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { withGeneratedTree } from './generate-tree.js';

const README = join(process.cwd(), 'README.md');

const readme = await readFile(README, 'utf8');
const expected = withGeneratedTree(readme);

if (expected !== readme) {
  throw new Error('the README tree is out of date. Run `npm run docs:tree` and commit the result.');
}

console.log('the generated docs are up to date');
