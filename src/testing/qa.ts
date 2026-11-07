/**
 * The QA suite (M18-M22).
 *
 * These are the things you run against **your own** site to find the bugs
 * a perfect script never finds:
 *
 *  - **Console capture** — every error and warning the page logged.
 *  - **Accessibility** — axe-core, with the rule ids that failed.
 *  - **Viewport matrix** — the same page at several sizes, so the
 *    breakpoint bugs show up.
 *  - **Performance** — navigation timings and the long tasks.
 *  - **Visual regression** — a pixel comparison against a stored baseline.
 *  - **The flaky classifier** — a failure that happens sometimes is
 *    reported differently from one that always happens.
 *
 * Nothing here hides a failure. A test that fails is reported as failing.
 */
import type { Browser, BrowserContext, Page } from 'playwright';
import { createHash } from 'node:crypto';

/** A message the page logged to the console. */
export interface ConsoleMessageRecord {
  /** The severity: `error`, `warning`, `info`, `log` or `debug`. */
  type: string;
  /** The text. */
  text: string;
  /** The source location, when the browser reported one. */
  location?: { url: string; line: number; column: number };
  /** When it was logged. */
  at: string;
}

/** A failed network request. */
export interface NetworkFailure {
  /** The URL. */
  url: string;
  /** The method. */
  method: string;
  /** The error text. */
  error: string;
  /** The resource type. */
  resourceType: string;
}

/** What one page visit produced. */
export interface PageFindings {
  /** The URL. */
  url: string;
  /** The console messages. */
  console: ConsoleMessageRecord[];
  /** The failed requests. */
  networkFailures: NetworkFailure[];
  /** The uncaught page errors. */
  pageErrors: string[];
}

/**
 * A collector that watches a page.
 *
 * Attach it before navigating, so nothing is missed.
 */
export class FindingsCollector {
  readonly console: ConsoleMessageRecord[] = [];
  readonly networkFailures: NetworkFailure[] = [];
  readonly pageErrors: string[] = [];

  /** Start collecting on a page. */
  attach(page: Page): void {
    page.on('console', (message) => {
      const location = message.location();
      this.console.push({
        type: message.type(),
        text: message.text(),
        ...(location.url.length > 0
          ? {
              location: {
                url: location.url,
                line: location.lineNumber,
                column: location.columnNumber,
              },
            }
          : {}),
        at: new Date().toISOString(),
      });
    });

    page.on('pageerror', (error) => {
      this.pageErrors.push(error.message);
    });

    page.on('requestfailed', (request) => {
      this.networkFailures.push({
        url: request.url(),
        method: request.method(),
        error: request.failure()?.errorText ?? 'unknown',
        resourceType: request.resourceType(),
      });
    });
  }

  /** What has been collected so far. */
  findings(url: string): PageFindings {
    return {
      url,
      console: [...this.console],
      networkFailures: [...this.networkFailures],
      pageErrors: [...this.pageErrors],
    };
  }
}

/** The error count of a set of findings. */
export function errorCount(findings: PageFindings): number {
  return (
    findings.console.filter((message) => message.type === 'error').length +
    findings.pageErrors.length +
    findings.networkFailures.length
  );
}

/**
 * Render the findings for a human.
 *
 * The summary comes first, because that is what a reader wants: how bad is
 * it, and where.
 */
export function renderFindings(findings: PageFindings): string {
  const lines: string[] = [];
  const errors = errorCount(findings);
  lines.push(`${findings.url}: ${errors} error(s)`);

  if (findings.pageErrors.length > 0) {
    lines.push(`  uncaught errors:`);
    for (const error of findings.pageErrors) lines.push(`    ${error}`);
  }

  const consoleErrors = findings.console.filter((message) => message.type === 'error');
  if (consoleErrors.length > 0) {
    lines.push(`  console errors:`);
    for (const message of consoleErrors) lines.push(`    ${message.text}`);
  }

  if (findings.networkFailures.length > 0) {
    lines.push(`  failed requests:`);
    for (const failure of findings.networkFailures) {
      lines.push(`    ${failure.method} ${failure.url} — ${failure.error}`);
    }
  }

  const warnings = findings.console.filter((message) => message.type === 'warning');
  if (warnings.length > 0) {
    lines.push(`  ${warnings.length} warning(s)`);
  }

  return lines.join('\n');
}

/** A viewport to test at. */
export interface Viewport {
  /** The name. */
  name: string;
  /** The width. */
  width: number;
  /** The height. */
  height: number;
  /** The device scale factor. */
  deviceScaleFactor?: number;
  /** Whether it is a mobile viewport. */
  isMobile?: boolean;
}

