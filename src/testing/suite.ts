/**
 * The test runner (M32).
 *
 * `bv test` runs a set of checks against a site and reports what failed.
 *
 * A check is a **declarative** thing: a URL, a condition that must hold,
 * and what to do when it does not. The runner does not decide what "good"
 * means; the check file does.
 *
 * The output is a report, not a score. A score hides which check failed,
 * and the failed check is the only part anyone needs.
 */
import type { Browser } from 'playwright';
import { verify } from '../verify/verifier.js';
import type { Condition } from '../safety/planlock.js';
import { FindingsCollector, errorCount, type PageFindings } from './qa.js';

/** One check. */
export interface TestCheck {
  /** The check's name. */
  name: string;
  /** The URL to visit. */
  url: string;
  /** The condition that must hold. */
  expect: Condition;
  /** Whether the page may log errors and still pass. Default false. */
  allowConsoleErrors?: boolean;
  /** The tags, for filtering. */
  tags?: string[];
}

/** A set of checks. */
export interface TestSuite {
  /** The suite's name. */
  name: string;
  /** The checks. */
  checks: TestCheck[];
}

/** The result of one check. */
export interface CheckResult {
  /** The check's name. */
  name: string;
  /** Whether it passed. */
  passed: boolean;
  /** Why it failed. */
  reason?: string;
  /** The tags. */
  tags: string[];
  /** How long it took. */
  durationMs: number;
  /** The page's findings, when the check failed on them. */
  findings?: PageFindings;
}

/** The result of a whole suite. */
export interface SuiteResult {
  /** The suite's name. */
  name: string;
  /** The results. */
  results: CheckResult[];
  /** How many passed. */
  passed: number;
  /** How many failed. */
  failed: number;
  /** How long it took. */
  durationMs: number;
}

/**
 * Run a suite of checks.
 *
 * Each check gets a fresh page, so one check cannot leave the next one in
 * a broken state.
 */
export async function runSuite(
  browser: Browser,
  suite: TestSuite,
  options: { tags?: string[] } = {},
): Promise<SuiteResult> {
  const startedAt = Date.now();
  const results: CheckResult[] = [];

  const checks =
    options.tags !== undefined
      ? suite.checks.filter((check) =>
          (check.tags ?? []).some((tag) => options.tags?.includes(tag)),
        )
      : suite.checks;

  for (const check of checks) {
    const checkStarted = Date.now();
    const context = await browser.newContext();
    const page = await context.newPage();
    const collector = new FindingsCollector();
    collector.attach(page);

    try {
      await page.goto(check.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      const result = await verify(check.expect, { page });
      const findings = collector.findings(check.url);
      const errors = errorCount(findings);
      const consoleFailed = errors > 0 && check.allowConsoleErrors !== true;

      if (result.passed && !consoleFailed) {
        results.push({
          name: check.name,
          passed: true,
          tags: check.tags ?? [],
          durationMs: Date.now() - checkStarted,
        });
        continue;
      }

      const reason = result.passed
        ? `the page logged ${errors} error(s)`
        : (result.results.find((item) => !item.passed)?.reason ?? 'the condition was not met');

      results.push({
        name: check.name,
        passed: false,
        reason,
        tags: check.tags ?? [],
        durationMs: Date.now() - checkStarted,
        findings,
      });
    } catch (err) {
      results.push({
        name: check.name,
        passed: false,
        reason: err instanceof Error ? err.message : String(err),
        tags: check.tags ?? [],
        durationMs: Date.now() - checkStarted,
      });
    } finally {
      await context.close();
    }
  }

  return {
    name: suite.name,
    results,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Render a suite result.
 *
 * The failures come first. A reader who stops after the first screen
 * should have seen what broke.
 */
export function renderSuite(result: SuiteResult): string {
  const lines: string[] = [];

  const failures = result.results.filter((entry) => !entry.passed);
  if (failures.length > 0) {
    lines.push(`${failures.length} check(s) failed:`);
    lines.push('');
    for (const failure of failures) {
      lines.push(`  ✗ ${failure.name}`);
      lines.push(`      ${failure.reason ?? 'the check failed'}`);
    }
    lines.push('');
  }

  const passes = result.results.filter((entry) => entry.passed);
  if (passes.length > 0) {
    lines.push(`${passes.length} check(s) passed.`);
  }

  lines.push(
    `${result.passed}/${result.results.length} passed in ${(result.durationMs / 1000).toFixed(1)}s.`,
  );

  return lines.join('\n');
}

/**
 * Parse a suite file.
 *
 * The format is JSON, so a suite can be generated by another tool.
 */
export function parseSuite(raw: unknown): TestSuite {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('the suite file must be an object');
  }

  const record = raw as Record<string, unknown>;
  const name = record['name'];
  const checks = record['checks'];

  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('the suite file needs a "name"');
  }
  if (!Array.isArray(checks)) {
    throw new Error('the suite file needs a "checks" list');
  }

  const parsed = checks.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`check ${index + 1} is not an object`);
    }
    const check = entry as Record<string, unknown>;
    const checkName = check['name'];
    const url = check['url'];
    const expect = check['expect'];

    if (typeof checkName !== 'string' || checkName.length === 0) {
      throw new Error(`check ${index + 1} needs a "name"`);
    }
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error(`check "${checkName}" needs a "url"`);
    }
    if (typeof expect !== 'object' || expect === null) {
      throw new Error(`check "${checkName}" needs an "expect" condition`);
    }

    return {
      name: checkName,
      url,
      expect: expect as Condition,
      ...(check['allowConsoleErrors'] === true ? { allowConsoleErrors: true } : {}),
      ...(Array.isArray(check['tags'])
        ? { tags: check['tags'].filter((tag): tag is string => typeof tag === 'string') }
        : {}),
    };
  });

  return { name, checks: parsed };
}
