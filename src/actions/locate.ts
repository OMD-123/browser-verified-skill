/**
 * The locator chain.
 *
 * Resolution order (fixed, and recorded on every action):
 *
 *   1. `ref`         — a ref from the latest snapshot (`e12`, `f2e3`)
 *   2. `role+name`   — `getByRole(role, { name })`
 *   3. `label`       — `getByLabel(text)`
 *   4. `text`        — `getByText(text)`
 *   5. `test-id`     — `getByTestId(id)`
 *   6. `css`         — `locator(css)` — last resort
 *   7. fresh lookup  — re-snapshot and search by the descriptor
 *
 * The chain tries each strategy **in turn and attempts the action**, because
 * a locator can resolve and still be unusable (covered, disabled, detached).
 * The strategy that worked is recorded, and drives healing and drift reporting.
 */
import type { Locator, Page } from 'playwright';

/** The strategy that located an element. */
export type LocatorStrategy =
  'ref' | 'role' | 'label' | 'text' | 'testid' | 'css' | 'fresh-snapshot';

/** A semantic description of what to act on. */
export interface TargetDescriptor {
  /** A ref from the latest snapshot. */
  ref?: string;
  /** The ARIA role, e.g. `button`. */
  role?: string;
  /** The accessible name. */
  name?: string;
  /** A label text. */
  label?: string;
  /** Visible text. */
  text?: string;
  /** A `data-testid` value. */
  testId?: string;
  /** A CSS selector. Last resort. */
  css?: string;
}

/** The result of resolving a target. */
export interface LocateResult {
  /** The resolved locator, when one strategy worked. */
  locator: Locator | undefined;
  /** The strategy that succeeded. */
  strategy: LocatorStrategy | undefined;
  /** Every strategy that was tried, in order. */
  attempted: LocatorStrategy[];
  /** Why each failed attempt failed. */
  failures: { strategy: LocatorStrategy; reason: string }[];
}

/** The kinds of action that can be performed. */
export type ActionKind =
  | 'click'
  | 'dblclick'
  | 'hover'
  | 'type'
  | 'fill'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'press'
  | 'scroll'
  | 'upload'
  | 'focus';

/** The action to perform. */
export interface ActionRequest {
  kind: ActionKind;
  target: TargetDescriptor;
  /** The value, for `type`, `fill`, `select`, `press`, `upload`. */
  value?: string;
  /** Whether to force the action past actionability checks. */
  force?: boolean;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * Parse a target string into a descriptor.
 *
 * The CLI accepts a compact string form so a host agent can write
 * `bv act click "Sign in"` or `bv act click role=button name="Sign in"`.
 *
 * Supported forms:
 *   `e12`                       → ref
 *   `role=button name=Sign in`  → role + name
 *   `label=Email`               → label
 *   `text=Submit`               → text
 *   `testid=submit`             → test id
 *   `css=#login`                → CSS
 *   `Sign in`                   → plain text (matched as text)
 */
export function parseTarget(input: string): TargetDescriptor {
  const trimmed = input.trim();
  if (trimmed.length === 0) return {};

  // A bare ref.
  if (/^(?:f\d+)?e\d+$/.test(trimmed)) {
    return { ref: trimmed };
  }

  // A bare CSS selector when it looks unmistakably like one.
  if (/^[#.[]/.test(trimmed)) {
    return { css: trimmed };
  }

  // Key=value pairs.
  const descriptor: TargetDescriptor = {};
  const pattern =
    /(role|name|label|text|testid|css)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g;
  let match: RegExpExecArray | null;
  let matched = false;
  while ((match = pattern.exec(trimmed)) !== null) {
    matched = true;
    const key = match[1] ?? '';
    const raw = match[2] ?? '';
    const value = unquote(raw);
    switch (key) {
      case 'role':
        descriptor.role = value;
        break;
      case 'name':
        descriptor.name = value;
        break;
      case 'label':
        descriptor.label = value;
        break;
      case 'text':
        descriptor.text = value;
        break;
      case 'testid':
        descriptor.testId = value;
        break;
      case 'css':
        descriptor.css = value;
        break;
      default:
        break;
    }
  }

  if (matched) return descriptor;

  // A bare string: treat it as visible text.
  return { text: trimmed };
}

/** Remove surrounding quotes and unescape. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).replace(/\\(.)/g, '$1');
    }
  }
  return value;
}

/** Build the ordered list of strategies for a descriptor. */
export function strategyOrder(target: TargetDescriptor): LocatorStrategy[] {
  const order: LocatorStrategy[] = [];
  if (target.ref !== undefined) order.push('ref');
  if (target.role !== undefined && target.name !== undefined) order.push('role');
  if (target.label !== undefined) order.push('label');
  if (target.text !== undefined) order.push('text');
  if (target.testId !== undefined) order.push('testid');
  if (target.css !== undefined) order.push('css');
  return order;
}

/** Build the locator for one strategy. */
export function locatorFor(
  page: Page,
  strategy: LocatorStrategy,
  target: TargetDescriptor,
): Locator | undefined {
  switch (strategy) {
    case 'ref':
      return target.ref !== undefined ? page.getByRef(target.ref) : undefined;
    case 'role':
      return target.role !== undefined && target.name !== undefined
        ? page.getByRole(target.role as Parameters<Page['getByRole']>[0], {
            name: target.name,
          })
        : undefined;
    case 'label':
      return target.label !== undefined ? page.getByLabel(target.label) : undefined;
    case 'text':
      return target.text !== undefined ? page.getByText(target.text) : undefined;
    case 'testid':
      return target.testId !== undefined ? page.getByTestId(target.testId) : undefined;
    case 'css':
      return target.css !== undefined ? page.locator(target.css) : undefined;
    case 'fresh-snapshot':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * How many elements a locator matches.
 *
 * Used to detect ambiguity: a locator that matches several elements is
 * ambiguous and the action is refused rather than guessing.
 */
export async function countMatches(locator: Locator): Promise<number> {
  return locator.count();
}

/**
 * Resolve a target to a locator, trying each strategy in order.
 *
 * A strategy "succeeds" when it matches **exactly one** element. When a
 * strategy matches several, it is recorded as ambiguous and the chain moves
 * on; the final attempt reports the ambiguity.
 */
export async function locate(
  page: Page,
  target: TargetDescriptor,
  options: { timeoutMs?: number } = {},
): Promise<LocateResult> {
  const attempted: LocatorStrategy[] = [];
  const failures: { strategy: LocatorStrategy; reason: string }[] = [];
  const timeout = options.timeoutMs ?? 10_000;

  for (const strategy of strategyOrder(target)) {
    const locator = locatorFor(page, strategy, target);
    if (locator === undefined) continue;
    attempted.push(strategy);

    try {
      // Wait for at least one match, then count.
      await locator.first().waitFor({ state: 'attached', timeout });
      const count = await locator.count();
      if (count === 1) {
        return { locator, strategy, attempted, failures };
      }
      if (count === 0) {
        failures.push({ strategy, reason: 'no element matched' });
      } else {
        failures.push({ strategy, reason: `matched ${count} elements (ambiguous)` });
      }
    } catch (err) {
      const message =
        err instanceof Error ? (err.message.split('\n')[0] ?? 'unknown error') : String(err);
      failures.push({ strategy, reason: message });
    }
  }

  return { locator: undefined, strategy: undefined, attempted, failures };
}
