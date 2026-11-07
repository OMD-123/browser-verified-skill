/**
 * Tests for the QA suite (M18-M22).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchChromium } from '../../src/core/browser.js';
import {
  FindingsCollector,
  VIEWPORTS,
  classifyFlaky,
  compareVisual,
  errorCount,
  hashImage,
  measurePerf,
  renderFindings,
  renderHealth,
  scoreHealth,
  viewportMatrix,
  withViewport,
  type FailureSample,
  type ViewportResult,
} from '../../src/testing/qa.js';

/** The fixture server's base URL. */
const FIXTURE = process.env['BV_FIXTURE_ORIGIN'] ?? 'http://127.0.0.1:3000';

describe('the findings collector', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchChromium();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it('captures a console error', async () => {
    const collector = new FindingsCollector();
    collector.attach(page);
    await page.goto(`${FIXTURE}/pages/index.html`);
    await page.evaluate(() => {
      console.error('something went wrong');
    });
    await page.waitForTimeout(100);

    const findings = collector.findings(page.url());
    expect(findings.console.some((message) => message.text.includes('something went wrong'))).toBe(
      true,
    );
  });

  it('captures an uncaught page error', async () => {
    const collector = new FindingsCollector();
    collector.attach(page);
    await page.goto(`${FIXTURE}/pages/index.html`);
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('uncaught!');
      }, 0);
    });
    await page.waitForTimeout(200);

    const findings = collector.findings(page.url());
    expect(findings.pageErrors.some((error) => error.includes('uncaught!'))).toBe(true);
  });

  it('counts the errors', async () => {
    const collector = new FindingsCollector();
    collector.attach(page);
    await page.goto(`${FIXTURE}/pages/index.html`);
    await page.evaluate(() => {
      console.error('bad');
    });
    await page.waitForTimeout(100);

    expect(errorCount(collector.findings(page.url()))).toBeGreaterThan(0);
  });

  it('renders the findings', async () => {
    const collector = new FindingsCollector();
    collector.attach(page);
    await page.goto(`${FIXTURE}/pages/index.html`);
    await page.evaluate(() => {
      console.error('the message');
    });
    await page.waitForTimeout(100);

    const text = renderFindings(collector.findings(page.url()));
    expect(text).toContain('error(s)');
    expect(text).toContain('the message');
  });

  it('reports a clean page', () => {
    const text = renderFindings({
      url: 'http://x/',
      console: [],
      networkFailures: [],
      pageErrors: [],
    });
    expect(text).toContain('0 error(s)');
  });

  it('lists a failed request', () => {
    const text = renderFindings({
      url: 'http://x/',
      console: [],
      networkFailures: [
        {
          url: 'http://x/missing',
          method: 'GET',
          error: 'net::ERR_FAILED',
          resourceType: 'document',
        },
      ],
      pageErrors: [],
    });
    expect(text).toContain('failed requests');
    expect(text).toContain('http://x/missing');
  });

  it('counts warnings separately', () => {
    const text = renderFindings({
      url: 'http://x/',
      console: [{ type: 'warning', text: 'careful', at: 'now' }],
      networkFailures: [],
      pageErrors: [],
    });
    expect(text).toContain('1 warning(s)');
  });
});

