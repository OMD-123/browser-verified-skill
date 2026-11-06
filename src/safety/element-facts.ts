/**
 * The element-fact rules (M05-M07).
 *
 * These are **pure functions over plain data**. The browser callback in
 * `inspect.ts` gathers the raw facts and hands them here; the rules live
 * here so they can be tested without a browser.
 *
 * Splitting it this way is not ceremony: the code that decides "is this a
 * password field?" is the code that decides whether a secret can be typed
 * somewhere it should not be, so it is worth testing directly.
 */

/** What the browser reports about an element. */
export interface RawElement {
  /** The lower-case tag name. */
  tag: string;
  /** The explicit `role` attribute, when there is one. */
  role?: string;
  /** The `aria-label` attribute, when there is one. */
  ariaLabel?: string;
  /** The `id` attribute, when there is one. */
  id?: string;
  /** The `type` attribute, when there is one. */
  type?: string;
  /** The `placeholder` attribute, when there is one. */
  placeholder?: string;
  /** The visible text. */
  text?: string;
  /** The text of the `<label>` that points at this element, when there is one. */
  labelText?: string;
  /** The text of a wrapping `<label>`, when there is one. */
  wrappingLabelText?: string;
  /** Whether the element is inside a form. */
  inForm?: boolean;
  /** The method of the enclosing form. */
  formMethod?: string;
  /** The element's outer HTML, truncated. */
  html?: string;
}

/** What the gate needs to know about an element. */
export interface ElementFacts {
  /** The ARIA role, when the element has one. */
  role?: string;
  /** The accessible name. */
  name?: string;
  /** The visible text. */
  text?: string;
  /** The `type` attribute of an input. */
  inputType?: string;
  /** Whether the element is inside a form. */
  inForm?: boolean;
  /** The method of the enclosing form. */
  formMethod?: string;
  /** Whether the element is a file input. */
  isFileInput?: boolean;
  /** The element's outer HTML, truncated. */
  html?: string;
}

/**
 * The implicit ARIA role of a form control.
 *
 * Only the roles that matter for classification are mapped. An element with
 * no mapping has no implicit role.
 */
export function implicitRole(tag: string, type?: string): string | undefined {
  switch (tag) {
    case 'button':
      return 'button';
    case 'select':
      return 'combobox';
    case 'textarea':
      return 'textbox';
    case 'input': {
      switch ((type ?? 'text').toLowerCase()) {
        case 'checkbox':
          return 'checkbox';
        case 'radio':
          return 'radio';
        case 'button':
        case 'submit':
        case 'reset':
        case 'file':
          return 'button';
        default:
          return 'textbox';
      }
    }
    default:
      return undefined;
  }
}

/** Whether the tag is one that carries a form-control role. */
function isFormControl(tag: string): boolean {
  return tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button';
}

/**
 * The accessible name of an element.
 *
 * The order is: `aria-label`, then a `<label>` that points at the element,
 * then a wrapping `<label>`, then the placeholder.
 */
export function accessibleName(raw: RawElement): string | undefined {
  if (raw.ariaLabel !== undefined && raw.ariaLabel.length > 0) return raw.ariaLabel;

  if (raw.tag === 'input' || raw.tag === 'textarea') {
    if (raw.labelText !== undefined && raw.labelText.length > 0) return raw.labelText;
    if (raw.wrappingLabelText !== undefined && raw.wrappingLabelText.length > 0) {
      return raw.wrappingLabelText;
    }
    if (raw.placeholder !== undefined && raw.placeholder.length > 0) return raw.placeholder;
  }

  return undefined;
}

/**
 * The form method to assume.
 *
 * HTML's default for `<form>` is GET. A form that does not declare one is
 * more likely a state-changing form, so POST is assumed: guessing POST
 * makes the action ask for approval more often, and guessing GET makes it
 * ask less often, and the cost of the two errors is not symmetric.
 */
export function effectiveFormMethod(formMethod: string | undefined): string {
  if (formMethod === undefined) return 'POST';
  const upper = formMethod.toUpperCase();
  return upper === 'GET' ? 'GET' : 'POST';
}

/**
 * Derive the facts the gate needs from the raw element data.
 */
export function computeElementFacts(raw: RawElement): ElementFacts {
  const facts: ElementFacts = {};

  if (raw.role !== undefined && raw.role.length > 0) {
    facts.role = raw.role;
  } else if (isFormControl(raw.tag)) {
    // Every form-control tag has an implicit role, so this is never
    // undefined; the check would be dead code.
    facts.role = implicitRole(raw.tag, raw.type) as string;
  }

  const name = accessibleName(raw);
  if (name !== undefined && name.length > 0) facts.name = name;

  if (raw.text !== undefined && raw.text.length > 0) {
    facts.text = raw.text.slice(0, 200);
  }

  if (raw.type !== undefined) facts.inputType = raw.type;
  if (raw.tag === 'input' && (raw.type ?? '').toLowerCase() === 'file') {
    facts.isFileInput = true;
  }

  if (raw.inForm === true) {
    facts.inForm = true;
    facts.formMethod = effectiveFormMethod(raw.formMethod);
  }

  if (raw.html !== undefined && raw.html.length > 0) {
    facts.html = raw.html.slice(0, 500);
  }

  return facts;
}
