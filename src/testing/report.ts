/**
 * The bug reporter (M24).
 *
 * Turns what a run found into something you can hand to someone: a
 * Markdown report, or a JSON file a tracker can ingest.
 *
 * A report says what was observed, where, and how to reproduce it. It does
 * not say what the cause is — that is a guess, and a guess in a bug report
 * sends the reader down the wrong path.
 */
import type { PageFindings, ViewportResult } from './qa.js';
import { errorCount, renderFindings } from './qa.js';

/** One bug the reporter found. */
export interface BugReport {
  /** A short id, derived from the hash of the details. */
  id: string;
  /** What kind of problem it is. */
  kind: 'console-error' | 'page-error' | 'network-failure' | 'overflow' | 'a11y';
  /** A one-line summary. */
  summary: string;
  /** Where it happened. */
  url: string;
  /** The evidence: the message, the selector, whatever applies. */
  detail: string;
  /** How serious it is. */
  severity: 'critical' | 'major' | 'minor';
  /** How to reproduce it. */
  reproduce: string[];
}

/**
 * Build the bug reports from a set of findings.
 *
 * Each finding becomes one report, so a single run can produce several.
 */
export function buildReports(
  findings: PageFindings,
  options: { viewport?: ViewportResult; reproSteps?: string[] } = {},
): BugReport[] {
  const reports: BugReport[] = [];
  const repro = options.reproSteps ?? ['navigate to the url', 'observe the page'];

  for (const error of findings.pageErrors) {
    reports.push({
      id: '',
      kind: 'page-error',
      summary: `uncaught error: ${firstLine(error)}`,
      url: findings.url,
      detail: error,
      severity: 'critical',
      reproduce: [...repro],
    });
  }

  for (const message of findings.console.filter((entry) => entry.type === 'error')) {
    reports.push({
      id: '',
      kind: 'console-error',
      summary: `console error: ${firstLine(message.text)}`,
      url: findings.url,
      detail:
        message.location !== undefined
          ? `${message.text}\n  at ${message.location.url}:${message.location.line}:${message.location.column}`
          : message.text,
      severity: 'major',
      reproduce: [...repro],
    });
  }

  for (const failure of findings.networkFailures) {
    reports.push({
      id: '',
      kind: 'network-failure',
      summary: `request failed: ${failure.method} ${failure.url}`,
      url: findings.url,
      detail: `${failure.error} (${failure.resourceType})`,
      severity: 'major',
      reproduce: [...repro],
    });
  }

  if (options.viewport !== undefined && options.viewport.horizontalOverflow > 0) {
    reports.push({
      id: '',
      kind: 'overflow',
      summary: `${options.viewport.horizontalOverflow} element(s) overflow the ${options.viewport.width}px viewport`,
      url: findings.url,
      detail: options.viewport.overflowSelector ?? '(the overflowing element was not identified)',
      severity: 'minor',
      reproduce: [...repro, `resize to ${options.viewport.width}x${options.viewport.height}`],
    });
  }

  // The id is derived from the report's own details, so the same problem
  // gets the same id across runs. That is what makes it trackable.
  return reports.map((report) => ({
    ...report,
    id: `bug-${hash(`${report.kind}|${report.url}|${report.detail}`).slice(0, 8)}`,
  }));
}

/**
 * Render the reports as Markdown.
 */
export function renderReports(reports: readonly BugReport[]): string {
  if (reports.length === 0) {
    return '# No problems found\n\nThe run found nothing to report.';
  }

  const lines: string[] = [];
  lines.push('# Problems found');
  lines.push('');
  lines.push(`${reports.length} problem(s).`);
  lines.push('');

  const bySeverity = [...reports].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  for (const report of bySeverity) {
    lines.push(`## ${report.summary}`);
    lines.push('');
    lines.push(`- **id**: ${report.id}`);
    lines.push(`- **kind**: ${report.kind}`);
    lines.push(`- **severity**: ${report.severity}`);
    lines.push(`- **url**: ${report.url}`);
    lines.push('');
    lines.push('### Detail');
    lines.push('');
    lines.push('```');
    lines.push(report.detail);
    lines.push('```');
    lines.push('');
    lines.push('### How to reproduce');
    lines.push('');
    for (const step of report.reproduce) lines.push(`1. ${step}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Render the reports as JSON, for a tracker.
 */
export function renderReportsJson(reports: readonly BugReport[]): string {
  return JSON.stringify({ reports, count: reports.length }, null, 2);
}

/**
 * Render the findings themselves, alongside the reports.
 */
export function renderFullReport(
  findings: PageFindings,
  reports: readonly BugReport[],
): string {
  return `${renderFindings(findings)}\n\n---\n\n${renderReports(reports)}`;
}

/**
 * The severity order, most serious first.
 */
function severityRank(severity: BugReport['severity']): number {
  switch (severity) {
    case 'critical':
      return 0;
    case 'major':
      return 1;
    case 'minor':
      return 2;
    default:
      return 3;
  }
}

/**
 * The first line of a message.
 */
function firstLine(text: string): string {
  const index = text.indexOf('\n');
  const line = index === -1 ? text : text.slice(0, index);
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/**
 * A short hash of a string.
 */
function hash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h << 5) - h + text.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(16).padStart(8, '0');
}

/**
 * The total number of errors in the findings.
 */
export function totalErrors(findings: PageFindings): number {
  return errorCount(findings);
}

/**
 * Whether the findings are worth reporting.
 */
export function worthReporting(findings: PageFindings): boolean {
  return errorCount(findings) > 0;
}

/**
 * The page's title, for the report.
 */
export async function readTitle(page: {
  title(): Promise<string>;
}): Promise<string> {
  try {
    return await page.title();
  } catch {
    return '(the title could not be read)';
  }
}
