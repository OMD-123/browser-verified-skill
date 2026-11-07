/**
 * Accessibility checks (M19).
 *
 * axe-core, run in the page, with the results mapped to something a human
 * can act on.
 *
 * Two rules about what this does not do:
 *
 *  1. **It is not a certification.** An axe run finds some of the problems;
 *     it does not find all of them, and a clean run does not mean the page
 *     is accessible. The output says so.
 *  2. **It does not guess.** A violation is reported with the rule id, the
 *     nodes it applies to and the help text, so it can be looked up.
 */
import type { Page } from 'playwright';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** The axe-core source. */
const AXE_SOURCE: string = require.resolve('axe-core/axe.min.js');

/** The severity of a violation. */
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';

/** One node a violation applies to. */
export interface ViolationNode {
  /** The HTML of the element. */
  html: string;
  /** The CSS selector that finds it. */
  target: string;
  /** The failure explanation. */
  failureSummary?: string;
}

/** One accessibility violation. */
export interface Violation {
  /** The axe rule id. */
  id: string;
  /** The impact: how serious it is. */
  impact: Severity;
  /** What the problem is. */
  help: string;
  /** A longer explanation. */
  description: string;
  /** A URL with the documentation. */
  helpUrl: string;
  /** The elements it applies to. */
  nodes: ViolationNode[];
}

/** The result of an accessibility scan. */
export interface A11yResult {
  /** The URL that was scanned. */
  url: string;
  /** The violations, most serious first. */
  violations: Violation[];
  /** The number of violations. */
  violationCount: number;
  /** The rule ids that passed. */
  passes: string[];
  /** Whether the scan ran at all. */
  scanned: boolean;
  /** Why the scan did not run, when it did not. */
  reason?: string;
}

/**
 * Run axe-core on the page.
 *
 * The scan runs against the current DOM, so the page has to be in the state
 * you want checked.
 */
export async function scanA11y(
  page: Page,
  options: { include?: string[]; exclude?: string[]; rules?: string[] } = {},
): Promise<A11yResult> {
  const url = page.url();

  try {
    await page.addScriptTag({ path: AXE_SOURCE });
  } catch (err) {
    return {
      url,
      violations: [],
      violationCount: 0,
      passes: [],
      scanned: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // axe takes the selectors as nested arrays: `[['img']]`, not `['img']`.
  // A flat string is read as a rule name, which silently excludes nothing.
  //
  // The selectors also go in the **context** argument, not the options:
  // axe's `exclude` in the options is ignored.
  const context: { include?: string[][]; exclude?: string[][] } = {
    ...(options.include !== undefined ? { include: options.include.map((s) => [s]) } : {}),
    ...(options.exclude !== undefined ? { exclude: options.exclude.map((s) => [s]) } : {}),
  };

  // axe rejects an empty context object, so the document is used when
  // there is nothing to include or exclude.
  const hasContext = context.include !== undefined || context.exclude !== undefined;

  const config: { runOnly?: { type: 'rule'; values: string[] } } =
    options.rules !== undefined
      ? { runOnly: { type: 'rule' as const, values: options.rules } }
      : {};

  const raw = await page.evaluate(
    async (payload: { context: unknown; config: unknown; hasContext: boolean }) => {
      // axe's own types are `any[]`, so the call is made through a typed
      // shim rather than through the loose declaration.
      const axe = (
        window as unknown as {
          axe: { run: (context: unknown, config: unknown) => Promise<unknown> };
        }
      ).axe;
      const context = payload.hasContext ? payload.context : document;
      const result = (await axe.run(context, payload.config)) as {
        violations: unknown[];
        passes: { id: string }[];
      };
      return { violations: result.violations, passes: result.passes };
    },
    { context, config, hasContext },
  );

  const violations = raw.violations
    .map((entry) => mapViolation(entry))
    .filter((violation): violation is Violation => violation !== undefined)
    .sort(bySeverity);

  return {
    url,
    violations,
    violationCount: violations.length,
    passes: raw.passes.map((pass) => pass.id),
    scanned: true,
  };
}

/** Map one raw axe violation. */
function mapViolation(entry: unknown): Violation | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const record = entry as Record<string, unknown>;

  const id = record['id'];
  if (typeof id !== 'string') return undefined;

  const rawNodes = Array.isArray(record['nodes']) ? record['nodes'] : [];
  const nodes: ViolationNode[] = rawNodes.map((rawNode) => {
    const node = rawNode as Record<string, unknown>;
    const rawTarget = node['target'];
    const target = Array.isArray(rawTarget)
      ? rawTarget.map((part) => String(part)).join(' ')
      : typeof rawTarget === 'string'
        ? rawTarget
        : '';
    const failureSummary = node['failureSummary'];

    return {
      html: typeof node['html'] === 'string' ? node['html'] : '',
      target,
      ...(typeof failureSummary === 'string' ? { failureSummary } : {}),
    };
  });

  return {
    id,
    impact: toSeverity(record['impact']),
    help: typeof record['help'] === 'string' ? record['help'] : '',
    description: typeof record['description'] === 'string' ? record['description'] : '',
    helpUrl: typeof record['helpUrl'] === 'string' ? record['helpUrl'] : '',
    nodes,
  };
}

/**
 * Map a raw impact to a known severity.
 *
 * An unknown impact is `minor`, because a violation with an impact this
 * tool does not recognise should not be treated as critical.
 */
function toSeverity(value: unknown): Severity {
  if (value === 'critical' || value === 'serious' || value === 'moderate' || value === 'minor') {
    return value;
  }
  return 'minor';
}

/** The severity order, most serious first. */
const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3,
};