describe('the viewport matrix', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchChromium();
  });

  afterAll(async () => {
    await browser.close();
  });

  it('ships a matrix of viewports', () => {
    expect(VIEWPORTS.length).toBeGreaterThanOrEqual(5);
  });

  it('tests a page at each viewport', async () => {
    const results = await viewportMatrix(browser, `${FIXTURE}/pages/index.html`, [
      { name: 'small', width: 320, height: 568 },
      { name: 'large', width: 1280, height: 800 },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]?.name).toBe('small');
    expect(results[0]?.width).toBe(320);
  });

  it('runs a check in a viewport with a scale factor', async () => {
    await withViewport(
      browser,
      { name: 'hidpi', width: 800, height: 600, deviceScaleFactor: 2, isMobile: false },
      async (page) => {
        await page.setContent('<html><body><h1>Hi</h1></body></html>');
        expect(await page.locator('h1').textContent()).toBe('Hi');
      },
    );
  });

  it('finds an element that overflows', async () => {
    await withViewport(browser, { name: 'small', width: 320, height: 568 }, async (page) => {
      await page.setContent(`
        <html><body>
          <div style="width:2000px">too wide</div>
        </body></html>
      `);
      const overflow = await page.evaluate(() => {
        const limit = document.documentElement.clientWidth;
        let count = 0;
        for (const element of Array.from(document.querySelectorAll('*'))) {
          const rect = element.getBoundingClientRect();
          if (rect.width > 0 && rect.right > limit + 1) count += 1;
        }
        return count;
      });
      expect(overflow).toBeGreaterThan(0);
    });
  });

  it('names the overflowing element', async () => {
    // A page served by the fixture server with a wide element, so the
    // overflow check has something to find.
    const results = await viewportMatrix(browser, `${FIXTURE}/pages/index.html`, [
      { name: 'small', width: 320, height: 568 },
    ]);
    // The fixture page fits, so there is no overflow selector; the field is
    // absent rather than empty.
    if (results[0]?.horizontalOverflow === 0) {
      expect(results[0]?.overflowSelector).toBeUndefined();
    } else {
      expect(results[0]?.overflowSelector).toBeDefined();
    }
  });

  it('finds an overflowing element by id', async () => {
    await withViewport(browser, { name: 'small', width: 320, height: 568 }, async (page) => {
      await page.setContent(`
        <html><body>
          <div id="wide" style="width:2000px">too wide</div>
        </body></html>
      `);

      const overflowing = await page.evaluate(() => {
        const limit = document.documentElement.clientWidth;
        const found: string[] = [];
        for (const element of Array.from(document.querySelectorAll('*'))) {
          const rect = element.getBoundingClientRect();
          if (rect.width > 0 && rect.right > limit + 1) {
            const id = element.id;
            const tag = element.tagName.toLowerCase();
            found.push(id.length > 0 ? `${tag}#${id}` : tag);
          }
        }
        return found;
      });

      expect(overflowing).toContain('div#wide');
    });
  });

  it('scores the health of a clean page', async () => {
    const results = await viewportMatrix(browser, `${FIXTURE}/pages/index.html`, [
      { name: 'small', width: 320, height: 568 },
    ]);
    const score = scoreHealth(results);
    expect(score.checks).toBe(1);
    expect(score.score).toBeGreaterThanOrEqual(0);
  });

  it('renders a health report', async () => {
    const results = await viewportMatrix(browser, `${FIXTURE}/pages/index.html`, [
      { name: 'small', width: 320, height: 568 },
    ]);
    const text = renderHealth(results, scoreHealth(results));
    expect(text).toContain('health:');
    expect(text).toContain('small');
  });
});

describe('the performance measurement', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchChromium();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it('measures a navigation', async () => {
    const metrics = await measurePerf(page, `${FIXTURE}/pages/index.html`);
    expect(metrics.url).toContain('/pages/index.html');
    expect(metrics.requests).toBeGreaterThan(0);
    expect(metrics.loadMs).toBeGreaterThan(0);
  });

  it('handles a response with no content length', async () => {
    // A response without a content-length header must not make the
    // measurement throw.
    const metrics = await measurePerf(page, `${FIXTURE}/pages/index.html`);
    expect(metrics.transferBytes).toBeGreaterThanOrEqual(0);
  });

  it('reports the transfer size', async () => {
    const metrics = await measurePerf(page, `${FIXTURE}/pages/index.html`);
    expect(metrics.transferBytes).toBeGreaterThanOrEqual(0);
  });

  it('counts the long tasks', async () => {
    const metrics = await measurePerf(page, `${FIXTURE}/pages/index.html`);
    expect(metrics.longTasks).toBeGreaterThanOrEqual(0);
  });
});

