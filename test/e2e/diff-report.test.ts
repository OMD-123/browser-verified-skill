/**
 * Tests for the differential runner and the bug reporter (M23, M24).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Browser } from 'playwright';
import { launchChromium } from '../../src/core/browser.js';
import { diffPages, renderDiff } from '../../src/testing/diff.js';
import {
  buildReports,
  renderFullReport,
  renderReports,
  renderReportsJson,
  totalErrors,
  worthReporting,
} from '../../src/testing/report.js';
import type { PageFindings } from '../../src/testing/qa.js';

/** The fixture server's base URL. */
const FIXTURE = process.env['BV_FIXTURE_ORIGIN'] ?? 'http://127.0.0.1:3000';

/** A page with a unique button. */
const PAGE_A = `
  <html lang="en"><head><title>A</title></head><body>
    <h1>Page A</h1>
    <button id="only-a">Only in A</button>
    <button id="shared">Shared</button>
    <input id="box" type="text" />
  </body></html>
`;

describe('the differential runner', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchChromium();
  });

  afterAll(async () => {
    await browser.close();
  });

  it('finds what only one page has', async () => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await pageA.setContent(PAGE_A);
    await pageB.setContent(`
      <html lang="en"><head><title>B</title></head><body>
        <h1>Page B</h1>
        <button id="only-b">Only in B</button>
        <button id="shared">Shared</button>
      </body></html>
    `);

    const result = await diffPages(
      browser,
      `data:text/html,${encodeURIComponent(PAGE_A)}`,
      `data:text/html,${encodeURIComponent(`<html lang="en"><head><title>B</title></head><body><h1>Page B</h1><button>Only in B</button><button>Shared</button></body></html>`)}`,
    );

    expect(result.identical).toBe(false);
    expect(result.onlyInA.some((d) => d.name.includes('Only in A'))).toBe(true);
    expect(result.onlyInB.some((d) => d.name.includes('Only in B'))).toBe(true);
    await context.close();
  });

  it('says two identical pages are identical', async () => {
    const html = '<html lang="en"><head><title>Same</title></head><body><h1>Same</h1><button>Go</button></body></html>';
    const url = `data:text/html,${encodeURIComponent(html)}`;

    const result = await diffPages(browser, url, url);
    expect(result.identical).toBe(true);
  });

  it('counts the nodes in each tree', async () => {
    const html = '<html lang="en"><head><title>A</title></head><body><h1>A</h1></body></html>';
    const result = await diffPages(
      browser,
      `data:text/html,${encodeURIComponent(html)}`,
      `data:text/html,${encodeURIComponent(html)}`,
    );
    expect(result.nodeCounts.a).toBe(result.nodeCounts.b);
  });

  it('renders the difference', async () => {
    const htmlA = '<html lang="en"><head><title>A</title></head><body><button>Only A</button></body></html>';
    const htmlB = '<html lang="en"><head><title>B</title></head><body><button>Only B</button></body></html>';

    const result = await diffPages(
      browser,
      `data:text/html,${encodeURIComponent(htmlA)}`,
      `data:text/html,${encodeURIComponent(htmlB)}`,
    );
    const text = renderDiff(result);
    expect(text).toContain('Only in A');
    expect(text).toContain('Only in B');
  });

  it('says identical pages have the same tree', async () => {
    const html = '<html lang="en"><head><title>S</title></head><body><h1>S</h1></body></html>';
    const url = `data:text/html,${encodeURIComponent(html)}`;
    const result = await diffPages(browser, url, url);
    expect(renderDiff(result)).toContain('same accessibility tree');
  });

  it('compares two real pages', async () => {
    const result = await diffPages(
      browser,
      `${FIXTURE}/pages/login.html`,
      `${FIXTURE}/pages/index.html`,
    );
    expect(result.urlA).toContain('login');
    expect(result.nodeCounts.a).toBeGreaterThan(0);
  });
});

describe('the bug reporter', () => {
  /** Findings with one of everything. */
  function findings(): PageFindings {
    return {
      url: 'http://x/page',
      console: [{ type: 'error', text: 'the console broke', at: 'now' }],
      networkFailures: [
        { url: 'http://x/missing', method: 'GET', error: 'net::ERR_FAILED', resourceType: 'script' },
      ],
      pageErrors: ['the page threw'],
    };
  }

  it('reports an uncaught page error', () => {
    const reports = buildReports(findings());
    expect(reports.some((report) => report.kind === 'page-error')).toBe(true);
  });

  it('reports a console error', () => {
    const reports = buildReports(findings());
    expect(reports.some((report) => report.kind === 'console-error')).toBe(true);
  });

  it('reports a failed request', () => {
    const reports = buildReports(findings());
    expect(reports.some((report) => report.kind === 'network-failure')).toBe(true);
  });

  it('reports an overflowing element', () => {
    const reports = buildReports(findings(), {
      viewport: {
        name: 'small',
        width: 320,
        height: 568,
        findings: findings(),
        horizontalOverflow: 2,
        overflowSelector: 'div#wide',
      },
    });
    expect(reports.some((report) => report.kind === 'overflow')).toBe(true);
  });

  it('gives every report an id', () => {
    for (const report of buildReports(findings())) {
      expect(report.id).toMatch(/^bug-[0-9a-f]+$/);
    }
  });

  it('gives the same problem the same id', () => {
    const first = buildReports(findings())[0];
    const second = buildReports(findings())[0];
    expect(first?.id).toBe(second?.id);
  });

  it('gives different problems different ids', () => {
    const one = buildReports(findings());
    const two = buildReports({ ...findings(), url: 'http://y/page' });
    expect(one[0]?.id).not.toBe(two[0]?.id);
  });

  it('says how to reproduce each problem', () => {
    const reports = buildReports(findings(), { reproSteps: ['open the page'] });
    expect(reports[0]?.reproduce).toContain('open the page');
  });

  it('makes an uncaught error critical', () => {
    const reports = buildReports(findings());
    const pageError = reports.find((report) => report.kind === 'page-error');
    expect(pageError?.severity).toBe('critical');
  });

  it('renders the reports as Markdown', () => {
    const text = renderReports(buildReports(findings()));
    expect(text).toContain('# Problems found');
    expect(text).toContain('How to reproduce');
    expect(text).toContain('the page threw');
  });

  it('says there is nothing to report', () => {
    expect(renderReports([])).toContain('No problems found');
  });

  it('renders the reports as JSON', () => {
    const json = renderReportsJson(buildReports(findings()));
    const parsed = JSON.parse(json) as { count: number; reports: unknown[] };
    // One page error, one console error and one failed request.
    expect(parsed.count).toBe(3);
    expect(parsed.reports).toHaveLength(3);
  });

  it('renders the full report', () => {
    const text = renderFullReport(findings(), buildReports(findings()));
    expect(text).toContain('error(s)');
    expect(text).toContain('# Problems found');
  });

  it('counts the errors', () => {
    expect(totalErrors(findings())).toBe(3);
  });

  it('knows whether there is anything to report', () => {
    expect(worthReporting(findings())).toBe(true);
    expect(
      worthReporting({
        url: 'http://x/',
        console: [],
        networkFailures: [],
        pageErrors: [],
      }),
    ).toBe(false);
  });
});