/** Sort violations by severity. */
function bySeverity(a: Violation, b: Violation): number {
  const left = SEVERITY_ORDER[a.impact] ?? 4;
  const right = SEVERITY_ORDER[b.impact] ?? 4;
  return left - right;
}

/**
 * Render an accessibility result for a human.
 *
 * The caveat comes first: a clean run is not a certificate.
 */
export function renderA11y(result: A11yResult): string {
  if (!result.scanned) {
    return `The accessibility scan did not run: ${result.reason ?? 'unknown reason'}`;
  }

  const lines: string[] = [];
  lines.push(
    `Accessibility: ${result.violationCount} violation(s) on ${result.url}. ` +
      'This is not a certification; a clean scan does not mean the page is accessible.',
  );

  if (result.violationCount === 0) {
    lines.push('  No violations were found by the rules that ran.');
    return lines.join('\n');
  }

  for (const violation of result.violations) {
    lines.push(`  [${violation.impact}] ${violation.id}: ${violation.help}`);
    lines.push(`      ${violation.helpUrl}`);
    for (const node of violation.nodes.slice(0, 3)) {
      lines.push(`      ${node.target}`);
      if (node.failureSummary !== undefined) {
        for (const line of node.failureSummary.split('\n')) {
          lines.push(`        ${line}`);
        }
      }
    }
    if (violation.nodes.length > 3) {
      lines.push(`      ... and ${violation.nodes.length - 3} more node(s)`);
    }
  }

  return lines.join('\n');
}

/**
 * The severity of the worst violation.
 *
 * Used to fail a run on a serious problem and not on a minor one.
 */
export function worstSeverity(result: A11yResult): Severity | undefined {
  const first = result.violations[0];
  if (first === undefined) return undefined;
  if (
    first.impact === 'critical' ||
    first.impact === 'serious' ||
    first.impact === 'moderate' ||
    first.impact === 'minor'
  ) {
    return first.impact;
  }
  return undefined;
}

/**
 * Whether a scan should fail the run.
 *
 * Only a critical or serious violation fails it. A moderate or minor one
 * is reported and left to the operator's judgement — failing the run on
 * a minor issue trains people to ignore the output.
 */
export function shouldFail(result: A11yResult): boolean {
  const severity = worstSeverity(result);
  return severity === 'critical' || severity === 'serious';
}
