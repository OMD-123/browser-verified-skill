/**
 * Condition-based waits.
 *
 * There are no fixed sleeps in this codebase. Every wait is expressed as a
 * condition on the element, and the only fixed delay anywhere is the
 * rate-limit jitter in `interaction/throttle.ts`, which is politeness rather
 * than synchronisation (see DECISIONS D-0010).
 */
import type { Locator } from 'playwright';

/** The conditions that can be awaited. */
export type WaitCondition =
  | 'attached'
  | 'detached'
  | 'visible'
  | 'hidden'
  | 'stable'
  | 'enabled'
  | 'disabled'
  | 'checked'
  | 'receives-events';

/** The result of a wait. */
export interface WaitResult {
  /** True when the condition was met. */
  satisfied: boolean;
  /** The condition that was awaited. */
  condition: WaitCondition;
  /** How long the wait took, in milliseconds. */
  durationMs: number;
  /** Why the wait failed, when it did. */
  reason?: string;
}

/**
 * Wait for a condition on a locator.
 *
 * `stable` means the element's bounding box did not change across two
 * consecutive animation frames — the correct way to wait for a moving
 * element to settle, and the reason a sticky-header-covered button can be
 * clicked reliably.
 */
export async function waitForCondition(
  locator: Locator,
  condition: WaitCondition,
  options: { timeoutMs?: number } = {},
): Promise<WaitResult> {
  const timeout = options.timeoutMs ?? 10_000;
  const started = Date.now();

  try {
    switch (condition) {
      case 'attached':
        await locator.waitFor({ state: 'attached', timeout });
        break;
      case 'detached':
        await locator.waitFor({ state: 'detached', timeout });
        break;
      case 'visible':
        await locator.waitFor({ state: 'visible', timeout });
        break;
      case 'hidden':
        await locator.waitFor({ state: 'hidden', timeout });
        break;
      case 'stable':
        await waitForStable(locator, timeout);
        break;
      case 'enabled':
        await waitForEnabled(locator, timeout);
        break;
      case 'disabled':
        await waitForDisabled(locator, timeout);
        break;
      case 'checked':
        await waitForChecked(locator, timeout);
        break;
      case 'receives-events':
        await waitForReceivesEvents(locator, timeout);
        break;
      default:
        return {
          satisfied: false,
          condition,
          durationMs: Date.now() - started,
          reason: `unknown wait condition: ${String(condition)}`,
        };
    }

    return { satisfied: true, condition, durationMs: Date.now() - started };
  } catch (err) {
    const message =
      err instanceof Error ? (err.message.split('\n')[0] ?? 'timed out') : String(err);
    return {
      satisfied: false,
      condition,
      durationMs: Date.now() - started,
      reason: message,
    };
  }
}

/**
 * Wait until the element stops moving.
 *
 * Compares the bounding box across two consecutive animation frames. Two
 * identical boxes in a row means the element has settled.
 */
async function waitForStable(locator: Locator, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const first = await locator.boundingBox();
    await evaluateFrames(locator, 2);
    const second = await locator.boundingBox();

    if (first !== null && second !== null && sameBox(first, second)) {
      // Confirm once more so a slow start does not look like stability.
      await evaluateFrames(locator, 2);
      const third = await locator.boundingBox();
      if (third !== null && sameBox(second, third)) return;
    }
  }
  throw new Error(`element did not become stable within ${timeout}ms`);
}

/** Compare two bounding boxes. */
function sameBox(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

/** Wait for two animation frames to pass inside the element's frame. */
async function evaluateFrames(locator: Locator, frames: number): Promise<void> {
  await locator.evaluate(async (element, count) => {
    const ownerDocument = element.ownerDocument;
    const view = ownerDocument.defaultView;
    if (view === null) return;
    for (let i = 0; i < count; i++) {
      await new Promise<void>((resolve) => {
        view.requestAnimationFrame(() => resolve());
      });
    }
  }, frames);
}

/** Wait until the element is enabled. */
async function waitForEnabled(locator: Locator, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await locator.isEnabled().catch(() => false)) return;
    await delay(50);
  }
  throw new Error(`element did not become enabled within ${timeout}ms`);
}

/** Wait until the element is disabled. */
async function waitForDisabled(locator: Locator, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await locator.isDisabled().catch(() => false)) return;
    await delay(50);
  }
  throw new Error(`element did not become disabled within ${timeout}ms`);
}

/** Wait until a checkbox or radio is checked. */
async function waitForChecked(locator: Locator, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await locator.isChecked().catch(() => false)) return;
    await delay(50);
  }
  throw new Error(`element did not become checked within ${timeout}ms`);
}

/**
 * Wait until the element receives pointer events at its own centre.
 *
 * This is the check that detects a sticky header covering a button: the
 * element is visible and attached, but the point Playwright would click is
 * owned by something else.
 */
async function waitForReceivesEvents(locator: Locator, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastReason = 'unknown';
  while (Date.now() < deadline) {
    const result = await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return { ok: false, reason: 'element has no size' };
      }
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const topElement = element.ownerDocument.elementFromPoint(x, y);
      if (topElement === null) {
        return { ok: false, reason: 'no element at the centre point' };
      }
      if (element === topElement || element.contains(topElement)) {
        return { ok: true, reason: '' };
      }
      return {
        ok: false,
        reason: `covered by <${topElement.tagName.toLowerCase()}>`,
      };
    });
    if (result.ok) return;
    lastReason = result.reason;
    await delay(50);
  }
  throw new Error(`element did not receive events within ${timeout}ms: ${lastReason}`);
}

/**
 * A short polling delay.
 *
 * This is a *poll interval*, not a synchronisation sleep: the wait's exit
 * condition is re-evaluated on every tick. It is bounded by the caller's
 * timeout, so it can never turn into a fixed wait.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The wait conditions, for CLI help and validation. */
export const WAIT_CONDITIONS: readonly WaitCondition[] = [
  'attached',
  'detached',
  'visible',
  'hidden',
  'stable',
  'enabled',
  'disabled',
  'checked',
  'receives-events',
];
