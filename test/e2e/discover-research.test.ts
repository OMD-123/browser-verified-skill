/**
 * Tests for the API discovery and the research module (M25, M26).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Browser } from 'playwright';
import { launchChromium } from '../../src/core/browser.js';
import {
  asOpenApiFragment,
  discoverEndpoints,
  isApiPath,
  renderEndpoints,
  watchEndpoints,
  type ObservedRequest,
} from '../../src/testing/discover.js';
import { bestSentence, extractText, renderResearch, research } from '../../src/testing/research.js';

/** The fixture server's base URL. */
const FIXTURE = process.env['BV_FIXTURE_ORIGIN'] ?? 'http://127.0.0.1:3000';

/** A request. */
function request(url: string, method = 'GET', status = 200): ObservedRequest {
  return { url, method, status, at: 'now' };
}

describe('the API discovery', () => {
  it('lists the endpoints that were used', () => {
    const endpoints = discoverEndpoints([
      request('https://x.test/api/users'),
      request('https://x.test/api/orders'),
    ]);
    expect(endpoints).toHaveLength(2);
  });

  it('drops the query string', () => {
    const endpoints = discoverEndpoints([request('https://x.test/api/users?token=secret')]);
    expect(endpoints[0]?.path).toBe('/api/users');
    expect(endpoints[0]?.url).not.toContain('secret');
  });

  it('counts the calls to one endpoint', () => {
    const endpoints = discoverEndpoints([
      request('https://x.test/api/users'),
      request('https://x.test/api/users'),
    ]);
    expect(endpoints[0]?.calls).toBe(2);
  });

  it('collects the statuses', () => {
    const endpoints = discoverEndpoints([
      request('https://x.test/api/users', 'GET', 200),
      request('https://x.test/api/users', 'GET', 404),
    ]);
    expect(endpoints[0]?.statuses).toEqual([200, 404]);
  });

  it('ignores a URL that cannot be parsed', () => {
    expect(discoverEndpoints([request('not a url')])).toHaveLength(0);
  });

  it('ignores a non-http URL', () => {
    expect(discoverEndpoints([request('data:text/html,hello')])).toHaveLength(0);
  });

  it('marks an api path', () => {
    expect(isApiPath('/api/users')).toBe(true);
    expect(isApiPath('/graphql')).toBe(false);
    expect(isApiPath('/graphql/query')).toBe(true);
    expect(isApiPath('/')).toBe(false);
    expect(isApiPath('/data.json')).toBe(true);
  });

  it('renders the endpoints', () => {
    const endpoints = discoverEndpoints([request('https://x.test/api/users')]);
    const text = renderEndpoints(endpoints);
    expect(text).toContain('GET');
    expect(text).toContain('/api/users');
    expect(text).toContain('Only endpoints this run actually used');
  });

  it('says there is nothing when there is nothing', () => {
    expect(renderEndpoints([])).toContain('No network endpoints');
  });

  it('builds an OpenAPI fragment', () => {
    const endpoints = discoverEndpoints([
      request('https://x.test/api/users'),
      request('https://x.test/page', 'GET'),
    ]);
    const fragment = asOpenApiFragment(endpoints) as {
      paths: Record<string, Record<string, unknown>>;
      info: { description: string };
    };
    expect(fragment.paths['/api/users']).toBeDefined();
    // The document page is not an API, so it is not in the fragment.
    expect(fragment.paths['/page']).toBeUndefined();
    expect(fragment.info.description).toContain('not a specification');
  });

  it('watches a page for requests', async () => {
    const browser = await launchChromium();
    const page = await browser.newPage();
    const watcher = watchEndpoints(page);
    await page.goto(`${FIXTURE}/pages/index.html`);
    await page.waitForTimeout(300);
    watcher.stop();
    await browser.close();

    expect(watcher.facts.length).toBeGreaterThan(0);
  });
});

describe('the sentence finder', () => {
  it('finds the sentence that shares the most words with the question', () => {
    const text =
      'The shop opens at nine. Shipping is free over fifty pounds. Returns are accepted within thirty days.';
    const result = bestSentence(text, 'How long do returns take?');
    expect(result.sentence).toContain('Returns');
  });

  it('scores zero when nothing matches', () => {
    const result = bestSentence('A completely unrelated sentence about cats.', 'shipping policy');
    expect(result.score).toBe(0);
  });

  it('ignores very short sentences', () => {
    const result = bestSentence(
      'Hi. The shipping policy is free over fifty pounds.',
      'shipping policy',
    );
    expect(result.sentence).toContain('shipping policy');
  });

  it('ignores a very long sentence', () => {
    const long = `${'x'.repeat(700)} shipping policy`;
    const result = bestSentence(long, 'shipping policy');
    expect(result.sentence).toBe('');
  });
});

describe('the research module', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchChromium();
  });

  afterAll(async () => {
    await browser.close();
  });

  it('extracts the text of a page', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(
      '<html><body><h1>Heading</h1><p>The body text.</p><script>const x = 1;</script></body></html>',
    );
    const text = await extractText(page);
    await context.close();

    expect(text).toContain('The body text.');
    // The script is not part of the readable text.
    expect(text).not.toContain('const x');
  });

  it('answers a question from a source', async () => {
    // A data URL, so the source can be navigated to again: `research`
    // opens each source in a fresh navigation.
    const html =
      '<html><body><p>Shipping is free over fifty pounds.</p>' +
      '<p>Returns are accepted for thirty days after delivery.</p></body></html>';
    const url = `data:text/html,${encodeURIComponent(html)}`;

    const result = await research(
      browser,
      [{ question: 'How long are returns accepted for?' }],
      [url],
    );

    expect(result.answers[0]?.answer).toContain('Returns');
    expect(result.answers[0]?.citation?.url).toBe(url);
    expect(result.answers[0]?.confidence).toBeGreaterThan(0);
  });

  it('reports a question the sources did not answer', async () => {
    const html = '<html><body><p>Nothing relevant here at all.</p></body></html>';
    const url = `data:text/html,${encodeURIComponent(html)}`;

    const result = await research(
      browser,
      [{ question: 'What is the refund window for cryptocurrency?' }],
      [url],
    );

    expect(result.answers[0]?.answer).toBeNull();
    // The source that was consulted is still listed.
    expect(result.answers[0]?.sourcesRead).toHaveLength(1);
  });

  it('records a source it could not read', async () => {
    const result = await research(
      browser,
      [{ question: 'anything' }],
      ['http://127.0.0.1:1/definitely-not-there'],
    );
    expect(result.sourcesFailed).toHaveLength(1);
    expect(result.sourcesRead).toHaveLength(0);
  });

  it('renders the result', async () => {
    const result = await research(
      browser,
      [{ question: 'anything' }],
      ['http://127.0.0.1:1/definitely-not-there'],
    );
    const text = renderResearch(result);
    expect(text).toContain('Q: anything');
    expect(text).toContain('not answered');
    expect(text).toContain('could not be read');
  });
});
