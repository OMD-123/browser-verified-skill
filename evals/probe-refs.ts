#!/usr/bin/env node
/**
 * Probe: verify Playwright's aria ref behaviour.
 *
 * Confirmed against playwright@1.64.1:
 *  - refs are stable across re-snapshots of an unchanged page,
 *  - refs are NOT stable across a navigation (the frame counter is
 *    context-global and monotonic),
 *  - `page.getByRef()` resolves refs across frames and shadow DOM.
 */
import { chromium } from 'playwright';
import { startFixtureServer } from '../fixtures/server.js';

const server = await startFixtureServer({ port: 0 });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.goto(`${server.origin}/pages/frames.html`);
await page.waitForTimeout(500);

const s1 = await page.ariaSnapshotJSON({ mode: 'ai' });
const s2 = await page.ariaSnapshotJSON({ mode: 'ai' });
console.log('stable across re-snapshot:', JSON.stringify(s1) === JSON.stringify(s2));

await page.goto(`${server.origin}/pages/login.html`);
await page.goto(`${server.origin}/pages/frames.html`);
await page.waitForTimeout(500);
const s3 = await page.ariaSnapshotJSON({ mode: 'ai' });
console.log('refs after renavigation:', JSON.stringify(s3).match(/"ref":"[^"]+"/g));

try {
  const btn = page.getByRef('f2e3');
  console.log('f2e3 after renav text:', await btn.textContent({ timeout: 2000 }));
} catch (e) {
  console.log('f2e3 after renav ERROR:', (e as Error).message.split('\n')[0]);
}

await browser.close();
await server.close();
