/**
 * The recorded-step IR (M15).
 *
 * Every successful action is stored as a normalised IR step. The IR is what
 * the compiler turns into a Playwright script and what the healer repairs,
 * so it is deliberately independent of Playwright's own types: the same
 * steps can be replayed, inspected or diffed without a browser.
 */

/** The kinds of step the recorder produces. */
export type StepKind =
  | 'goto'
  | 'click'
  | 'dblclick'
  | 'hover'
  | 'fill'
  | 'type'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'press'
  | 'scroll'
  | 'upload'
  | 'wait';

/** One candidate way to find an element. */
export interface LocatorCandidate {
  /** The strategy. */
  strategy: 'ref' | 'role' | 'label' | 'text' | 'testid' | 'css';
  /** The selector for that strategy. */
  value: string;
  /** The role, when the strategy is `role`. */
  role?: string;
  /** The accessible name, when the strategy is `role`. */
  name?: string;
  /** The label, when the strategy is `label`. */
  label?: string;
  /** The text, when the strategy is `text`. */
  text?: string;
  /** The test id, when the strategy is `testid`. */
  testId?: string;
  /** The CSS selector, when the strategy is `css`. */
  css?: string;
}

/** The state before a step. */
export interface StepPre {
  /** The URL. */
  url: string;
  /** The visible text of the page, truncated. */
  text?: string;
  /** The number of elements matching the target. */
  matchCount?: number;
}

/** The state after a step. */
export interface StepPost {
  /** The URL. */
  url: string;
  /** The visible text of the page, truncated. */
  text?: string;
  /** The number of elements matching the target. */
  matchCount?: number;
  /** The text that appeared after the step. */
  addedText?: string[];
  /** The text that disappeared after the step. */
  removedText?: string[];
  /** A dialog appeared. */
  dialog?: { type: string; message: string };
  /** A new tab or popup appeared. */
  popup?: { url: string; title: string };
}

/** An assertion the compiler inferred from what was observed. */
export interface InferredAssertion {
  /** The kind of assertion. */
  kind: 'url_changed' | 'text_added' | 'count_changed' | 'dialog_appeared' | 'popup_appeared';
  /** A human-readable description. */
  description: string;
  /** The value the assertion checks. */
  value?: string;
  /** The number of elements, for a count assertion. */
  count?: number;
}

/** One recorded step. */
export interface RecordedStep {
  /** The step number, starting at 1. */
  index: number;
  /** What the step does. */
  kind: StepKind;
  /** The candidates for finding the target, best first. */
  locators: LocatorCandidate[];
  /** The parameters, with variable slots for the values. */
  params: {
    /** The value to fill, type, select or press. */
    value?: string;
    /** The file path to upload. */
    file?: string;
    /** The key to press. */
    key?: string;
    /** The option to select. */
    option?: string;
    /** The wait condition, for a `wait` step. */
    condition?: string;
    /** The amount to scroll, for a `scroll` step. */
    amount?: number;
  };
  /** The state before the step. */
  pre: StepPre;
  /** The state after the step. */
  post: StepPost;
  /** The assertions that were inferred. */
  assertions: InferredAssertion[];
  /** How long the step took, in milliseconds. */
  durationMs: number;
  /** When the step ran. */
  at: string;
}

/** A whole recorded run. */
export interface RecordedRun {
  /** The run id. */
  runId: string;
  /** The goal, when the run had one. */
  goal?: string;
  /** The steps. */
  steps: RecordedStep[];
  /** When the recording started. */
  startedAt: string;
  /** When the recording finished. */
  finishedAt: string;
}

/**
 * A variable in a compiled flow.
 *
 * `{{name}}` in a step's value becomes a parameter of the compiled script.
 */
export interface FlowVariable {
  /** The variable's name. */
  name: string;
  /** The value it was recorded with. */
  defaultValue: string;
  /** The step that uses it. */
  stepIndex: number;
}

/**
 * A compiled flow.
 *
 * This is the intermediate form between the IR and the Playwright script.
 */
