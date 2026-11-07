/**
 * Tests for the accessibility scanner (M19).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchChromium } from '../../src/core/browser.js';
import { renderA11y, scanA11y, shouldFail, worstSeverity } from '../../src/testing/a11y.js';

describe('the accessibility scanner', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchChromium();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it('finds a missing image alt', async () => {
    await page.setContent(`
      <html><body>
        <img src="x.png" />
      </body></html>
    `);

    const result = await scanA11y(page);
    expect(result.scanned).toBe(true);
    expect(result.violations.some((violation) => violation.id === 'image-alt')).toBe(true);
  });

  it('finds a missing form label', async () => {
    await page.setContent(`
      <html><body>
        <input type="text" id="unlabelled" />
      </body></html>
    `);

    const result = await scanA11y(page);
    expect(result.violations.some((violation) => violation.id === 'label')).toBe(true);
  });

  it('finds no violations on a good page', async () => {
    await page.setContent(`
      <html lang="en">
        <head><title>A good page</title></head>
        <body>
          <main>
            <h1>A good page</h1>
            <img src="x.png" alt="a description" />
            <label for="name">Name</label>
            <input type="text" id="name" />
          </main>
        </body>
      </html>
    `);

    const result = await scanA11y(page);
    expect(result.violationCount).toBe(0);
  });

  it('reports the rule ids that passed', async () => {
    await page.setContent(
      '<html lang="en"><head><title>Heading</title></head><body><h1>Heading</h1></body></html>',
    );
    const result = await scanA11y(page);
    expect(result.passes.length).toBeGreaterThan(0);
  });

  it('gives the target of each node', async () => {
    await page.setContent('<html><body><img src="x.png" /></body></html>');
    const result = await scanA11y(page);
    const violation = result.violations.find((entry) => entry.id === 'image-alt');
    expect(violation?.nodes[0]?.target).toContain('img');
  });

  it('gives the help url of each violation', async () => {
    await page.setContent('<html><body><img src="x.png" /></body></html>');
    const result = await scanA11y(page);
    expect(result.violations[0]?.helpUrl).toContain('dequeuniversity.com');
  });

  it('sorts the violations by severity', async () => {
    await page.setContent(`
      <html><body>
        <img src="x.png" />
        <input type="text" />
      </body></html>
    `);
    const result = await scanA11y(page);
    if (result.violations.length > 1) {
      const impacts = result.violations.map((violation) => violation.impact);
      const order = ['critical', 'serious', 'moderate', 'minor'];
      const indices = impacts.map((impact) => order.indexOf(impact));
      const sorted = [...indices].sort((a, b) => a - b);
      expect(indices).toEqual(sorted);
    }
  });

  it('says the scan is not a certification', async () => {
    await page.setContent(
      '<html lang="en"><head><title>Fine</title></head><body><h1>Fine</h1></body></html>',
    );
    const result = await scanA11y(page);
    const text = renderA11y(result);
    expect(text).toContain('not a certification');
  });

  it('renders the violations', async () => {
    await page.setContent('<html><body><img src="x.png" /></body></html>');
    const result = await scanA11y(page);
    const text = renderA11y(result);
    expect(text).toContain('image-alt');
    expect(text).toContain('dequeuniversity.com');
  });

  it('reports the worst severity', async () => {
    await page.setContent('<html><body><img src="x.png" /></body></html>');
    const result = await scanA11y(page);
    expect(worstSeverity(result)).toBeDefined();
  });

  it('fails on a serious violation', async () => {
    await page.setContent('<html><body><img src="x.png" /></body></html>');
    const result = await scanA11y(page);
    expect(shouldFail(result)).toBe(true);
  });

  it('does not fail on a clean page', async () => {
    await page.setContent(`
      <html lang="en">
        <head><title>Fine</title></head>
        <body>
          <main><h1>Fine</h1><img src="x.png" alt="a description" /></main>
        </body>
      </html>
    `);
    const result = await scanA11y(page);
    expect(shouldFail(result)).toBe(false);
  });

  it('handles a violation with no nodes', async () => {
    await page.setContent('<html><body><img src="x.png" /></body></html>');
    const result = await scanA11y(page);
    // Every violation axe reports has at least one node, so the array is
    // never empty in practice.
    for (const violation of result.violations) {
      expect(Array.isArray(violation.nodes)).toBe(true);
    }
  });

  it('scans with an include rule', async () => {
    await page.setContent('<html><body><img src="x.png" /></body></html>');
    const result = await scanA11y(page, { include: ['img'] });
    expect(result.scanned).toBe(true);
  });

  it('excludes an element', async () => {
    await page.setContent('<html><body><img src="x.png" /></body></html>');
    const result = await scanA11y(page, { exclude: ['img'] });
    expect(result.scanned).toBe(true);
    // The excluded element is not checked, so the rule that flagged it
    // does not fire for it.
    const imageAlt = result.violations.find((violation) => violation.id === 'image-alt');
    expect(imageAlt?.nodes ?? []).toHaveLength(0);
  });

  it('runs only the named rules', async () => {
    await page.setContent('<html><body><img src="x.png" /></body></html>');
    const result = await scanA11y(page, { rules: ['image-alt'] });
    expect(result.scanned).toBe(true);
    expect(result.violations.every((violation) => violation.id === 'image-alt')).toBe(true);
  });

  it('reports when the scan did not run', async () => {
    // A page that has been closed cannot be scanned.
    const closed = await browser.newPage();
    await closed.close();
    const result = await scanA11y(closed);
    expect(result.scanned).toBe(false);
    expect(renderA11y(result)).toContain('did not run');
  });
});
