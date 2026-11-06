/**
 * Evidence collection and storage (M12).
 *
 * Evidence is the proof that a run did what it claims. Every run ends with
 * a verification, and every verification produces:
 *
 *   - a final screenshot,
 *   - a final snapshot,
 *   - the result of each condition,
 *   - the network facts the verification used.
 *
 * These are written to the run directory so they can be checked later
 * without re-running anything.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { Evidence, VerificationResult } from './verifier.js';

/** The evidence artifacts for a run. */
export interface EvidenceBundle {
  /** The verification result. */
  verification: VerificationResult;
  /** The path of the final screenshot. */
  screenshotPath?: string;
  /** The path of the final snapshot. */
  snapshotPath?: string;
  /** The network facts the verification used. */
  network: unknown[];
  /** The path of the written evidence file. */
  path: string;
}

/**
 * Collect the evidence for a finished run.
 *
 * The screenshot and the snapshot are captured now, at the end, so they
 * show the state the verification was run against.
 */
export async function collectEvidence(options: {
  page: Page;
  runDir: string;
  verification: VerificationResult;
  network?: unknown[];
  ariaSnapshot?: string;
}): Promise<EvidenceBundle> {
  await mkdir(options.runDir, { recursive: true });

  const screenshotPath = join(options.runDir, 'final.png');
  const snapshotPath = join(options.runDir, 'final-aria.txt');

  let capturedScreenshot: string | undefined;
  try {
    await options.page.screenshot({ path: screenshotPath, fullPage: false });
    capturedScreenshot = screenshotPath;
  } catch {
    // A screenshot can fail if the page closed. The verification itself
    // still stands, so this is not fatal.
    capturedScreenshot = undefined;
  }

  let capturedSnapshot: string | undefined;
  if (options.ariaSnapshot !== undefined) {
    await writeFile(snapshotPath, options.ariaSnapshot, 'utf8');
    capturedSnapshot = snapshotPath;
  }

  const network = options.network ?? [];
  const evidencePath = join(options.runDir, 'evidence.json');
  await writeFile(
    evidencePath,
    JSON.stringify(
      {
        verification: options.verification,
        network,
        capturedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );

  return {
    verification: options.verification,
    ...(capturedScreenshot !== undefined ? { screenshotPath: capturedScreenshot } : {}),
    ...(capturedSnapshot !== undefined ? { snapshotPath: capturedSnapshot } : {}),
    network,
    path: evidencePath,
  };
}

/**
 * Check that every piece of evidence in a result is usable.
 *
 * Used by the tests to make sure the evidence is not decorative.
 */
export function evidenceIsComplete(evidence: readonly Evidence[]): boolean {
  if (evidence.length === 0) return false;
  return evidence.every(
    (item) =>
      item.kind.length > 0 &&
      item.url.length > 0 &&
      item.capturedAt.length > 0 &&
      item.value !== undefined,
  );
}

/**
 * Summarise a verification for a human.
 */
export function summarizeVerification(result: VerificationResult): string {
  const lines: string[] = [];

  if (result.passed) {
    lines.push('VERIFIED: every condition passed.');
  } else {
    lines.push('UNVERIFIED: at least one condition did not pass.');
  }

  for (const item of result.results) {
    lines.push(`  ${item.passed ? 'pass' : 'FAIL'}  ${describeCondition(item.condition)}  — ${item.reason}`);
  }

  return lines.join('\n');
}

/**
 * Render an unknown value as text.
 *
 * A plain string is used as-is; anything else is JSON, so an object never
 * becomes `[object Object]`.
 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return '(unserialisable)';
  }
}

/** Describe a condition in one line. */
export function describeCondition(condition: unknown): string {
  if (typeof condition !== 'object' || condition === null) return String(condition);
  const record = condition as Record<string, unknown>;

  if ('all' in record) return `all(${JSON.stringify(record['all'])})`;
  if ('any' in record) return `any(${JSON.stringify(record['any'])})`;
  if ('not' in record) return `not(${JSON.stringify(record['not'])})`;

  switch (record['type']) {
    case 'url_matches':
      return `url matches ${String(record['pattern'])}`;
    case 'text_visible':
      return `text visible: ${String(record['text'])}`;
    case 'element': {
      const parts = [`element role=${asText(record['role'])}`];
      if (record['name'] !== undefined) parts.push(`name=${asText(record['name'])}`);
      if (record['min'] !== undefined) parts.push(`min=${asText(record['min'])}`);
      if (record['max'] !== undefined) parts.push(`max=${asText(record['max'])}`);
      return parts.join(' ');
    }
    case 'network_response':
      return `network ${String(record['urlPattern'])} → ${String(record['status'])}`;
    case 'storage':
      return `storage ${String(record['key'])} matches ${String(record['matches'])}`;
    case 'llm_judged':
      return `llm judged: ${String(record['claim'])}`;
    default:
      return JSON.stringify(record);
  }
}
