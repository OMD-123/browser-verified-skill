/**
 * Tests for the test runner and the red-team runner (M32, M33).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Browser } from 'playwright';
import { launchChromium } from '../../src/core/browser.js';
import { parseSuite, renderSuite, runSuite } from '../../src/testing/suite.js';
import { CATALOGUE, renderRedTeam, runRedTeam } from '../../src/testing/redteam.js';

/** The fixture server's base URL. */
const FIXTURE = process.env['BV_FIXTURE_ORIGIN'] ?? 'http://127.0.0.1:3000';

describe('the suite parser', () => {
  it('parses a suite', () => {
    const suite = parseSuite({
      name: 'a suite',
      checks: [
        {
          name: 'a check',
          url: 'http://x/',
          expect: { type: 'url_matches', pattern: '/x' },
          tags: ['smoke'],
        },
      ],
    });
    expect(suite.name).toBe('a suite');
    expect(suite.checks).toHaveLength(1);
    expect(suite.checks[0]?.tags).toEqual(['smoke']);
  });

  it('rejects a suite with no name', () => {
    expect(() => parseSuite({ checks: [] })).toThrow('needs a "name"');
  });

  it('rejects a suite with no checks', () => {
    expect(() => parseSuite({ name: 'a' })).toThrow('needs a "checks" list');
  });

  it('rejects a check with no url', () => {
    expect(() =>
      parseSuite({
        name: 'a',
        checks: [{ name: 'c', expect: { type: 'url_matches', pattern: '/x' } }],
      }),
    ).toThrow('needs a "url"');
  });

  it('rejects a check with no condition', () => {
    expect(() => parseSuite({ name: 'a', checks: [{ name: 'c', url: 'http://x/' }] })).toThrow(
      'needs an "expect"',
    );
  });

  it('rejects a suite that is not an object', () => {
    expect(() => parseSuite('nope')).toThrow('must be an object');
  });
});

describe('the test runner', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchChromium();
  });

  afterAll(async () => {
    await browser.close();
  });

  it('runs a passing check', async () => {
    const result = await runSuite(browser, {
      name: 'a suite',
      checks: [
        {
          name: 'the index loads',
          url: `${FIXTURE}/pages/index.html`,
          expect: { type: 'url_matches', pattern: '/pages/index' },
        },
      ],
    });

    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.results[0]?.passed).toBe(true);
  });

  it('reports a failing check', async () => {
    const result = await runSuite(browser, {
      name: 'a suite',
      checks: [
        {
          name: 'a check that cannot pass',
          url: `${FIXTURE}/pages/index.html`,
          expect: { type: 'text_visible', text: 'not on the page' },
        },
      ],
    });

    expect(result.failed).toBe(1);
    expect(result.results[0]?.reason).toContain('not visible');
  });

  it('reports a URL it could not reach', async () => {
    const result = await runSuite(browser, {
      name: 'a suite',
      checks: [
        {
          name: 'an unreachable url',
          url: 'http://127.0.0.1:1/nothing-here',
          expect: { type: 'url_matches', pattern: '/x' },
        },
      ],
    });

    expect(result.failed).toBe(1);
    expect(result.results[0]?.reason).toBeDefined();
  });

  it('filters by tag', async () => {
    const result = await runSuite(
      browser,
      {
        name: 'a suite',
        checks: [
          {
            name: 'a smoke check',
            url: `${FIXTURE}/pages/index.html`,
            expect: { type: 'url_matches', pattern: '/pages/index' },
            tags: ['smoke'],
          },
          {
            name: 'a slow check',
            url: `${FIXTURE}/pages/login.html`,
            expect: { type: 'url_matches', pattern: '/pages/login' },
            tags: ['slow'],
          },
        ],
      },
      { tags: ['smoke'] },
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.name).toBe('a smoke check');
  });

  it('gives each check a fresh page', async () => {
    // The second check would fail if the first one's page were reused.
    const result = await runSuite(browser, {
      name: 'a suite',
      checks: [
        {
          name: 'first',
          url: `${FIXTURE}/pages/index.html`,
          expect: { type: 'url_matches', pattern: '/pages/index' },
        },
        {
          name: 'second',
          url: `${FIXTURE}/pages/login.html`,
          expect: { type: 'url_matches', pattern: '/pages/login' },
        },
      ],
    });

    expect(result.passed).toBe(2);
  });

  it('renders the failures first', async () => {
    const result = await runSuite(browser, {
      name: 'a suite',
      checks: [
        {
          name: 'a passing check',
          url: `${FIXTURE}/pages/index.html`,
          expect: { type: 'url_matches', pattern: '/pages/index' },
        },
        {
          name: 'a failing check',
          url: `${FIXTURE}/pages/index.html`,
          expect: { type: 'text_visible', text: 'not on the page' },
        },
      ],
    });

    const text = renderSuite(result);
    // The failing check is named at the top; the passing ones are only
    // counted, because a reader who stops after the first screen needs to
    // have seen what broke, not what passed.
    expect(text.indexOf('a failing check')).toBeLessThan(text.indexOf('1 check(s) passed'));
    expect(text).toContain('1/2 passed');
  });
});

describe('the red-team runner', () => {
  it('catches every attack in the catalogue', async () => {
    const result = await runRedTeam();

    const missed = result.results.filter((entry) => !entry.caught).map((entry) => entry.name);
    expect(missed, `these attacks got through: ${missed.join(', ')}`).toEqual([]);
  });

  it('has a catalogue worth running', () => {
    expect(CATALOGUE.length).toBeGreaterThanOrEqual(12);
  });

  it('covers more than one kind of attack', () => {
    const kinds = new Set(CATALOGUE.map((attack) => attack.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(2);
  });

  it('names every attack', () => {
    for (const attack of CATALOGUE) {
      expect(attack.name.length).toBeGreaterThan(0);
      expect(attack.technique.length).toBeGreaterThan(0);
    }
  });

  it('renders the result', async () => {
    const text = renderRedTeam(await runRedTeam());
    expect(text).toContain('attack(s) were caught');
    expect(text).toContain('✓');
  });

  it('says when something got through', () => {
    const text = renderRedTeam({
      results: [{ name: 'an attack', technique: 'a technique', caught: false }],
      passed: 0,
      failed: 1,
      total: 1,
    });
    expect(text).toContain('got through');
    expect(text).toContain('✗');
  });
});
