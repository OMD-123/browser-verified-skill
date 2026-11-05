/**
 * Executing actions.
 *
 * Each action:
 *  1. resolves the target through the locator chain,
 *  2. waits for the element to be actionable,
 *  3. performs the action,
 *  4. reports which strategy won.
 */
import type { Locator, Page } from 'playwright';
import { locate, type ActionKind, type ActionRequest, type LocatorStrategy } from './locate.js';
import { waitForCondition } from './waits.js';

/** The outcome of an action. */
export interface ActionOutcome {
  /** True when the action was performed. */
  ok: boolean;
  /** The action that was requested. */
  kind: ActionKind;
  /** The strategy that located the element. */
  strategy: LocatorStrategy | undefined;
  /** Every strategy that was tried. */
  attempted: LocatorStrategy[];
  /** Why each failed strategy failed. */
  failures: { strategy: LocatorStrategy; reason: string }[];
  /** A human-readable message. */
  message: string;
  /** How long the action took. */
  durationMs: number;
  /** The URL before the action. */
  urlBefore: string;
  /** The URL after the action. */
  urlAfter: string;
  /** The page title after the action. */
  titleAfter: string;
  /** The number of elements that matched the target (for ambiguity reports). */
  matchCount?: number;
}

/** How long to wait for an element to become actionable. */
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;

/**
 * Perform an action on a page.
 *
 * The function never throws for an ordinary failure (element not found,
 * action timed out): it returns a structured outcome so the caller can record
 * it and decide whether to retry or escalate.
 */
export async function performAction(
  page: Page,
  request: ActionRequest,
  options: { timeoutMs?: number } = {},
): Promise<ActionOutcome> {
  const timeout = options.timeoutMs ?? request.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const started = Date.now();
  const urlBefore = page.url();

  const located = await locate(page, request.target, { timeoutMs: timeout });

  const base: ActionOutcome = {
    ok: false,
    kind: request.kind,
    strategy: located.strategy,
    attempted: located.attempted,
    failures: located.failures,
    message: '',
    durationMs: 0,
    urlBefore,
    urlAfter: urlBefore,
    titleAfter: '',
  };

  if (located.locator === undefined) {
    const detail = located.failures.map((f) => `${f.strategy}: ${f.reason}`).join('; ');
    return {
      ...base,
      message: `could not locate the target (${detail || 'no strategies available'})`,
      durationMs: Date.now() - started,
    };
  }

  try {
    const message = await execute(page, located.locator, request, timeout);
    return {
      ...base,
      ok: true,
      message,
      durationMs: Date.now() - started,
      urlAfter: page.url(),
      titleAfter: await page.title().catch(() => ''),
    };
  } catch (err) {
    const message =
      err instanceof Error ? (err.message.split('\n')[0] ?? 'action failed') : String(err);
    return {
      ...base,
      message: `action failed: ${message}`,
      durationMs: Date.now() - started,
      urlAfter: page.url(),
      titleAfter: await page.title().catch(() => ''),
    };
  }
}

/**
 * Scroll an element into view and out from under any fixed overlay.
 *
 * `scrollIntoViewIfNeeded` is not enough for a sticky header: the element may
 * already be "in view" while being covered by a fixed overlay.
 *
 * The algorithm is:
 *  1. scroll the element into view (nearest),
 *  2. find what element is actually on top of its centre,
 *  3. if that element is not the target (or an ancestor of it), scroll the
 *     window just far enough to clear the covering element's edge,
 *  4. repeat, up to a small bound.
 *
 * **Scroll direction matters.** Moving an element *down* out from under a
 * top-anchored cover requires scrolling the page *up* (decreasing scrollY),
 * because the cover stays pinned to the viewport while the element moves down
 * within it. The general rule is: the element must end up below the cover's
 * bottom edge, and since the cover is fixed, that means moving the element
 * down relative to the viewport — which means scrolling in the opposite
 * direction.
 *
 * This is generic: it does not know that the cover is a "sticky header", only
 * that something is in the way.
 */
