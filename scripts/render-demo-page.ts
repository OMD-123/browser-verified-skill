/**
 * Write the demo page into docs/.
 *
 * The page holds the videos with real <video> elements. A README cannot
 * do this -- GitHub strips a <video> tag -- but a web page can, and
 * GitHub Pages serves an mp4 as video/mp4 with range support, so the
 * browser plays it rather than downloading it.
 *
 * Run: npx tsx scripts/render-demo-page.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { pagesRoot, renderPage } from '../src/mcp/demo-page.js';

const target = resolve(pagesRoot(), 'index.html');
await mkdir(dirname(target), { recursive: true });
await writeFile(target, renderPage(), 'utf8');

console.log(`wrote ${target}`);
