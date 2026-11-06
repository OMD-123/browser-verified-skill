/**
 * Verification and evidence (M12).
 *
 * A run is not "done" until it has been verified. The verifier evaluates a
 * success condition against the live page and produces **evidence** — the
 * facts that support each verdict, not a narrative.
 *
 * The verifier is independent of the executor: it reads the condition and
 * the live page, and nothing else. It never sees what the executor thought
 * it was doing.
 */
import type { Page } from 'playwright';
import type { Condition } from '../safety/planlock.js';

/** The result of checking one condition. */
export interface ConditionResult {
  /** The condition that was checked. */
  condition: Condition;
  /** Whether it passed. */
  passed: boolean;
  /** Why it passed or failed. */
  reason: string;
  /** The evidence that supports the verdict. */
  evidence: Evidence;
}

/** A piece of evidence for a verdict. */
export interface Evidence {
  /** The kind of evidence. */
  kind: 'url' | 'text' | 'element' | 'network' | 'storage' | 'screenshot' | 'snapshot';
  /** The fact itself. */
  value: unknown;
  /** Where it came from. */
  url: string;
  /** When it was captured. */
  capturedAt: string;
  /** The element it came from, when it came from one. */
  domPath?: string;
  /** The text around it, when it came from a node. */
  textSnippet?: string;
  /** The screenshot it came from, when there is one. */
  screenshotPath?: string;
}

/** The result of verifying a whole condition tree. */
export interface VerificationResult {
  /** Whether every condition passed. */
  passed: boolean;
  /** The result of each top-level condition. */
  results: ConditionResult[];
  /** The evidence gathered. */
  evidence: Evidence[];
  /** When the verification ran. */
  verifiedAt: string;
  /** The URL the verification ran against. */
  url: string;
}

/** What the verifier needs from the page. */
export interface VerificationContext {
  /** The live page. */
  page: Page;
  /** The network responses seen during the run. */
  network?: NetworkFact[];
  /** The storage state to read from. */
  storage?: Record<string, string>;
  /** The path of the final screenshot, when there is one. */
  screenshotPath?: string;
  /** The path of the final snapshot, when there is one. */
  snapshotPath?: string;
}

/** A network response seen during the run. */
export interface NetworkFact {
  /** The URL. */
  url: string;
  /** The status code. */
  status: number;
  /** When it happened. */
  at: string;
}

/** The maximum number of elements to count for an `element` condition. */
const MAX_COUNT = 1000;

/**
 * Verify a condition tree against the live page.
 *
 * Deterministic conditions are evaluated first. `llm_judged` conditions are
 * reported as unverified in Mode A, because Mode A has no model to judge
 * with; the run is then `unverified` rather than "done".
 */
export async function verify(
  condition: Condition,
  context: VerificationContext,
): Promise<VerificationResult> {
  const results: ConditionResult[] = [];
  const evidence: Evidence[] = [];

  await evaluateCondition(condition, context, results, evidence);

  // `passed` is the verdict of the **top-level** condition, not of every
  // result that was recorded. The results list contains the branches of a
  // composition too, and a failed branch of a passing `any` does not make
  // the whole condition fail.
  const topLevel = results[results.length - 1];
  return {
    passed: topLevel !== undefined && topLevel.passed,
    results,
    evidence,
    verifiedAt: new Date().toISOString(),
    url: context.page.url(),
  };
}

/** Evaluate a condition and record the result. */
async function evaluateCondition(
  condition: Condition,
  context: VerificationContext,
  results: ConditionResult[],
  evidence: Evidence[],
): Promise<void> {
  if ('all' in condition) {
    for (const child of condition.all) {
      await evaluateCondition(child, context, results, evidence);
    }
    return;
  }

  if ('any' in condition) {
    // `any` passes when at least one branch passes. The branches are all
    // evaluated so the evidence shows what was tried.
    const before = results.length;
    for (const child of condition.any) {
      await evaluateCondition(child, context, results, evidence);
    }
    const branchResults = results.slice(before);
    const anyPassed = branchResults.some((r) => r.passed);
    results.push({
      condition,
      passed: anyPassed,
      reason: anyPassed
        ? `${branchResults.filter((r) => r.passed).length} of ${branchResults.length} branches passed`
        : `none of the ${branchResults.length} branches passed`,
      evidence: {
        kind: 'snapshot',
        value: branchResults.map((r) => r.reason),
        url: context.page.url(),
        capturedAt: new Date().toISOString(),
      },
    });
    return;
  }

  if ('not' in condition) {
    const before = results.length;
    await evaluateCondition(condition.not, context, results, evidence);
    const inner = results[before];
    results.push({
      condition,
      passed: inner === undefined ? false : !inner.passed,
      reason: inner === undefined ? 'the inner condition was not evaluated' : `not (${inner.reason})`,
      evidence:
        inner?.evidence ??
        {
          kind: 'snapshot',
          value: null,
          url: context.page.url(),
          capturedAt: new Date().toISOString(),
        },
    });
    return;
  }

  const result = await evaluateLeaf(condition, context);
  results.push(result);
  evidence.push(result.evidence);
}

