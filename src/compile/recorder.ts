/**
 * The recorder (M15).
 *
 * The recorder watches what the agent does and writes it down as IR steps.
 *
 * It records **what the agent chose**, not what the page happened to
 * contain: the winning locator strategy and the fallbacks that were tried.
 * That is what makes healing possible — when the best locator breaks, the
 * recorded fallbacks are the alternatives.
 */
import type { Page } from 'playwright';
import {
  countAssertion,
  textAssertion,
  urlAssertion,
  type InferredAssertion,
  type LocatorCandidate,
  type RecordedRun,
  type RecordedStep,
  type StepKind,
  type StepPost,
  type StepPre,
} from './ir.js';

/** What the agent tried to do. */
export interface RecordInput {
  /** What the step does. */
  kind: StepKind;
  /** The candidates that were tried, in order. */
  locators: LocatorCandidate[];
  /** Which candidate worked. */
  winningStrategy?: string;
  /** The value, when the step had one. */
  value?: string;
  /** The file, for an upload. */
  file?: string;
  /** The key, for a press. */
  key?: string;
  /** The option, for a select. */
  option?: string;
  /** The wait condition, for a wait step. */
  condition?: string;
  /** The scroll amount, for a scroll step. */
  amount?: number;
  /** The state before the step. */
  pre: StepPre;
  /** The state after the step. */
  post: StepPost;
  /** How long the step took. */
  durationMs: number;
}

/**
 * The recorder.
 *
 * Holds the steps of one run.
 */
export class Recorder {
  private steps: RecordedStep[] = [];
  private readonly startedAt = new Date().toISOString();

  constructor(private readonly runId: string) {}

  /**
   * Record a successful action.
   *
   * The winning candidate is moved to the front of the list, so the
   * compiled script tries the best locator first and the rest are
   * fallbacks.
   */
  record(input: RecordInput): RecordedStep {
    const locators = orderLocators(input.locators, input.winningStrategy);

    const assertions: InferredAssertion[] = [];
    const urlChange = urlAssertion(input.pre, input.post);
    if (urlChange !== undefined) assertions.push(urlChange);
    const textAdded = textAssertion(input.post);
    if (textAdded !== undefined) assertions.push(textAdded);
    const countChange = countAssertion(input.pre, input.post);
    if (countChange !== undefined) assertions.push(countChange);
    if (input.post.dialog !== undefined) {
      assertions.push({
        kind: 'dialog_appeared',
        description: `a ${input.post.dialog.type} dialog appears: ${input.post.dialog.message}`,
        value: input.post.dialog.message,
      });
    }
    if (input.post.popup !== undefined) {
      assertions.push({
        kind: 'popup_appeared',
        description: `a popup opens at ${input.post.popup.url}`,
        value: input.post.popup.url,
      });
    }

    const step: RecordedStep = {
      index: this.steps.length + 1,
      kind: input.kind,
      locators,
      params: {
        ...(input.value !== undefined ? { value: input.value } : {}),
        ...(input.file !== undefined ? { file: input.file } : {}),
        ...(input.key !== undefined ? { key: input.key } : {}),
        ...(input.option !== undefined ? { option: input.option } : {}),
        ...(input.condition !== undefined ? { condition: input.condition } : {}),
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
      },
      pre: input.pre,
      post: input.post,
      assertions,
      durationMs: input.durationMs,
      at: new Date().toISOString(),
    };

    this.steps.push(step);
    return step;
  }

  /** The steps recorded so far. */
  get recorded(): readonly RecordedStep[] {
    return this.steps;
  }

  /** How many steps have been recorded. */
  get count(): number {
    return this.steps.length;
  }

  /** Finish the recording and return the run. */
  finish(goal?: string): RecordedRun {
    return {
      runId: this.runId,
      ...(goal !== undefined ? { goal } : {}),
      steps: this.steps,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}

/**
 * Order the locator candidates so the winning one comes first.
 *
 * The rest keep their original order, which is the order they were tried.
 */
export function orderLocators(
  locators: readonly LocatorCandidate[],
  winningStrategy: string | undefined,
): LocatorCandidate[] {
  if (winningStrategy === undefined) return [...locators];
  const winner = locators.find((candidate) => candidate.strategy === winningStrategy);
  if (winner === undefined) return [...locators];
  return [winner, ...locators.filter((candidate) => candidate !== winner)];
}

/**
 * The locator candidates for a target descriptor.
 *
 * The order is the chain order: ref, role+name, label, text, test id, CSS.
 */
export function candidatesFor(target: {
  ref?: string;
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  testId?: string;
  css?: string;
}): LocatorCandidate[] {
  const candidates: LocatorCandidate[] = [];

  if (target.ref !== undefined) {
    candidates.push({ strategy: 'ref', value: target.ref });
  }
  if (target.role !== undefined && target.name !== undefined) {
    candidates.push({
      strategy: 'role',
      value: `role=${target.role} name="${target.name}"`,
      role: target.role,
      name: target.name,
    });
  }
  if (target.label !== undefined) {
    candidates.push({ strategy: 'label', value: `label="${target.label}"`, label: target.label });
  }
  if (target.text !== undefined) {
    candidates.push({ strategy: 'text', value: `text="${target.text}"`, text: target.text });
  }
  if (target.testId !== undefined) {
    candidates.push({
      strategy: 'testid',
      value: `testid=${target.testId}`,
      testId: target.testId,
    });
  }
  if (target.css !== undefined) {
    candidates.push({ strategy: 'css', value: target.css, css: target.css });
  }

  return candidates;
}

/**
 * Read the visible text of a page, truncated.
 *
 * Used to compare the page before and after a step.
 */
export async function readPageText(page: Page, limit = 2_000): Promise<string> {
  const text = await page
    .locator('body')
    .innerText({ timeout: 2_000 })
    .catch(() => '');
  return text.slice(0, limit);
}

/**
 * Compare the text before and after a step.
 *
 * The result is what the assertions are inferred from.
 */
export function diffText(before: string, after: string): {
  added: string[];
  removed: string[];
} {
  const beforeLines = new Set(before.split('\n').map((line) => line.trim()));
  const afterLines = new Set(after.split('\n').map((line) => line.trim()));

  const added: string[] = [];
  for (const line of afterLines) {
    if (line.length > 0 && !beforeLines.has(line)) added.push(line);
  }

  const removed: string[] = [];
  for (const line of beforeLines) {
    if (line.length > 0 && !afterLines.has(line)) removed.push(line);
  }

  return { added: added.slice(0, 20), removed: removed.slice(0, 20) };
}
