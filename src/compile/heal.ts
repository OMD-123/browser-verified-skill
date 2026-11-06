/**
 * The healer and the drift tracker (M15).
 *
 * When a compiled flow's locator breaks, the healer walks the recorded
 * fallback chain. If one of the fallbacks works, the step is repaired and
 * the change is recorded as **drift**: "Step 4: `#login` →
 * `button[name=signin]` (role/name unchanged)".
 *
 * The drift report is the important part. A script that silently changes
 * itself is a script nobody trusts; a script that changes itself *and says
 * so* is one a human can review.
 */
import type { Page } from 'playwright';
import type { LocatorCandidate, RecordedStep } from './ir.js';

/** One recorded change to a step. */
export interface DriftEntry {
  /** The step that changed. */
  stepIndex: number;
  /** The locator that was tried first. */
  from: string;
  /** The locator that worked. */
  to: string;
  /** What stayed the same. */
  unchanged: string;
  /** When the change was made. */
  at: string;
  /** Why the change was made. */
  reason: string;
}

/** The result of a healing attempt. */
export interface HealResult {
  /** Whether the step was repaired. */
  healed: boolean;
  /** The repaired step, when it was repaired. */
  step?: RecordedStep;
  /** The drift entry, when it was repaired. */
  drift?: DriftEntry;
  /** The strategies that were tried, in order. */
  attempted: string[];
  /** Why it could not be repaired. */
  reason?: string;
}

/** The drift log for one flow. */
export class DriftLog {
  private entries: DriftEntry[] = [];

  /** Record a change. */
  add(entry: DriftEntry): void {
    this.entries.push(entry);
  }

  /** Every recorded change. */
  get all(): readonly DriftEntry[] {
    return this.entries;
  }

  /** How many changes were recorded. */
  get size(): number {
    return this.entries.length;
  }

  /** The changes for one step. */
  forStep(stepIndex: number): DriftEntry[] {
    return this.entries.filter((entry) => entry.stepIndex === stepIndex);
  }

  /** Render the drift as a report. */
  render(): string {
    if (this.entries.length === 0) return 'No drift: every step still uses its original locator.';
    const lines = [
      `${this.entries.length} drift entr${this.entries.length === 1 ? 'y' : 'ies'}:`,
      '',
    ];
    for (const entry of this.entries) {
      lines.push(`  Step ${entry.stepIndex}: ${entry.from} → ${entry.to} (${entry.unchanged})`);
      lines.push(`      ${entry.reason}`);
    }
    return lines.join('\n');
  }
}

/**
 * Heal a step whose locator no longer works.
 *
 * The recorded candidates are tried in order. The first one that finds the
 * element wins; the step is updated to use it and the change is recorded.
 */
export async function healStep(
  page: Page,
  step: RecordedStep,
  driftLog: DriftLog,
): Promise<HealResult> {
  const attempted: string[] = [];

  for (const candidate of step.locators) {
    attempted.push(candidate.value);
    const locator = locatorFor(page, candidate);
    if (locator === undefined) continue;

    const count = await locator.count().catch(() => 0);
    if (count === 0) continue;

    // The original locator still works: nothing to heal.
    if (candidate === step.locators[0]) {
      return { healed: false, attempted, reason: 'the original locator still works' };
    }

    const original = step.locators[0];
    const from = original?.value ?? '(unknown)';
    const unchanged = describeUnchanged(original, candidate);

    const repaired: RecordedStep = {
      ...step,
      locators: [candidate, ...step.locators.filter((c) => c !== candidate)],
    };

    const drift: DriftEntry = {
      stepIndex: step.index,
      from,
      to: candidate.value,
      unchanged,
      at: new Date().toISOString(),
      reason: `the original locator no longer matched; ${candidate.value} did`,
    };
    driftLog.add(drift);

    return { healed: true, step: repaired, drift, attempted };
  }

  return {
    healed: false,
    attempted,
    reason: `no recorded locator matched: ${attempted.join(', ')}`,
  };
}

/**
 * Describe what stayed the same between two locators.
 *
 * When the role and name are unchanged, the change is a drift in the
 * implementation, not in what the element means — which is a much smaller
 * change than it looks.
 */
export function describeUnchanged(
  original: LocatorCandidate | undefined,
  replacement: LocatorCandidate,
): string {
  if (original === undefined) return 'no original locator';

  if (
    original.strategy === 'role' &&
    replacement.strategy === 'role' &&
    original.role === replacement.role &&
    original.name === replacement.name
  ) {
    return 'role/name unchanged';
  }

  if (original.strategy === 'role' && replacement.role !== undefined) {
    if (original.role === replacement.role) return 'role unchanged';
    if (original.name === replacement.name) return 'name unchanged';
  }

  if (original.strategy === 'testid' && replacement.testId === original.testId) {
    return 'test id unchanged';
  }

  if (original.strategy === 'label' && replacement.label === original.label) {
    return 'label unchanged';
  }

  if (original.strategy === 'text' && replacement.text === original.text) {
    return 'text unchanged';
  }

  return 'the element is the same, the way of finding it changed';
}

/**
 * Build a locator for a candidate.
 *
 * Returns undefined when the candidate cannot be turned into a locator.
 */
export function locatorFor(
  page: Page,
  candidate: LocatorCandidate,
): ReturnType<Page['locator']> | undefined {
  switch (candidate.strategy) {
    case 'ref':
      try {
        return page.getByRef(candidate.value);
      } catch {
        return undefined;
      }
    case 'role':
      if (candidate.role === undefined) return undefined;
      return page.getByRole(candidate.role as Parameters<Page['getByRole']>[0], {
        ...(candidate.name !== undefined ? { name: candidate.name } : {}),
      });
    case 'label':
      if (candidate.label === undefined) return undefined;
      return page.getByLabel(candidate.label);
    case 'text':
      if (candidate.text === undefined) return undefined;
      return page.getByText(candidate.text);
    case 'testid':
      if (candidate.testId === undefined) return undefined;
      return page.getByTestId(candidate.testId);
    case 'css':
      if (candidate.css === undefined) return undefined;
      return page.locator(candidate.css);
    default:
      return undefined;
  }
}