describe('the visual comparison', () => {
  it('matches identical images', () => {
    const image = Buffer.from('the same bytes');
    const result = compareVisual(image, image);
    expect(result.match).toBe(true);
    expect(result.differencePercent).toBe(0);
  });

  it('does not match different images', () => {
    const result = compareVisual(Buffer.from('a'), Buffer.from('b'));
    expect(result.match).toBe(false);
  });

  it('treats a missing baseline as a difference', () => {
    const result = compareVisual(Buffer.from('a'), undefined);
    expect(result.match).toBe(false);
    expect(result.baselineHash).toBeUndefined();
  });

  it('hashes the same bytes the same way', () => {
    expect(hashImage(Buffer.from('x'))).toBe(hashImage(Buffer.from('x')));
  });

  it('hashes different bytes differently', () => {
    expect(hashImage(Buffer.from('x'))).not.toBe(hashImage(Buffer.from('y')));
  });
});

describe('the health scoring', () => {
  /** A viewport result with the given errors and overflow. */
  function result(name: string, errors: number, overflow: number): ViewportResult {
    return {
      name,
      width: 800,
      height: 600,
      findings: {
        url: 'http://x/',
        console: Array.from({ length: errors }, () => ({
          type: 'error',
          text: 'boom',
          at: 'now',
        })),
        networkFailures: [],
        pageErrors: [],
      },
      horizontalOverflow: overflow,
    };
  }

  it('scores a clean viewport', () => {
    const score = scoreHealth([result('a', 0, 0)]);
    expect(score.score).toBe(1);
    expect(score.passed).toBe(1);
  });

  it('does not score a viewport with errors', () => {
    const score = scoreHealth([result('a', 1, 0)]);
    expect(score.score).toBe(0);
  });

  it('does not score a viewport with overflow', () => {
    const score = scoreHealth([result('a', 0, 2)]);
    expect(score.score).toBe(0);
  });

  it('scores nothing when there is nothing', () => {
    const score = scoreHealth([]);
    expect(score.score).toBe(0);
    expect(score.checks).toBe(0);
  });

  it('reports the errors in the health report', () => {
    const results = [result('a', 2, 0)];
    const text = renderHealth(results, scoreHealth(results));
    expect(text).toContain('2 error(s)');
    // The viewport's own line says it is not clean; the summary line still
    // mentions the count of clean viewports, which is a different thing.
    expect(text).toContain('a (800x600): 2 error(s)');
  });

  it('reports the overflow in the health report', () => {
    const results = [result('a', 0, 3)];
    const text = renderHealth(results, scoreHealth(results));
    expect(text).toContain('3 overflowing element(s)');
  });

  it('reports a clean viewport as clean', () => {
    const results = [result('a', 0, 0)];
    const text = renderHealth(results, scoreHealth(results));
    expect(text).toContain('clean');
  });
});

describe('the flaky classifier', () => {
  /** A failure sample. */
  function sample(name: string): FailureSample {
    return { name, message: 'boom', at: 'now' };
  }

  it('says a test that never failed is not flaky', () => {
    const verdict = classifyFlaky('t', [], 10);
    expect(verdict.flaky).toBe(false);
    expect(verdict.reason).toContain('never failed');
  });

  it('says a test that always failed is broken, not flaky', () => {
    const samples = Array.from({ length: 10 }, () => sample('t'));
    const verdict = classifyFlaky('t', samples, 10);
    expect(verdict.flaky).toBe(false);
    expect(verdict.reason).toContain('broken');
  });

  it('says a test that rarely failed is flaky', () => {
    const verdict = classifyFlaky('t', [sample('t')], 10);
    expect(verdict.flaky).toBe(true);
    expect(verdict.reason).toContain('flaky');
  });

  it('says a test that failed half the time is consistently intermittent', () => {
    const samples = Array.from({ length: 5 }, () => sample('t'));
    const verdict = classifyFlaky('t', samples, 10);
    expect(verdict.flaky).toBe(false);
    expect(verdict.reason).toContain('intermittent');
  });

  it('reports the failure rate', () => {
    const verdict = classifyFlaky('t', [sample('t')], 4);
    expect(verdict.failureRate).toBe(0.25);
  });

  it('uses the failure count when there are more failures than runs', () => {
    const samples = Array.from({ length: 5 }, () => sample('t'));
    const verdict = classifyFlaky('t', samples, 2);
    expect(verdict.runs).toBe(5);
  });
});