async function scrollIntoClearView(locator: Locator, timeout: number): Promise<void> {
  await locator
    .evaluate((element) => {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    })
    .catch(() => undefined);

  const deadline = Date.now() + Math.min(timeout, 5000);

  for (let attempt = 0; attempt < 4 && Date.now() < deadline; attempt++) {
    const cover = await locator
      .evaluate((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const topElement = element.ownerDocument.elementFromPoint(x, y);
        if (topElement === null) return null;
        if (element === topElement || element.contains(topElement)) return null;
        const coverRect = topElement.getBoundingClientRect();
        return { bottom: coverRect.bottom, top: coverRect.top };
      })
      .catch(() => null);

    if (cover === null) {
      // Nothing is covering the element: it is ready.
      await waitForCondition(locator, 'stable', { timeoutMs: Math.min(timeout, 5000) });
      return;
    }

    // Scroll so the element's top edge sits just below the covering element.
    //
    // `delta` is the number of pixels the element must move *down* within the
    // viewport. Moving an element down within the viewport means scrolling
    // the page up, so the scroll delta is the negative of that.
    const delta = await locator.evaluate((element, coverBottom) => {
      const rect = element.getBoundingClientRect();
      const needed = coverBottom - rect.top + 4;
      if (needed <= 0) return 0;
      const before = window.scrollY;
      window.scrollBy(0, -needed);
      return window.scrollY - before;
    }, cover.bottom);

    if (delta === 0) {
      // The page cannot scroll any further: the element is stuck under a
      // fixed overlay that spans the whole viewport. Break out rather than
      // loop.
      break;
    }
  }

  await waitForCondition(locator, 'stable', { timeoutMs: Math.min(timeout, 5000) });
}

/** Execute one action against a resolved locator. */
async function execute(
  page: Page,
  locator: Locator,
  request: ActionRequest,
  timeout: number,
): Promise<string> {
  const options = { timeout, ...(request.force === true ? { force: true } : {}) };

  switch (request.kind) {
    case 'click':
      await scrollIntoClearView(locator, timeout);
      await locator.click(options);
      return 'clicked';

    case 'dblclick':
      await scrollIntoClearView(locator, timeout);
      await locator.dblclick(options);
      return 'double-clicked';

    case 'hover':
      await scrollIntoClearView(locator, timeout);
      await locator.hover(options);
      return 'hovered';

    case 'type':
      await scrollIntoClearView(locator, timeout);
      await locator.click({ timeout }).catch(() => undefined);
      await locator.pressSequentially(request.value ?? '', {
        timeout,
        delay: 20,
      });
      return 'typed';

    case 'fill':
      await scrollIntoClearView(locator, timeout);
      await locator.fill(request.value ?? '', options);
      return 'filled';

    case 'select':
      await scrollIntoClearView(locator, timeout);
      await locator.selectOption(request.value ?? '', { timeout });
      return 'selected';

    case 'check':
      await scrollIntoClearView(locator, timeout);
      await locator.check(options);
      return 'checked';

    case 'uncheck':
      await scrollIntoClearView(locator, timeout);
      await locator.uncheck(options);
      return 'unchecked';

    case 'press':
      await locator.press(request.value ?? 'Enter', { timeout });
      return `pressed ${request.value ?? 'Enter'}`;

    case 'scroll':
      await scrollIntoClearView(locator, timeout);
      return 'scrolled into view';

    case 'upload':
      await locator.setInputFiles(request.value ?? '', { timeout });
      return 'uploaded';

    case 'focus':
      await locator.focus({ timeout });
      return 'focused';

    default: {
      // Exhaustiveness: an unknown kind is a programming error.
      const exhaustive: never = request.kind;
      throw new Error(`unsupported action kind: ${String(exhaustive)}`);
    }
  }
}

/**
 * Wait for a condition on a target, using the locator chain.
 *
 * Used by `bv act wait <target> <condition>`.
 */
export async function waitForTarget(
  page: Page,
  target: ActionRequest['target'],
  condition: Parameters<typeof waitForCondition>[1],
  options: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; message: string; strategy: LocatorStrategy | undefined }> {
  const timeout = options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const located = await locate(page, target, { timeoutMs: timeout });

  if (located.locator === undefined) {
    return {
      ok: false,
      message: `could not locate the target for the wait`,
      strategy: undefined,
    };
  }

  const result = await waitForCondition(located.locator, condition, { timeoutMs: timeout });
  return {
    ok: result.satisfied,
    message: result.satisfied
      ? `condition "${condition}" satisfied`
      : `condition "${condition}" not satisfied: ${result.reason ?? 'unknown reason'}`,
    strategy: located.strategy,
  };
}
