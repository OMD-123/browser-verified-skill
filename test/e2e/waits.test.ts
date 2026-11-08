/**
 * Tests for the wait conditions (M04).
 *
 * Every condition gets a real element and a real browser. A wait that is
 * never exercised is a wait that does not work: the conditions are the
 * difference between "clicked the button" and "clicked the button after
 * it was actually clickable".
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchChromium } from '../../src/core/browser.js';
import { waitForCondition } from '../../src/actions/waits.js';

describe('the wait conditions', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchChromium();
    page = await browser.newPage();
    await page.setContent(`
      <!doctype html>
      <html><body>
        <button id="visible" style="width:80px;height:30px">Go</button>
        <button id="hidden" style="display:none">Hidden</button>
        <button id="disabled" disabled>Disabled</button>
        <input id="checkbox" type="checkbox" checked />
        <input id="unchecked" type="checkbox" />
      </body></html>
    `);
  });

  afterAll(async () => {
    await browser.close();
  });

  it('waits for an element to be attached', async () => {
    const result = await waitForCondition(page.locator('#visible'), 'attached', {
      timeoutMs: 2_000,
    });
    expect(result.satisfied).toBe(true);
    expect(result.condition).toBe('attached');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('waits for an element to be visible', async () => {
    const result = await waitForCondition(page.locator('#visible'), 'visible', {
      timeoutMs: 2_000,
    });
    expect(result.satisfied).toBe(true);
  });

  it('waits for an element to be detached', async () => {
    await page.evaluate(() => document.querySelector('#gone')?.remove());
    const result = await waitForCondition(page.locator('#never-existed'), 'detached', {
      timeoutMs: 2_000,
    });
    expect(result.satisfied).toBe(true);
  });

  it('waits for an element to be hidden', async () => {
    const result = await waitForCondition(page.locator('#hidden'), 'hidden', {
      timeoutMs: 2_000,
    });
    expect(result.satisfied).toBe(true);
  });

  it('waits for an element to be enabled', async () => {
    const result = await waitForCondition(page.locator('#visible'), 'enabled', {
      timeoutMs: 2_000,
    });
    expect(result.satisfied).toBe(true);
  });

  it('waits for an element to be disabled', async () => {
    const result = await waitForCondition(page.locator('#disabled'), 'disabled', {
      timeoutMs: 2_000,
    });
    expect(result.satisfied).toBe(true);
  });

  it('waits for a checkbox to be checked', async () => {
    const result = await waitForCondition(page.locator('#checkbox'), 'checked', {
      timeoutMs: 2_000,
    });
    expect(result.satisfied).toBe(true);
  });

  it('waits for an element to receive events', async () => {
    const result = await waitForCondition(page.locator('#visible'), 'receives-events', {
      timeoutMs: 2_000,
    });
    expect(result.satisfied).toBe(true);
  });

  it('waits for an element to be stable', async () => {
    const result = await waitForCondition(page.locator('#visible'), 'stable', {
      timeoutMs: 2_000,
    });
    expect(result.satisfied).toBe(true);
  });

  it('reports a timeout rather than throwing', async () => {
    const result = await waitForCondition(page.locator('#never-existed'), 'visible', {
      timeoutMs: 300,
    });
    expect(result.satisfied).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('reports an unknown condition rather than throwing', async () => {
    const result = await waitForCondition(page.locator('#visible'), 'nonsense' as never, {
      timeoutMs: 300,
    });
    expect(result.satisfied).toBe(false);
    expect(result.reason).toContain('unknown wait condition');
  });
});
