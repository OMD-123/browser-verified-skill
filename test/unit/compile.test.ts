/**
 * Tests for the recorder, compiler, healer and replayer (M15).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchChromium } from '../../src/core/browser.js';
import { Recorder, candidatesFor, diffText, orderLocators } from '../../src/compile/recorder.js';
import { compileFlow, renderScript } from '../../src/compile/compiler.js';
import { DriftLog, describeUnchanged, healStep } from '../../src/compile/heal.js';
import { parseVariables, resolveValue, renderReplay } from '../../src/compile/replay.js';
import { findVariables, isVolatile, type RecordedRun } from '../../src/compile/ir.js';

describe('the locator candidates', () => {
  it('orders the candidates by the chain order', () => {
    const candidates = candidatesFor({
      ref: 'e1',
      role: 'button',
      name: 'Save',
      label: 'Save',
      text: 'Save',
      testId: 'save',
      css: '.save',
    });
    expect(candidates.map((c) => c.strategy)).toEqual([
      'ref',
      'role',
      'label',
      'text',
      'testid',
      'css',
    ]);
  });

  it('needs both a role and a name for the role candidate', () => {
    expect(candidatesFor({ role: 'button' })).toHaveLength(0);
    expect(candidatesFor({ role: 'button', name: 'Save' })).toHaveLength(1);
  });

  it('returns nothing for an empty target', () => {
    expect(candidatesFor({})).toEqual([]);
  });

  it('puts the winning candidate first', () => {
    const candidates = candidatesFor({ role: 'button', name: 'Save', css: '.save' });
    const ordered = orderLocators(candidates, 'css');
    expect(ordered[0]?.strategy).toBe('css');
  });

  it('keeps the order when there is no winner', () => {
    const candidates = candidatesFor({ role: 'button', name: 'Save', css: '.save' });
    expect(orderLocators(candidates, undefined)).toEqual(candidates);
  });
});

describe('the recorder', () => {
  it('records a step', () => {
    const recorder = new Recorder('run1');
    const step = recorder.record({
      kind: 'click',
      locators: candidatesFor({ role: 'button', name: 'Save' }),
      winningStrategy: 'role',
      pre: { url: 'http://x/' },
      post: { url: 'http://x/done' },
      durationMs: 12,
    });
    expect(step.index).toBe(1);
    expect(step.kind).toBe('click');
    expect(recorder.count).toBe(1);
  });

  it('infers a url assertion when the url changed', () => {
    const recorder = new Recorder('run1');
    const step = recorder.record({
      kind: 'click',
      locators: candidatesFor({ role: 'button', name: 'Save' }),
      pre: { url: 'http://x/' },
      post: { url: 'http://x/done' },
      durationMs: 12,
    });
    expect(step.assertions.some((a) => a.kind === 'url_changed')).toBe(true);
  });

  it('does not infer a url assertion for a volatile url', () => {
    const recorder = new Recorder('run1');
    const step = recorder.record({
      kind: 'click',
      locators: candidatesFor({ role: 'button', name: 'Save' }),
      pre: { url: 'http://x/' },
      post: { url: 'http://x/done?id=550e8400-e29b-41d4-a716-446655440000' },
      durationMs: 12,
    });
    expect(step.assertions.some((a) => a.kind === 'url_changed')).toBe(false);
  });

  it('infers a text assertion for stable text', () => {
    const recorder = new Recorder('run1');
    const step = recorder.record({
      kind: 'click',
      locators: candidatesFor({ role: 'button', name: 'Save' }),
      pre: { url: 'http://x/' },
      post: { url: 'http://x/', addedText: ['Saved successfully'] },
      durationMs: 12,
    });
    expect(step.assertions.some((a) => a.kind === 'text_added')).toBe(true);
  });

  it('does not infer a text assertion for volatile text', () => {
    const recorder = new Recorder('run1');
    const step = recorder.record({
      kind: 'click',
      locators: candidatesFor({ role: 'button', name: 'Save' }),
      pre: { url: 'http://x/' },
      post: { url: 'http://x/', addedText: ['Generated at 2026-01-01T10:00:00Z'] },
      durationMs: 12,
    });
    expect(step.assertions.some((a) => a.kind === 'text_added')).toBe(false);
  });

  it('infers a count assertion when the count changed', () => {
    const recorder = new Recorder('run1');
    const step = recorder.record({
      kind: 'click',
      locators: candidatesFor({ role: 'button', name: 'Save' }),
      pre: { url: 'http://x/', matchCount: 0 },
      post: { url: 'http://x/', matchCount: 3 },
      durationMs: 12,
    });
    expect(step.assertions.some((a) => a.kind === 'count_changed')).toBe(true);
  });

  it('infers a dialog assertion', () => {
    const recorder = new Recorder('run1');
    const step = recorder.record({
      kind: 'click',
      locators: candidatesFor({ role: 'button', name: 'Save' }),
      pre: { url: 'http://x/' },
      post: { url: 'http://x/', dialog: { type: 'confirm', message: 'Are you sure?' } },
      durationMs: 12,
    });
    expect(step.assertions.some((a) => a.kind === 'dialog_appeared')).toBe(true);
  });

  it('finishes into a run', () => {
    const recorder = new Recorder('run1');
    recorder.record({
      kind: 'click',
      locators: candidatesFor({ role: 'button', name: 'Save' }),
      pre: { url: 'http://x/' },
      post: { url: 'http://x/' },
      durationMs: 12,
    });
    const run = recorder.finish('the goal');
    expect(run.runId).toBe('run1');
    expect(run.goal).toBe('the goal');
    expect(run.steps).toHaveLength(1);
  });
});

describe('the volatility check', () => {
  it('recognises a uuid', () => {
    expect(isVolatile('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('recognises an iso timestamp', () => {
    expect(isVolatile('2026-01-01T10:00:00Z')).toBe(true);
  });

  it('recognises a unix timestamp', () => {
    expect(isVolatile('1767225600')).toBe(true);
  });

  it('recognises a time', () => {
    expect(isVolatile('at 10:30 today')).toBe(true);
  });

  it('recognises a label that says it is an id', () => {
    expect(isVolatile('Request id: abc')).toBe(true);
  });

  it('does not flag ordinary text', () => {
    expect(isVolatile('Order complete')).toBe(false);
    expect(isVolatile('Saved successfully')).toBe(false);
  });

  it('does not flag an empty string', () => {
    expect(isVolatile('')).toBe(false);
  });
});

describe('the text diff', () => {
  it('finds the added lines', () => {
    const diff = diffText('a\nb', 'a\nb\nc');
    expect(diff.added).toEqual(['c']);
  });

  it('finds the removed lines', () => {
    const diff = diffText('a\nb', 'a');
    expect(diff.removed).toEqual(['b']);
  });

  it('ignores empty lines', () => {
    const diff = diffText('a\n\nb', 'a');
    expect(diff.removed).toEqual(['b']);
  });
});

describe('the variable finder', () => {
  /** A run with a repeated value. */
  function run(): RecordedRun {
    return {
      runId: 'r1',
      steps: [
        {
          index: 1,
          kind: 'fill',
          locators: [],
          params: { value: 'a@b.test' },
          pre: { url: 'http://x/' },
          post: { url: 'http://x/' },
          assertions: [],
          durationMs: 1,
          at: 'now',
        },
        {
          index: 2,
          kind: 'fill',
          locators: [],
          params: { value: 'a@b.test' },
          pre: { url: 'http://x/' },
          post: { url: 'http://x/' },
          assertions: [],
          durationMs: 1,
          at: 'now',
        },
        {
          index: 3,
          kind: 'fill',
          locators: [],
          params: { value: 'once' },
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
  }

  it('finds a value used more than once', () => {
    const variables = findVariables(run());
    expect(variables).toHaveLength(1);
    expect(variables[0]?.defaultValue).toBe('a@b.test');
  });

  it('ignores a value used once', () => {
    const variables = findVariables(run());
    expect(variables.some((v) => v.defaultValue === 'once')).toBe(false);
  });

  it('replaces the value with a variable slot', () => {
    const flow = compileFlow(run());
    expect(flow.steps[0]?.params.value).toBe('{{var1}}');
    expect(flow.steps[1]?.params.value).toBe('{{var1}}');
    expect(flow.steps[2]?.params.value).toBe('once');
  });
});

describe('the compiler', () => {
  /** A run with a click and a fill. */
  function run(): RecordedRun {
    return {
      runId: 'r1',
      goal: 'sign in',
      steps: [
        {
          index: 1,
          kind: 'fill',
          locators: candidatesFor({ role: 'textbox', name: 'Email' }),
          params: { value: 'a@b.test' },
          pre: { url: 'http://x/' },
          post: { url: 'http://x/' },
          assertions: [],
          durationMs: 5,
          at: 'now',
        },
        {
          index: 2,
          kind: 'click',
          locators: candidatesFor({ role: 'button', name: 'Log in' }),
          params: {},
          pre: { url: 'http://x/' },
          post: { url: 'http://x/done' },
          assertions: [
            { kind: 'url_changed', description: 'the url changes', value: 'http://x/done' },
          ],
          durationMs: 5,
          at: 'now',
        },
      ],
      startedAt: 'now',
      finishedAt: 'now',
    };
  }

  it('emits a plain Playwright script', () => {
    const script = renderScript(compileFlow(run()));
    expect(script).toContain(
      "import { test, expect, type Page, type Locator } from '@playwright/test';",
    );
    expect(script).toContain("test('flow'");
  });

  it('does not import browser-verified-skill', () => {
    const script = renderScript(compileFlow(run()));
    // The script mentions browser-verified-skill in a comment, but it imports
    // nothing from it: the generated file runs in any Playwright project.
    expect(script).not.toMatch(/from ['"]browser-verified-skill/);
    expect(script).not.toMatch(/from ['"].*bv\.mjs/);
  });

  it('puts the goal in a comment', () => {
    const script = renderScript(compileFlow(run()));
    expect(script).toContain('// Goal: sign in');
  });

  it('emits the fill step', () => {
    const script = renderScript(compileFlow(run()));
    expect(script).toContain('.fill(');
  });

  it('emits the click step', () => {
    const script = renderScript(compileFlow(run()));
    expect(script).toContain('.click()');
  });

  it('emits the inferred url assertion', () => {
    const script = renderScript(compileFlow(run()));
    expect(script).toContain('await expect(page).toHaveURL("http://x/done")');
  });

  it('lists the fallback locators in a comment', () => {
    const withFallbacks = run();
    withFallbacks.steps[1] = {
      ...withFallbacks.steps[1]!,
      locators: [
        ...candidatesFor({ role: 'button', name: 'Log in' }),
        ...candidatesFor({ css: '#login' }),
      ],
    };
    const script = renderScript(compileFlow(withFallbacks));
    expect(script).toContain('// Fallback locators');
    expect(script).toContain('#login');
  });

  it('names the flow', () => {
    const script = renderScript(compileFlow(run(), 'my flow'));
    expect(script).toContain("test('my flow'");
  });

  it('renders a variable as a parameter', () => {
    const withVariables = run();
    withVariables.steps.push({
      ...withVariables.steps[0]!,
      index: 3,
      params: { value: 'a@b.test' },
    });
    const script = renderScript(compileFlow(withVariables));
    expect(script).toContain('interface FlowVars');
    expect(script).toContain('vars.var1');
  });
});

describe('the drift description', () => {
  it('says the role and name are unchanged', () => {
    expect(
      describeUnchanged(
        { strategy: 'role', value: 'role=button name="Sign in"', role: 'button', name: 'Sign in' },
        { strategy: 'role', value: 'role=button name="Sign in"', role: 'button', name: 'Sign in' },
      ),
    ).toBe('role/name unchanged');
  });

  it('says the role is unchanged', () => {
    expect(
      describeUnchanged(
        { strategy: 'role', value: 'role=button name="a"', role: 'button', name: 'a' },
        { strategy: 'role', value: 'role=button name="b"', role: 'button', name: 'b' },
      ),
    ).toBe('role unchanged');
  });

  it('says the name is unchanged', () => {
    expect(
      describeUnchanged(
        { strategy: 'role', value: 'role=button name="a"', role: 'button', name: 'a' },
        { strategy: 'role', value: 'role=link name="a"', role: 'link', name: 'a' },
      ),
    ).toBe('name unchanged');
  });

  it('says the test id is unchanged', () => {
    expect(
      describeUnchanged(
        { strategy: 'testid', value: 'testid=save', testId: 'save' },
        { strategy: 'testid', value: 'testid=save', testId: 'save' },
      ),
    ).toBe('test id unchanged');
  });

  it('says the label is unchanged', () => {
    expect(
      describeUnchanged(
        { strategy: 'label', value: 'label="Save"', label: 'Save' },
        { strategy: 'label', value: 'label="Save"', label: 'Save' },
      ),
    ).toBe('label unchanged');
  });

  it('says the text is unchanged', () => {
    expect(
      describeUnchanged(
        { strategy: 'text', value: 'text="Save"', text: 'Save' },
        { strategy: 'text', value: 'text="Save"', text: 'Save' },
      ),
    ).toBe('text unchanged');
  });

  it('falls back to a general description', () => {
    expect(
      describeUnchanged(
        { strategy: 'css', value: '#login', css: '#login' },
        { strategy: 'role', value: 'role=button name="x"', role: 'button', name: 'x' },
      ),
    ).toContain('the element is the same');
  });

  it('handles a missing original', () => {
    expect(describeUnchanged(undefined, { strategy: 'css', value: '#a', css: '#a' })).toBe(
      'no original locator',
    );
  });
});

describe('the drift log', () => {
  it('reports no drift when there is none', () => {
    const log = new DriftLog();
    expect(log.render()).toContain('No drift');
  });

  it('reports the drift', () => {
    const log = new DriftLog();
    log.add({
      stepIndex: 4,
      from: '#login',
      to: 'button[name=signin]',
      unchanged: 'role/name unchanged',
      at: 'now',
      reason: 'the original locator no longer matched',
    });
    expect(log.render()).toContain('Step 4');
    expect(log.render()).toContain('#login');
    expect(log.render()).toContain('button[name=signin]');
  });

  it('lists the drift for one step', () => {
    const log = new DriftLog();
    log.add({
      stepIndex: 4,
      from: 'a',
      to: 'b',
      unchanged: 'x',
      at: 'now',
      reason: 'r',
    });
    expect(log.forStep(4)).toHaveLength(1);
    expect(log.forStep(5)).toHaveLength(0);
  });
});

describe('the healer', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchChromium();
    page = await browser.newPage();
    await page.setContent(`
      <html><body>
        <button id="random-a1b2" onclick="this.textContent='Signed in'">Sign in</button>
        <button data-testid="signin">Sign in</button>
      </body></html>
    `);
  });

  afterAll(async () => {
    await browser.close();
  });

  it('heals a step whose css locator broke', async () => {
    const log = new DriftLog();
    const step = {
      index: 4,
      kind: 'click' as const,
      locators: [
        { strategy: 'css' as const, value: '#gone', css: '#gone' },
        {
          strategy: 'role' as const,
          value: 'role=button name="Sign in"',
          role: 'button',
          name: 'Sign in',
        },
      ],
      params: {},
      pre: { url: 'http://x/' },
      post: { url: 'http://x/' },
      assertions: [],
      durationMs: 1,
      at: 'now',
    };
    const result = await healStep(page, step, log);
    expect(result.healed).toBe(true);
    expect(result.step?.locators[0]?.strategy).toBe('role');
    expect(result.drift?.from).toBe('#gone');
    expect(result.drift?.to).toContain('role=button');
  });

  it('records the drift', async () => {
    const log = new DriftLog();
    const step = {
      index: 4,
      kind: 'click' as const,
      locators: [
        { strategy: 'css' as const, value: '#gone', css: '#gone' },
        {
          strategy: 'role' as const,
          value: 'role=button name="Sign in"',
          role: 'button',
          name: 'Sign in',
        },
      ],
      params: {},
      pre: { url: 'http://x/' },
      post: { url: 'http://x/' },
      assertions: [],
      durationMs: 1,
      at: 'now',
    };
    await healStep(page, step, log);
    expect(log.size).toBe(1);
  });

  it('does not heal a step that still works', async () => {
    const log = new DriftLog();
    const step = {
      index: 1,
      kind: 'click' as const,
      locators: [
        {
          strategy: 'role' as const,
          value: 'role=button name="Sign in"',
          role: 'button',
          name: 'Sign in',
        },
      ],
      params: {},
      pre: { url: 'http://x/' },
      post: { url: 'http://x/' },
      assertions: [],
      durationMs: 1,
      at: 'now',
    };
    const result = await healStep(page, step, log);
    expect(result.healed).toBe(false);
    expect(log.size).toBe(0);
  });

  it('reports when nothing matched', async () => {
    const log = new DriftLog();
    const step = {
      index: 1,
      kind: 'click' as const,
      locators: [{ strategy: 'css' as const, value: '#gone', css: '#gone' }],
      params: {},
      pre: { url: 'http://x/' },
      post: { url: 'http://x/' },
      assertions: [],
      durationMs: 1,
      at: 'now',
    };
    const result = await healStep(page, step, log);
    expect(result.healed).toBe(false);
    expect(result.reason).toContain('no recorded locator matched');
  });
});

describe('the replay helpers', () => {
  it('parses variable pairs', () => {
    expect(parseVariables(['a=1', 'b=2'])).toEqual({ a: '1', b: '2' });
  });

  it('ignores a pair with no equals sign', () => {
    expect(parseVariables(['nope'])).toEqual({});
  });

  it('ignores a pair with an empty name', () => {
    expect(parseVariables(['=1'])).toEqual({});
  });

  it('keeps the last value for a repeated name', () => {
    expect(parseVariables(['a=1', 'a=2'])).toEqual({ a: '2' });
  });

  it('keeps an equals sign in the value', () => {
    expect(parseVariables(['a=b=c'])).toEqual({ a: 'b=c' });
  });

  it('resolves a variable slot', () => {
    expect(resolveValue('{{var1}}', { var1: 'x' })).toBe('x');
  });

  it('keeps an unresolved slot', () => {
    expect(resolveValue('{{var1}}', {})).toBe('{{var1}}');
  });

  it('keeps a literal value', () => {
    expect(resolveValue('plain', {})).toBe('plain');
  });

  it('handles an absent value', () => {
    expect(resolveValue(undefined, {})).toBeUndefined();
  });
});

describe('the replay report', () => {
  it('reports a successful replay', () => {
    const text = renderReplay({
      ok: true,
      steps: [
        {
          index: 1,
          ok: true,
          strategy: 'role',
          attempted: ['a'],
          durationMs: 1,
          urlAfter: 'http://x/',
          healed: false,
        },
      ],
      drift: new DriftLog(),
      healedCount: 0,
      durationMs: 10,
    });
    expect(text).toContain('Replay succeeded');
  });

  it('reports a failed replay', () => {
    const text = renderReplay({
      ok: false,
      steps: [
        {
          index: 1,
          ok: false,
          attempted: ['a', 'b'],
          message: 'not found',
          durationMs: 1,
          urlAfter: 'http://x/',
          healed: false,
        },
      ],
      drift: new DriftLog(),
      healedCount: 0,
      durationMs: 10,
    });
    expect(text).toContain('Replay failed');
    expect(text).toContain('not found');
    expect(text).toContain('tried: a, b');
  });
});
