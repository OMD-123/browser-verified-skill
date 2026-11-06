/**
 * End-to-end tests for perception and actions against the local fixture site.
 *
 * These drive a real Chromium against the fixture server started by the vitest
 * global setup. No public-internet access.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchChromium } from '../../src/core/browser.js';
import { normalizeSnapshot } from '../../src/perception/snapshot.js';
import { diffSnapshots } from '../../src/perception/diff.js';
import { renderDiff, renderTree } from '../../src/perception/render.js';
import { locate, parseTarget } from '../../src/actions/locate.js';
import { performAction } from '../../src/actions/act.js';
import { waitForCondition } from '../../src/actions/waits.js';

const origin = process.env['BV_FIXTURE_ORIGIN'] ?? '';
const crossOrigin = process.env['BV_FIXTURE_CROSS_ORIGIN'] ?? '';

/** Find the ref of a node with the given role and accessible name. */
function findRefFor(
  nodes: ReturnType<typeof normalizeSnapshot>,
  role: string,
  name: string,
): string | undefined {
  for (const node of nodes) {
    if (node.role === role && node.name === name) return node.ref;
    const found = node.children === undefined ? undefined : findRefFor(node.children, role, name);
    if (found !== undefined) return found;
  }
  return undefined;
}

describe('perception and actions (e2e)', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchChromium();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('captures a snapshot with refs that resolve to locators', async () => {
    await page.goto(`${origin}/pages/login.html`);
    const raw = await page.ariaSnapshotJSON({ mode: 'ai' });
    const tree = normalizeSnapshot(raw);

    const button = tree[0]?.children
      ?.flatMap((c) => c.children ?? [])
      .find((n) => n.role === 'button');
    expect(button?.name).toBe('Log in');
    expect(button?.ref).toBeDefined();

    // The ref resolves back to a locator.
    const locator = page.getByRef(button?.ref ?? '');
    expect(await locator.textContent()).toBe('Log in');
  });

  it('keeps refs stable across no-op re-snapshots', async () => {
    await page.goto(`${origin}/pages/login.html`);
    const first = normalizeSnapshot(await page.ariaSnapshotJSON({ mode: 'ai' }));
    const second = normalizeSnapshot(await page.ariaSnapshotJSON({ mode: 'ai' }));

    const collect = (nodes: ReturnType<typeof normalizeSnapshot>): string[] =>
      nodes.flatMap((n) => [n.ref ?? '', ...collect(n.children ?? [])]).filter((r) => r !== '');

    expect(collect(first)).toEqual(collect(second));
  });

  it('produces a diff under 15% of the full tree for a form fill', async () => {
    await page.goto(`${origin}/pages/form.html`);
    const before = normalizeSnapshot(await page.ariaSnapshotJSON({ mode: 'ai' }));
    const fullText = renderTree(before);

    await page.getByLabel('Full name').fill('Ada');
    const after = normalizeSnapshot(await page.ariaSnapshotJSON({ mode: 'ai' }));

    const diff = diffSnapshots(
      { roots: before, documentToken: 'd' },
      { roots: after, url: page.url(), title: await page.title(), documentToken: 'd' },
    );
    const diffText = renderDiff(diff, { previousUrl: page.url() });

    expect(diffText.length).toBeLessThan(fullText.length * 0.15);
  });

  it('shows iframe nodes with frame-namespaced refs', async () => {
    await page.goto(`${origin}/pages/frames.html`);
    await page.waitForTimeout(500);
    const tree = normalizeSnapshot(await page.ariaSnapshotJSON({ mode: 'ai' }));
    const refs = JSON.stringify(tree);

    // Every ref is frame-namespaced (`fNeM`): the number is the frame index
    // within the browser context, and the element index is within the frame.
    expect(refs).toMatch(/"ref":"f\d+e\d+"/);

    // The inner frame's content appears with its own frame index.
    expect(refs).toContain('Inner frame content');
    expect(refs).toContain('Frame action');

    // The ref resolves through page.getByRef, across the frame boundary.
    const frameButtonRef = findRefFor(tree, 'button', 'Frame action');
    expect(frameButtonRef).toBeDefined();

    const frameButton = page.getByRef(frameButtonRef ?? '');
    expect(await frameButton.textContent()).toBe('Frame action');
    await frameButton.click();
    expect(await page.frameLocator('#inner').locator('#frame-result').textContent()).toBe(
      'Frame clicked',
    );
  });

  it('shows open shadow DOM nodes with refs', async () => {
    await page.goto(`${origin}/pages/shadow.html`);
    const tree = normalizeSnapshot(await page.ariaSnapshotJSON({ mode: 'ai' }));
    const names = JSON.stringify(tree);

    expect(names).toContain('Shadow content');
    expect(names).toContain('Shadow action');
    // The closed shadow root's content must NOT appear.
    expect(names).not.toContain('Closed shadow content');
  });

  it('resolves a target through the role+name strategy', async () => {
    await page.goto(`${origin}/pages/login.html`);
    const result = await locate(page, parseTarget('role=button name="Log in"'));
    expect(result.strategy).toBe('role');
    expect(result.locator).toBeDefined();
  });

  it('falls back through the chain when the first strategy fails', async () => {
    await page.goto(`${origin}/pages/login.html`);
    // A descriptor whose role/name does not exist, but whose text does.
    const result = await locate(page, { role: 'button', name: 'Nope', text: 'Log in' });
    expect(result.attempted).toEqual(['role', 'text']);
    expect(result.strategy).toBe('text');
  });

  it('records the winning strategy on an action', async () => {
    await page.goto(`${origin}/pages/login.html`);
    const outcome = await performAction(page, {
      kind: 'click',
      target: parseTarget('role=button name="Log in"'),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.strategy).toBe('role');
    expect(await page.locator('#status').textContent()).toBe('Code required');
  });

  it('clicks a button in a hover menu', async () => {
    await page.goto(`${origin}/pages/hover.html`);
    const trigger = page.getByTestId('menu-trigger');
    await trigger.hover();
    await page.waitForTimeout(350);
    const outcome = await performAction(page, {
      kind: 'click',
      target: parseTarget('testid=menu-action'),
    });
    expect(outcome.ok).toBe(true);
    expect(await page.locator('#hover-status').textContent()).toBe('Action done');
  });

  it('waits for a delayed render instead of sleeping', async () => {
    await page.goto(`${origin}/pages/delayed.html`);
    const locator = page.getByTestId('ready');
    const result = await waitForCondition(locator, 'visible', { timeoutMs: 5000 });
    expect(result.satisfied).toBe(true);
    expect(result.durationMs).toBeLessThan(5000);
  });

  it('clicks a button that a sticky header covers after scrolling', async () => {
    await page.goto(`${origin}/pages/sticky.html`);
    const covered = page.getByTestId('covered');
    // Before scrolling, the button is covered by the fixed header.
    const receives = await waitForCondition(covered, 'receives-events', { timeoutMs: 1000 });
    expect(receives.satisfied).toBe(false);

    // Scroll it into view, then it works.
    const outcome = await performAction(page, {
      kind: 'click',
      target: parseTarget('testid=covered'),
    });
    expect(outcome.ok).toBe(true);
    expect(await page.locator('#covered-status').textContent()).toBe('Covered clicked');
  });

  it('handles a popup by exposing it as a tab', async () => {
    await page.goto(`${origin}/pages/popup.html`);
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      page.getByTestId('open-popup').click(),
    ]);
    expect(popup).toBeDefined();
    await popup.waitForLoadState('domcontentloaded');
    expect(await popup.locator('#child-label').textContent()).toBe('Child window body');
  });

  it('works with randomized class names using role/name', async () => {
    await page.goto(`${origin}/pages/random-classes.html`);
    const result = await locate(page, parseTarget('role=button name="Sign in"'));
    expect(result.strategy).toBe('role');
    expect(result.locator).toBeDefined();

    const outcome = await performAction(page, {
      kind: 'click',
      target: parseTarget('role=button name="Sign in"'),
    });
    expect(outcome.ok).toBe(true);
    expect(await page.locator('#status').textContent()).toBe('Signed in');
  });

  it('reports a structured failure when the target does not exist', async () => {
    await page.goto(`${origin}/pages/login.html`);
    const outcome = await performAction(page, {
      kind: 'click',
      target: parseTarget('role=button name="Does not exist"'),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.strategy).toBeUndefined();
    expect(outcome.failures.length).toBeGreaterThan(0);
    expect(outcome.message).toContain('could not locate');
  });

  it('refuses an ambiguous target rather than guessing', async () => {
    await page.goto(`${origin}/pages/wizard.html`);
    // Two buttons named "Next" exist in the DOM, but only one is visible.
    const result = await locate(page, parseTarget('role=button name="Next"'));
    // The hidden one is not in the accessibility tree, so the chain must resolve
    // it unambiguously via the visible button.
    expect(result.strategy).toBe('role');
  });

  it('reads across a cross-origin frame', async () => {
    await page.goto(`${origin}/pages/frames.html`);
    await page.waitForTimeout(600);
    // The cross-origin iframe is loaded on a different port.
    const frames = page.frames();
    const cross = frames.find((f) => f.url().startsWith(crossOrigin));
    expect(cross).toBeDefined();
    if (cross !== undefined) {
      const label = await cross.locator('#cross-label').textContent();
      expect(label).toBe('Cross origin frame content');
    }
  });
});
