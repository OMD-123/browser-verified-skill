/**
 * The safety gate's browser-side inspector (M05-M11).
 *
 * The gate needs facts about the target element that only the live page
 * knows: its role, its accessible name, whether it is inside a form, what
 * the form's method is, and whether it is a password or file field.
 *
 * This module gathers the *raw* data from the page. The rules that turn
 * that data into facts live in `element-facts.ts`, where they are pure and
 * testable without a browser.
 */
import type { Locator, Page } from 'playwright';
import type { TargetDescriptor } from '../actions/locate.js';
import { computeElementFacts, type ElementFacts, type RawElement } from './element-facts.js';

export type { ElementFacts, RawElement } from './element-facts.js';

/**
 * Inspect a target element on a page.
 *
 * The inspection runs in the browser, so it must not return anything that
 * could be used to run code — only data.
 */
export async function inspectTarget(page: Page, target: TargetDescriptor): Promise<ElementFacts> {
  const locator = await resolveLocator(page, target);
  if (locator === undefined) return {};

  let raw: RawElement;
  try {
    raw = await locator.evaluate(collectRawElement);
  } catch {
    // The element may have gone away between the snapshot and the action.
    return {};
  }

  return computeElementFacts(raw);
}

/**
 * Collect the raw facts about an element.
 *
 * This runs **inside the browser**, so it cannot call Node-side helpers. It
 * returns data only.
 *
 * The coverage tool cannot instrument code that runs in the browser, so this
 * function is excluded from the branch-coverage requirement. The rules it
 * feeds — the part that decides what the gate believes — live in
 * `element-facts.ts`, where they are covered.
 */
/* v8 ignore start -- runs in the browser, not in this process */
function collectRawElement(element: unknown): RawElement {
  const el = element as HTMLElement;
  const raw: RawElement = { tag: el.tagName.toLowerCase() };

  const role = el.getAttribute('role');
  if (role !== null) raw.role = role;

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel !== null) raw.ariaLabel = ariaLabel;

  const id = el.getAttribute('id') ?? '';
  if (id.length > 0) raw.id = id;

  const type = el.getAttribute('type');
  if (type !== null) raw.type = type;

  const placeholder = el.getAttribute('placeholder');
  if (placeholder !== null) raw.placeholder = placeholder;

  const text = (el.textContent ?? '').trim();
  if (text.length > 0) raw.text = text;

  // The label that points at this element.
  if (id.length > 0) {
    const label = el.ownerDocument.querySelector(`label[for="${id}"]`);
    if (label !== null) {
      const labelText = (label.textContent ?? '').trim();
      if (labelText.length > 0) raw.labelText = labelText;
    }
  }

  // A label that wraps this element.
  const wrapping = el.closest('label');
  if (wrapping !== null) {
    const wrappingText = (wrapping.textContent ?? '').trim();
    if (wrappingText.length > 0) raw.wrappingLabelText = wrappingText;
  }

  const form = el.closest('form');
  if (form !== null) {
    raw.inForm = true;
    const method = form.getAttribute('method');
    if (method !== null) raw.formMethod = method.toUpperCase();
  }

  const html = el.outerHTML;
  if (html.length > 0) raw.html = html;

  return raw;
}
/* v8 ignore stop */

/**
 * Resolve a target descriptor to a locator.
 *
 * This mirrors the locator chain in `locate.ts`, but stops at the locator so
 * the facts can be read with `evaluate`. It is a best-effort inspection:
 * when the target cannot be resolved, the facts are empty and the gate falls
 * back to what the caller knows.
 */
async function resolveLocator(page: Page, target: TargetDescriptor): Promise<Locator | undefined> {
  const candidates: Locator[] = [];

  if (target.ref !== undefined) {
    try {
      candidates.push(page.getByRef(target.ref));
    } catch {
      /* An invalid ref falls through to the other strategies. */
    }
  }
  if (target.role !== undefined) {
    candidates.push(
      page.getByRole(target.role as Parameters<Page['getByRole']>[0], {
        ...(target.name !== undefined ? { name: target.name } : {}),
      }),
    );
  }
  if (target.label !== undefined) candidates.push(page.getByLabel(target.label));
  if (target.text !== undefined) candidates.push(page.getByText(target.text));
  if (target.testId !== undefined) candidates.push(page.getByTestId(target.testId));
  if (target.css !== undefined) candidates.push(page.locator(target.css));

  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    if (count > 0) return candidate.first();
  }
  return undefined;
}