/** Evaluate one leaf condition. */
async function evaluateLeaf(
  condition: Exclude<Condition, { all: unknown } | { any: unknown } | { not: unknown }>,
  context: VerificationContext,
): Promise<ConditionResult> {
  const url = context.page.url();
  const capturedAt = new Date().toISOString();

  switch (condition.type) {
    case 'url_matches': {
      const matched = matchesPattern(url, condition.pattern);
      return {
        condition,
        passed: matched,
        reason: matched
          ? `the url matches ${condition.pattern}`
          : `the url "${url}" does not match ${condition.pattern}`,
        evidence: { kind: 'url', value: url, url, capturedAt },
      };
    }

    case 'text_visible': {
      const found = await findVisibleText(context.page, condition.text);
      return {
        condition,
        passed: found !== undefined,
        reason:
          found !== undefined
            ? `the text "${condition.text}" is visible`
            : `the text "${condition.text}" is not visible`,
        evidence: {
          kind: 'text',
          value: condition.text,
          url,
          capturedAt,
          ...(found?.domPath !== undefined ? { domPath: found.domPath } : {}),
          ...(found?.textSnippet !== undefined ? { textSnippet: found.textSnippet } : {}),
          ...(context.screenshotPath !== undefined
            ? { screenshotPath: context.screenshotPath }
            : {}),
        },
      };
    }

    case 'element': {
      const count = await countElements(context.page, condition);
      const min = condition.min ?? 1;
      const max = condition.max ?? Number.POSITIVE_INFINITY;
      const passed = count >= min && count <= max;
      return {
        condition,
        passed,
        reason: passed
          ? `found ${count} matching element(s), expected ${min}..${max === Number.POSITIVE_INFINITY ? '∞' : max}`
          : `found ${count} matching element(s), expected ${min}..${max === Number.POSITIVE_INFINITY ? '∞' : max}`,
        evidence: {
          kind: 'element',
          value: count,
          url,
          capturedAt,
          ...(context.screenshotPath !== undefined
            ? { screenshotPath: context.screenshotPath }
            : {}),
        },
      };
    }

    case 'network_response': {
      const matches = (context.network ?? []).filter(
        (fact) => matchesPattern(fact.url, condition.urlPattern) && fact.status === condition.status,
      );
      return {
        condition,
        passed: matches.length > 0,
        reason:
          matches.length > 0
            ? `found ${matches.length} matching response(s)`
            : `no response matching ${condition.urlPattern} with status ${condition.status}`,
        evidence: {
          kind: 'network',
          value: matches,
          url,
          capturedAt,
        },
      };
    }

    case 'storage': {
      const actual = context.storage?.[condition.key];
      const passed = actual !== undefined && matchesPattern(actual, condition.matches);
      return {
        condition,
        passed,
        reason: passed
          ? `storage "${condition.key}" matches`
          : `storage "${condition.key}" is ${actual === undefined ? 'not set' : `"${actual}"`}, which does not match ${condition.matches}`,
        evidence: {
          kind: 'storage',
          value: actual ?? null,
          url,
          capturedAt,
        },
      };
    }

    case 'llm_judged': {
      // Mode A has no model to judge with. The condition is reported as
      // unverified rather than passed or failed, so the run is honestly
      // `unverified`.
      return {
        condition,
        passed: false,
        reason:
          'this condition needs an LLM judgement, which Mode A does not have. The run is unverified.',
        evidence: {
          kind: 'snapshot',
          value: condition.claim,
          url,
          capturedAt,
          ...(context.snapshotPath !== undefined ? { snapshotPath: context.snapshotPath } : {}),
        },
      };
    }

    default: {
      // Exhaustiveness: every condition type is handled above.
      const exhaustive: never = condition;
      return {
        condition: exhaustive as Condition,
        passed: false,
        reason: `unknown condition type: ${JSON.stringify(exhaustive)}`,
        evidence: { kind: 'snapshot', value: null, url, capturedAt },
      };
    }
  }
}

/** Where a piece of text was found on the page. */
interface TextLocation {
  /** A CSS-ish path to the element. */
  domPath: string;
  /** The text around the match. */
  textSnippet: string;
}

/**
 * Find text that is visible on the page.
 *
 * "Visible" means it is in the rendered text of a visible element, so text
 * hidden with `display: none` does not count.
 */
async function findVisibleText(
  page: Page,
  text: string,
): Promise<TextLocation | undefined> {
  const locator = page.getByText(text, { exact: false }).first();

  // `count()` does not wait for the element, unlike `evaluate()`. Without
  // this the check blocks until the locator's timeout when the text is
  // absent, which is exactly the case a failing verification hits.
  const count = await locator.count().catch(() => 0);
  if (count === 0) return undefined;

  const result = await locator
    .evaluate((element: unknown) => {
      const el = element as HTMLElement;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const visible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0;
      return {
        visible,
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? '').trim().slice(0, 200),
      };
    })
    .catch(() => undefined);

  if (result === undefined || !result.visible) return undefined;
  return {
    domPath: result.tag,
    textSnippet: result.text,
  };
}

/** Count the elements matching an `element` condition. */
async function countElements(
  page: Page,
  condition: { role: string; name?: string | undefined },
): Promise<number> {
  const locator = page.getByRole(
    condition.role as Parameters<Page['getByRole']>[0],
    condition.name !== undefined ? { name: condition.name } : {},
  );
  const count = await locator.count().catch(() => 0);
  return Math.min(count, MAX_COUNT);
}

/**
 * Match a string against a pattern.
 *
 * The pattern may be a regular expression (when it is written as one) or a
 * plain substring. A plain substring is the common case and is what the
 * documentation shows.
 */
export function matchesPattern(value: string, pattern: string): boolean {
  // A pattern written as `/.../flags` is a regular expression.
  const regexMatch = /^\/(.*)\/([gimsu]*)$/.exec(pattern);
  if (regexMatch !== null) {
    try {
      return new RegExp(regexMatch[1] ?? '', regexMatch[2] ?? '').test(value);
    } catch {
      // An invalid regular expression falls back to a substring match
      // against the pattern's source, without the delimiters.
      return value.includes(regexMatch[1] ?? pattern);
    }
  }
  return value.includes(pattern);
}