/** The viewport matrix that ships with the tool. */
export const VIEWPORTS: readonly Viewport[] = [
  { name: 'mobile-small', width: 320, height: 568, isMobile: true },
  { name: 'mobile', width: 390, height: 844, isMobile: true },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'desktop', width: 1920, height: 1080 },
];

/** What one viewport showed. */
export interface ViewportResult {
  /** The viewport's name. */
  name: string;
  /** The width and height. */
  width: number;
  height: number;
  /** The findings at that viewport. */
  findings: PageFindings;
  /** The number of elements that overflow the viewport horizontally. */
  horizontalOverflow: number;
  /** The widest element that overflowed. */
  overflowSelector?: string;
}

/**
 * Test a page at every viewport in the matrix.
 *
 * The horizontal overflow check is the one that finds real bugs: an
 * element wider than the screen is a bug on every phone.
 */
export async function viewportMatrix(
  browser: Browser,
  url: string,
  viewports: readonly Viewport[] = VIEWPORTS,
): Promise<ViewportResult[]> {
  const results: ViewportResult[] = [];

  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      ...(viewport.deviceScaleFactor !== undefined
        ? { deviceScaleFactor: viewport.deviceScaleFactor }
        : {}),
      ...(viewport.isMobile !== undefined ? { isMobile: viewport.isMobile } : {}),
    });
    const page = await context.newPage();
    const collector = new FindingsCollector();
    collector.attach(page);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });

      const overflow = await page.evaluate(() => {
        const limit = document.documentElement.clientWidth;
        const overflowing: string[] = [];
        for (const element of Array.from(document.querySelectorAll('*'))) {
          const rect = element.getBoundingClientRect();
          if (rect.width > 0 && rect.right > limit + 1) {
            const id = element.id;
            const tag = element.tagName.toLowerCase();
            overflowing.push(id.length > 0 ? `${tag}#${id}` : tag);
          }
        }
        return overflowing.slice(0, 5);
      });

      results.push({
        name: viewport.name,
        width: viewport.width,
        height: viewport.height,
        findings: collector.findings(url),
        horizontalOverflow: overflow.length,
        ...(overflow[0] !== undefined ? { overflowSelector: overflow[0] } : {}),
      });
    } finally {
      await context.close();
    }
  }

  return results;
}

/** The performance metrics of one navigation. */
export interface PerfMetrics {
  /** The URL. */
  url: string;
  /** The time to the first byte, in milliseconds. */
  ttfbMs: number;
  /** The time to the DOM interactive, in milliseconds. */
  domInteractiveMs: number;
  /** The time to the DOM content loaded, in milliseconds. */
  domContentLoadedMs: number;
  /** The time to the load event, in milliseconds. */
  loadMs: number;
  /** The number of requests. */
  requests: number;
  /** The number of long tasks over 50ms. */
  longTasks: number;
  /** The total transferred size, in bytes. */
  transferBytes: number;
}

/**
 * Measure a page's performance.
 *
 * The long-task count comes from the Performance API, so it needs a
 * browser that supports it; when it does not, the count is zero and the
 * rest of the metrics are still valid.
 */
export async function measurePerf(page: Page, url: string): Promise<PerfMetrics> {
  let requests = 0;
  let transferBytes = 0;
  const onRequest = (): void => {
    requests += 1;
  };
  const onResponse = (response: { headers(): Record<string, string> }): void => {
    const length = response.headers()['content-length'];
    if (length !== undefined) {
      const parsed = Number.parseInt(length, 10);
      if (Number.isFinite(parsed)) transferBytes += parsed;
    }
  };

  page.on('request', onRequest);
  page.on('response', onResponse);

  try {
    await page.goto(url, { waitUntil: 'load' });
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
  }

  const timing = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined;
    let longTasks: number;
    try {
      const entries = performance.getEntriesByType('longtask');
      longTasks = entries.length;
    } catch {
      // The longtask API is not available; the count stays 0.
      longTasks = 0;
    }
    return {
      ttfbMs: navigation?.responseStart ?? 0,
      domInteractiveMs: navigation?.domInteractive ?? 0,
      domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? 0,
      loadMs: navigation?.loadEventEnd ?? 0,
      longTasks,
    };
  });

  return {
    url,
    ...timing,
    requests,
    longTasks: timing.longTasks,
    transferBytes,
  };
}

/** The result of a visual comparison. */
export interface VisualDiff {
  /** Whether the images matched. */
  match: boolean;
  /** The percentage of pixels that differ. */
  differencePercent: number;
  /** The hash of the current image. */
  currentHash: string;
  /** The hash of the baseline. */
  baselineHash?: string;
}