export interface CompiledFlow {
  /** The flow's name. */
  name: string;
  /** The steps, in order. */
  steps: RecordedStep[];
  /** The variables the flow takes. */
  variables: FlowVariable[];
  /** The goal, when the run had one. */
  goal?: string;
}

/**
 * Find the variables in a recorded run.
 *
 * A value that appears in more than one step is likely a parameter — the
 * same email typed into two forms, for example. A value that appears once
 * is usually literal.
 */
export function findVariables(run: RecordedRun, minimumUses = 2): FlowVariable[] {
  const uses = new Map<string, { count: number; firstStep: number }>();

  for (const step of run.steps) {
    const value = step.params.value;
    if (value === undefined || value.length === 0) continue;
    const existing = uses.get(value);
    if (existing === undefined) {
      uses.set(value, { count: 1, firstStep: step.index });
    } else {
      existing.count += 1;
    }
  }

  const variables: FlowVariable[] = [];
  let counter = 0;
  for (const [value, info] of uses) {
    if (info.count < minimumUses) continue;
    counter += 1;
    variables.push({
      name: `var${counter}`,
      defaultValue: value,
      stepIndex: info.firstStep,
    });
  }
  return variables;
}

/**
 * Replace a step's literal values with variable slots.
 *
 * The result is a step whose `params.value` reads `{{var1}}`.
 */
export function applyVariables(
  steps: readonly RecordedStep[],
  variables: readonly FlowVariable[],
): RecordedStep[] {
  return steps.map((step) => {
    const value = step.params.value;
    if (value === undefined) return step;

    const match = variables.find((variable) => variable.defaultValue === value);
    if (match === undefined) return step;

    return {
      ...step,
      params: { ...step.params, value: `{{${match.name}}}` },
    };
  });
}

/**
 * The assertion that a step changed the URL.
 *
 * The URL is only asserted when it changed and the new URL is stable — a
 * URL with a timestamp or a request id in it is volatile and is not
 * asserted.
 */
export function urlAssertion(pre: StepPre, post: StepPost): InferredAssertion | undefined {
  if (pre.url === post.url) return undefined;
  if (isVolatile(post.url)) return undefined;
  return {
    kind: 'url_changed',
    description: `the url changes to ${post.url}`,
    value: post.url,
  };
}

/**
 * The assertion that some text appeared.
 *
 * Short-lived text — a timestamp, a spinner, a random id — is not asserted,
 * because asserting it would make the compiled script fail the next time it
 * runs.
 */
export function textAssertion(post: StepPost): InferredAssertion | undefined {
  const added = post.addedText ?? [];
  const stable = added.filter((text) => !isVolatile(text));
  const first = stable[0];
  if (first === undefined) return undefined;
  return {
    kind: 'text_added',
    description: `the text "${first}" appears`,
    value: first,
  };
}

/**
 * The assertion that a count changed.
 *
 * Only a count that is stable is asserted. A count that is zero before and
 * after is not a change.
 */
export function countAssertion(
  pre: StepPre,
  post: StepPost,
): InferredAssertion | undefined {
  if (pre.matchCount === undefined || post.matchCount === undefined) return undefined;
  if (pre.matchCount === post.matchCount) return undefined;
  return {
    kind: 'count_changed',
    description: `the number of matching elements changes from ${pre.matchCount} to ${post.matchCount}`,
    count: post.matchCount,
  };
}

/**
 * True when a value looks volatile.
 *
 * A timestamp, a UUID, a request id or a long random-looking token. These
 * are never asserted, because they change on every run.
 */
export function isVolatile(value: string): boolean {
  if (value.length === 0) return false;

  // A UUID.
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(value)) return true;

  // A long run of hex characters.
  if (/[0-9a-f]{16,}/i.test(value)) return true;

  // An ISO timestamp.
  if (/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return true;

  // A Unix timestamp in seconds, as 10 digits.
  if (/\b1[6-9]\d{8}\b/.test(value)) return true;

  // A word that says it is a timestamp or an id.
  if (/\b(timestamp|generated at|request id|order id|session id|nonce)\b/i.test(value)) {
    return true;
  }

  // A number that looks like a time.
  if (/\b\d{1,2}:\d{2}(:\d{2})?\b/.test(value)) return true;

  return false;
}
