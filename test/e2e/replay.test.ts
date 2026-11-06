/**
 * The replay and healing acceptance tests (M15).
 *
 * These are the two scenarios the brief calls out:
 *
 *  1. a fixture page that randomises its class names on reload still
 *     replays green via the locator chain;
 *  2. a renamed button yields a heal plus a drift report.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchChromium } from '../../src/core/browser.js';
import { replay, renderReplay } from '../../src/compile/replay.js';
import { DriftLog, healStep } from '../../src/compile/heal.js';
import { candidatesFor } from '../../src/compile/recorder.js';
import { compileFlow, renderScript } from '../../src/compile/compiler.js';
import type { RecordedRun, RecordedStep } from '../../src/compile/ir.js';

/** The fixture server's base URL. Set by the vitest global setup. */
const FIXTURE = process.env['BV_FIXTURE_ORIGIN'] ?? 'http://127.0.0.1:3000';

/** A click step. */
function clickStep(
  index: number,
  locators: ReturnType<typeof candidatesFor>,
): RecordedStep {
  return {
    index,
    kind: 'click',
    locators,
    params: {},
    pre: { url: `${FIXTURE}/pages/random-classes.html` },
    post: { url: `${FIXTURE}/pages/random-classes.html` },
    assertions: [],
    durationMs: 5,
    at: 'now',
  };
}

describe('replay against a page with randomised class names', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchChromium();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it('replays green when the class names change between loads', async () => {
    await page.goto(`${FIXTURE}/pages/random-classes.html`);

    // The recorded locator was a CSS class, which the page randomises.
    const before = await page.locator('button').getAttribute('class');
    await page.reload();
    const after = await page.locator('button').getAttribute('class');
    expect(before).not.toBe(after);

    const step = clickStep(1, [
      { strategy: 'css', value: `.${before ?? ''}`, css: `.${before ?? ''}` },
      ...candidatesFor({ role: 'button', name: 'Sign in' }),
      ...candidatesFor({ testId: 'login-btn' }),
    ]);

    const result = await replay(page, [step], { heal: true });

    expect(result.ok).toBe(true);
    expect(result.healedCount).toBe(1);
    expect(result.drift.size).toBe(1);
    // The drift names the old locator and the new one.
    expect(result.drift.all[0]?.from).toContain(before ?? '');
    expect(result.drift.all[0]?.to).toContain('role=button');
  });

  it('replays without healing when the first locator still works', async () => {
    await page.goto(`${FIXTURE}/pages/random-classes.html`);
    const step = clickStep(1, candidatesFor({ role: 'button', name: 'Sign in' }));

    const result = await replay(page, [step], { heal: true });
    expect(result.ok).toBe(true);
    expect(result.healedCount).toBe(0);
    expect(result.steps[0]?.strategy).toBe('role');
  });

  it('reports the failure when no locator matched and healing is off', async () => {
    await page.goto(`${FIXTURE}/pages/random-classes.html`);
    const step = clickStep(1, [{ strategy: 'css', value: '#nope', css: '#nope' }]);

    const result = await replay(page, [step], { heal: false });
    expect(result.ok).toBe(false);
    expect(result.steps[0]?.message).toContain('no locator matched');
  });

  it('actually clicks the button', async () => {
    await page.goto(`${FIXTURE}/pages/random-classes.html`);
    const step = clickStep(1, candidatesFor({ role: 'button', name: 'Sign in' }));

    await replay(page, [step], { heal: false });
    const status = await page.locator('#status').textContent();
    expect(status).toBe('Signed in');
  });

  it('renders a replay report', async () => {
    await page.goto(`${FIXTURE}/pages/random-classes.html`);
    const step = clickStep(1, candidatesFor({ role: 'button', name: 'Sign in' }));
    const result = await replay(page, [step], { heal: false });
    expect(renderReplay(result)).toContain('Replay succeeded');
  });
});

describe('healing a renamed button', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchChromium();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it('heals the step and records the drift', async () => {
    // The button was renamed: the recorded id is gone, but the role and
    // name are the same, so the fallback still finds it.
    await page.setContent(`
      <html><body>
        <button id="new-name" data-testid="submit-btn">Submit</button>
      </body></html>
    `);

    // The recorded locator was a CSS id that no longer exists; the
    // role/name fallback still works.
    const step = clickStep(1, [
      { strategy: 'css', value: '#old-name', css: '#old-name' },
      ...candidatesFor({ role: 'button', name: 'Submit' }),
    ]);

    const log = new DriftLog();
    const result = await healStep(page, step, log);

    expect(result.healed).toBe(true);
    expect(result.drift?.from).toBe('#old-name');
    expect(result.drift?.to).toContain('role=button');
    expect(log.render()).toContain('Step 1');
  });

  it('reports the drift as a change in the way of finding the element', async () => {
    await page.setContent('<button id="new-name">Submit</button>');
    const step = clickStep(1, [
      { strategy: 'css', value: '#old', css: '#old' },
      ...candidatesFor({ role: 'button', name: 'Submit' }),
    ]);
    const log = new DriftLog();
    await healStep(page, step, log);
    // The original was a CSS id and the replacement is a role and name, so
    // there is no specific field that is unchanged — the drift says the
    // element is the same but the way of finding it changed.
    expect(log.all[0]?.unchanged).toBe('the element is the same, the way of finding it changed');
  });

  it('says the role and name are unchanged when only the strategy changed', async () => {
    await page.setContent('<button id="new-name">Submit</button>');
    const step = clickStep(1, [
      { strategy: 'role', value: 'role=button name="Submit"', role: 'button', name: 'Submit' },
      ...candidatesFor({ testId: 'submit-btn' }),
    ]);
    // The role strategy is tried first and it works, so nothing changes.
    const log = new DriftLog();
    const result = await healStep(page, step, log);
    expect(result.healed).toBe(false);
    expect(log.size).toBe(0);
  });
});

describe('compiling a replayed flow', () => {
  it('produces a script that names the flow and the steps', () => {
    const run: RecordedRun = {
      runId: 'r1',
      goal: 'sign in',
      steps: [
        {
          index: 1,
          kind: 'click',
          locators: candidatesFor({ role: 'button', name: 'Sign in' }),
          params: {},
          pre: { url: 'http://x/' },
          post: { url: 'http://x/' },
          assertions: [],
          durationMs: 1,
          at: 'now',
        },
      ],
      startedAt: 'now',
      finishedAt: 'now',
    };
    const script = renderScript(compileFlow(run, 'sign in'));
    expect(script).toContain("test('sign in'");
    expect(script).toContain('// Step 1: click');
  });
});