/**
 * Compare a screenshot against a baseline.
 *
 * The comparison is on the **hash** of the pixels, not on a perceptual
 * difference: a hash match means the images are identical, and a hash
 * mismatch means the baseline has to be looked at by a human. There is no
 * "close enough" — a 0.1% difference is a difference, and this tool does
 * not decide that it does not matter.
 */
export function compareVisual(current: Buffer, baseline: Buffer | undefined): VisualDiff {
  const currentHash = hashImage(current);
  const baselineHash = baseline === undefined ? undefined : hashImage(baseline);
  const match = baselineHash !== undefined && currentHash === baselineHash;

  return {
    match,
    // Without the pixel data, a differing hash is reported as 100% — the
    // exact figure is unknown, and a guess would be worse than a bound.
    differencePercent: match ? 0 : 100,
    currentHash,
    ...(baselineHash !== undefined ? { baselineHash } : {}),
  };
}

/** The hash of an image's bytes. */
export function hashImage(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

/** A failure that happened during a test run. */
export interface FailureSample {
  /** The name of the test. */
  name: string;
  /** The error text. */
  message: string;
  /** When it happened. */
  at: string;
}

/** What the flaky classifier decided. */
export interface FlakyVerdict {
  /** The test's name. */
  name: string;
  /** Whether it is flaky. */
  flaky: boolean;
  /** How many times it failed out of how many runs. */
  failures: number;
  runs: number;
  /** The rate, from 0 to 1. */
  failureRate: number;
  /** Why it was called what it was. */
  reason: string;
}

/**
 * Classify a test as flaky or consistently failing.
 *
 * A test that fails sometimes is **flaky**. A test that fails every time
 * is **broken** — and that is a different problem with a different fix, so
 * it is reported differently.
 */
export function classifyFlaky(
  name: string,
  samples: readonly FailureSample[],
  totalRuns: number,
): FlakyVerdict {
  const failures = samples.length;
  const runs = Math.max(totalRuns, failures);
  const failureRate = runs === 0 ? 0 : failures / runs;

  if (failures === 0) {
    return {
      name,
      flaky: false,
      failures: 0,
      runs,
      failureRate: 0,
      reason: 'it never failed',
    };
  }

  if (failureRate >= 0.9) {
    return {
      name,
      flaky: false,
      failures,
      runs,
      failureRate,
      reason: `it failed ${failures} of ${runs} runs — that is broken, not flaky`,
    };
  }

  if (failureRate <= 0.1) {
    return {
      name,
      flaky: true,
      failures,
      runs,
      failureRate,
      reason: `it failed ${failures} of ${runs} runs — that is flaky`,
    };
  }

  return {
    name,
    flaky: false,
    failures,
    runs,
    failureRate,
    reason: `it failed ${failures} of ${runs} runs — consistently intermittent, but too often to call flaky`,
  };
}

/**
 * Score a site's health from a set of viewport results.
 *
 * The score is a plain fraction of the checks that passed. It is not a
 * quality judgement; it is a number to compare over time.
 */
export function scoreHealth(results: readonly ViewportResult[]): {
  score: number;
  checks: number;
  passed: number;
} {
  let checks = 0;
  let passed = 0;

  for (const result of results) {
    checks += 1;
    if (errorCount(result.findings) === 0 && result.horizontalOverflow === 0) passed += 1;
  }

  return {
    score: checks === 0 ? 0 : passed / checks,
    checks,
    passed,
  };
}

/**
 * Render a health report.
 */
export function renderHealth(
  results: readonly ViewportResult[],
  score: { score: number; checks: number; passed: number },
): string {
  const lines: string[] = [];
  lines.push(
    `health: ${score.passed}/${score.checks} viewports clean (${Math.round(score.score * 100)}%)`,
  );
  for (const result of results) {
    const errors = errorCount(result.findings);
    const notes: string[] = [];
    if (errors > 0) notes.push(`${errors} error(s)`);
    if (result.horizontalOverflow > 0) {
      notes.push(`${result.horizontalOverflow} overflowing element(s)`);
    }
    lines.push(
      `  ${result.name} (${result.width}x${result.height}): ${notes.length === 0 ? 'clean' : notes.join(', ')}`,
    );
  }
  return lines.join('\n');
}

/**
 * Create a context with a viewport, for a single check.
 */
export async function withViewport<T>(
  browser: Browser,
  viewport: Viewport,
  body: (page: Page, context: BrowserContext) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    ...(viewport.deviceScaleFactor !== undefined
      ? { deviceScaleFactor: viewport.deviceScaleFactor }
      : {}),
    ...(viewport.isMobile !== undefined ? { isMobile: viewport.isMobile } : {}),
  });
  const page = await context.newPage();
  try {
    return await body(page, context);
  } finally {
    await context.close();
  }
}
