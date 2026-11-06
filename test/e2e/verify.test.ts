/**
 * Tests for the verifier (M12).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchChromium } from '../../src/core/browser.js';
import { verify, matchesPattern } from '../../src/verify/verifier.js';
import {
  summarizeVerification,
  describeCondition,
  evidenceIsComplete,
} from '../../src/verify/evidence.js';

describe('the pattern matcher', () => {
  it('matches a substring', () => {
    expect(matchesPattern('http://x/done', 'done')).toBe(true);
  });

  it('does not match a missing substring', () => {
    expect(matchesPattern('http://x/', 'done')).toBe(false);
  });

  it('matches a regular expression written as one', () => {
    expect(matchesPattern('http://x/done', '/done$/')).toBe(true);
    expect(matchesPattern('http://x/done?a=1', '/done\\?/')).toBe(true);
  });

  it('falls back to a substring for an invalid regular expression', () => {
    expect(matchesPattern('http://x/[bad', '/[bad/')).toBe(true);
  });
});

describe('the verifier', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchChromium();
    page = await browser.newPage();
    await page.setContent(`
      <html><body>
        <h1>Order complete</h1>
        <p>Thank you for your purchase.</p>
        <button>Continue</button>
        <button>Cancel</button>
        <div style="display:none">Hidden text</div>
      </body></html>
    `);
  });

  afterAll(async () => {
    await browser.close();
  });

  it('verifies a url condition', async () => {
    const result = await verify({ type: 'url_matches', pattern: 'about:blank' }, { page });
    expect(result.passed).toBe(true);
    expect(result.evidence[0]?.kind).toBe('url');
  });

  it('fails a url condition that does not match', async () => {
    const result = await verify({ type: 'url_matches', pattern: '/nope' }, { page });
    expect(result.passed).toBe(false);
    expect(result.results[0]?.reason).toContain('does not match');
  });

  it('verifies visible text', async () => {
    const result = await verify({ type: 'text_visible', text: 'Order complete' }, { page });
    expect(result.passed).toBe(true);
    expect(result.evidence[0]?.kind).toBe('text');
  });

  it('fails for text that is not there', async () => {
    const result = await verify({ type: 'text_visible', text: 'Nonexistent phrase' }, { page });
    expect(result.passed).toBe(false);
  });

  it('does not count hidden text as visible', async () => {
    const result = await verify({ type: 'text_visible', text: 'Hidden text' }, { page });
    expect(result.passed).toBe(false);
  });

  it('counts elements', async () => {
    const result = await verify({ type: 'element', role: 'button' }, { page });
    expect(result.passed).toBe(true);
    expect(result.evidence[0]?.value).toBe(2);
  });

  it('counts elements by name', async () => {
    const result = await verify({ type: 'element', role: 'button', name: 'Continue' }, { page });
    expect(result.evidence[0]?.value).toBe(1);
  });

  it('enforces a minimum count', async () => {
    const result = await verify({ type: 'element', role: 'button', min: 5 }, { page });
    expect(result.passed).toBe(false);
  });

  it('enforces a maximum count', async () => {
    const result = await verify({ type: 'element', role: 'button', max: 1 }, { page });
    expect(result.passed).toBe(false);
  });

  it('verifies a network response', async () => {
    const result = await verify(
      { type: 'network_response', urlPattern: '/api/ok', status: 200 },
      {
        page,
        network: [{ url: 'http://x/api/ok', status: 200, at: 'now' }],
      },
    );
    expect(result.passed).toBe(true);
    expect(result.evidence[0]?.kind).toBe('network');
  });

  it('fails a network response that did not happen', async () => {
    const result = await verify(
      { type: 'network_response', urlPattern: '/api/ok', status: 200 },
      { page, network: [] },
    );
    expect(result.passed).toBe(false);
  });

  it('fails a network response with the wrong status', async () => {
    const result = await verify(
      { type: 'network_response', urlPattern: '/api/ok', status: 200 },
      { page, network: [{ url: 'http://x/api/ok', status: 500, at: 'now' }] },
    );
    expect(result.passed).toBe(false);
  });

  it('verifies a storage key', async () => {
    const result = await verify(
      { type: 'storage', key: 'auth', matches: 'ok' },
      { page, storage: { auth: 'ok' } },
    );
    expect(result.passed).toBe(true);
    expect(result.evidence[0]?.kind).toBe('storage');
  });

  it('fails a storage key that is not set', async () => {
    const result = await verify(
      { type: 'storage', key: 'auth', matches: 'ok' },
      { page, storage: {} },
    );
    expect(result.passed).toBe(false);
    expect(result.results[0]?.reason).toContain('not set');
  });

  it('fails a storage key with the wrong value', async () => {
    const result = await verify(
      { type: 'storage', key: 'auth', matches: 'ok' },
      { page, storage: { auth: 'nope' } },
    );
    expect(result.passed).toBe(false);
  });

  it('reports an llm-judged condition as unverified in Mode A', async () => {
    const result = await verify(
      { type: 'llm_judged', claim: 'the page shows a receipt' },
      { page },
    );
    expect(result.passed).toBe(false);
    expect(result.results[0]?.reason).toContain('unverified');
  });

  it('verifies an all composition', async () => {
    const result = await verify(
      {
        all: [
          { type: 'url_matches', pattern: 'about:blank' },
          { type: 'text_visible', text: 'Order complete' },
        ],
      },
      { page },
    );
    expect(result.passed).toBe(true);
  });

  it('fails an all composition when one branch fails', async () => {
    const result = await verify(
      {
        all: [
          { type: 'url_matches', pattern: 'about:blank' },
          { type: 'text_visible', text: 'Nonexistent' },
        ],
      },
      { page },
    );
    expect(result.passed).toBe(false);
  });

  it('verifies an any composition', async () => {
    const result = await verify(
      {
        any: [
          { type: 'text_visible', text: 'Nonexistent' },
          { type: 'text_visible', text: 'Order complete' },
        ],
      },
      { page },
    );
    expect(result.passed).toBe(true);
  });

  it('fails an any composition when no branch passes', async () => {
    const result = await verify(
      {
        any: [
          { type: 'text_visible', text: 'Nonexistent' },
          { type: 'text_visible', text: 'Also nonexistent' },
        ],
      },
      { page },
    );
    expect(result.passed).toBe(false);
  });

  it('verifies a not composition', async () => {
    const result = await verify({ not: { type: 'text_visible', text: 'Nonexistent' } }, { page });
    expect(result.passed).toBe(true);
  });

  it('fails a not composition when the inner condition passes', async () => {
    const result = await verify(
      { not: { type: 'text_visible', text: 'Order complete' } },
      { page },
    );
    expect(result.passed).toBe(false);
  });

  it('records every branch of a composition', async () => {
    const result = await verify(
      {
        all: [
          { type: 'url_matches', pattern: 'about:blank' },
          { type: 'text_visible', text: 'Order complete' },
        ],
      },
      { page },
    );
    // An `all` composition is the conjunction of its branches, so it adds
    // no result of its own; the branches are the results.
    expect(result.results.length).toBe(2);
  });

  it('records the verdict of an any composition as its own result', async () => {
    const result = await verify(
      {
        any: [
          { type: 'text_visible', text: 'Nonexistent' },
          { type: 'text_visible', text: 'Order complete' },
        ],
      },
      { page },
    );
    // An `any` composition records the branches *and* its own verdict, so
    // that a caller can see how many branches passed.
    expect(result.results.length).toBe(3);
    expect(result.results[2]?.passed).toBe(true);
  });

  it('gathers evidence for every leaf', async () => {
    const result = await verify(
      {
        all: [
          { type: 'url_matches', pattern: 'about:blank' },
          { type: 'text_visible', text: 'Order complete' },
        ],
      },
      { page },
    );
    expect(result.evidence.length).toBe(2);
    expect(evidenceIsComplete(result.evidence)).toBe(true);
  });

  it('records when the verification ran', async () => {
    const result = await verify({ type: 'url_matches', pattern: 'about:blank' }, { page });
    expect(result.verifiedAt).toBeDefined();
    expect(result.url).toBe(page.url());
  });
});

describe('the verification summary', () => {
  it('says VERIFIED when everything passed', async () => {
    const browser = await launchChromium();
    const page = await browser.newPage();
    await page.setContent('<p>Hello</p>');
    const result = await verify({ type: 'text_visible', text: 'Hello' }, { page });
    const summary = summarizeVerification(result);
    await browser.close();
    expect(summary).toContain('VERIFIED');
  });

  it('says UNVERIFIED when something failed', async () => {
    const browser = await launchChromium();
    const page = await browser.newPage();
    await page.setContent('<p>Hello</p>');
    const result = await verify({ type: 'text_visible', text: 'Nope' }, { page });
    const summary = summarizeVerification(result);
    await browser.close();
    expect(summary).toContain('UNVERIFIED');
  });
});

describe('the condition description', () => {
  it('describes each condition type', () => {
    expect(describeCondition({ type: 'url_matches', pattern: '/x' })).toContain('url matches');
    expect(describeCondition({ type: 'text_visible', text: 'a' })).toContain('text visible');
    expect(describeCondition({ type: 'element', role: 'button' })).toContain('role=button');
    expect(
      describeCondition({ type: 'network_response', urlPattern: '/x', status: 200 }),
    ).toContain('network');
    expect(describeCondition({ type: 'storage', key: 'a', matches: 'b' })).toContain('storage');
    expect(describeCondition({ type: 'llm_judged', claim: 'c' })).toContain('llm judged');
  });

  it('describes an element condition with its bounds', () => {
    const text = describeCondition({ type: 'element', role: 'button', name: 'Go', min: 1, max: 2 });
    expect(text).toContain('name=Go');
    expect(text).toContain('min=1');
    expect(text).toContain('max=2');
  });

  it('describes a composition', () => {
    expect(describeCondition({ all: [] })).toContain('all(');
    expect(describeCondition({ any: [] })).toContain('any(');
    expect(describeCondition({ not: { type: 'url_matches', pattern: 'x' } })).toContain('not(');
  });

  it('describes something that is not a condition', () => {
    expect(describeCondition('plain')).toBe('plain');
    expect(describeCondition(null)).toBe('null');
    expect(describeCondition({ type: 'unknown' })).toContain('unknown');
  });
});
