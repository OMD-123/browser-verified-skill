/**
 * Action classification.
 *
 * A pure function: given what the agent is about to do and what it knows
 * about the target, decide the action class.
 *
 * The classifier is **conservative**: when the evidence is insufficient, the
 * result is the more dangerous class, never the safer one. An unknown button
 * is `submit` (approval required), not `read`.
 */
import type { ActionClass } from './policy.js';

/** What the agent wants to do. */
export interface ActionIntent {
  /** The kind of operation, e.g. `click`, `fill`, `goto`, `upload`. */
  kind: string;
  /** The HTTP method the action would result in, when it results in one. */
  method?: string;
  /** The target's ARIA role, when known. */
  role?: string;
  /** The target's accessible name, when known. */
  name?: string;
  /** The target's visible text, when known. */
  text?: string;
  /** The target's value, for input fields. */
  value?: string;
  /** The target's input type, e.g. `password`, `email`, `number`. */
  inputType?: string;
  /** Whether the target is inside a form. */
  inForm?: boolean;
  /** The form's method, when the target is inside a form. */
  formMethod?: string;
  /** Whether the element is a file input. */
  isFileInput?: boolean;
  /** The URL being navigated to. */
  url?: string;
  /** The accessibility-tree ref of the target, when it was addressed by one. */
  ref?: string;
  /** The CSS selector of the target, when it was addressed by one. */
  css?: string;
  /** The label of the target, when it was addressed by one. */
  label?: string;
}

/** Patterns that mark an action as destructive. */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bdestroy\b/i,
  /\berase\b/i,
  /\bwipe\b/i,
  /\bclear\s+(all|everything)\b/i,
  /\bdrop\b/i,
  /\bpurge\b/i,
  /\btruncate\b/i,
  /\breset\b/i,
  /\brevoke\b/i,
  /\bterminate\b/i,
  /\bdisable\b/i,
  /\bdeactivate\b/i,
  /\bunsubscribe\b/i,
  /\bclose\s+account\b/i,
];

/** Patterns that mark an action as financial. */
const FINANCIAL_PATTERNS: RegExp[] = [
  /\bpay\b/i,
  /\bpayment\b/i,
  /\bpurchase\b/i,
  /\bbuy\b/i,
  /\bcheckout\b/i,
  /\bplace\s+order\b/i,
  /\bsubscribe\b/i,
  /\bdonate\b/i,
  /\btip\b/i,
  /\btransfer\b/i,
  /\bwithdraw\b/i,
  /\bdeposit\b/i,
  /\bwire\b/i,
  /\binvoice\b/i,
  /\bbilling\b/i,
  /\bcard\b/i,
  /\bcredit\s+card\b/i,
  /\bconfirm\s+order\b/i,
  /\bupgrade\b/i,
  /\brenew\b/i,
  /\bprice\b/i,
];

/** Patterns that mark an action as messaging. */
const MESSAGING_PATTERNS: RegExp[] = [
  /\bsend\b/i,
  /\bemail\b/i,
  /\be-mail\b/i,
  /\bmessage\b/i,
  /\bpost\b/i,
  /\bpublish\b/i,
  /\bshare\b/i,
  /\btweet\b/i,
  /\bcomment\b/i,
  /\breply\b/i,
  /\bforward\b/i,
  /\bnotify\b/i,
  /\bsubscribe\s+to\s+the\s+newsletter\b/i,
  /\bcontact\s+us\b/i,
  /\breport\b/i,
  /\bflag\b/i,
  /\bmention\b/i,
  /\bmessage\s+the\b/i,
];

/** Patterns that mark an action as upload. */
const UPLOAD_PATTERNS: RegExp[] = [
  /\bupload\b/i,
  /\battach\b/i,
  /\bchoose\s+file\b/i,
  /\bselect\s+file\b/i,
  /\bbrowse\b/i,
  /\bimport\b/i,
];

/** Patterns that mark an action as submit. */
const SUBMIT_PATTERNS: RegExp[] = [
  /\bsubmit\b/i,
  /\bsign\s?in\b/i,
  /\bsign\s?up\b/i,
  /\blog\s?in\b/i,
  /\bregister\b/i,
  /\bcontinue\b/i,
  /\bnext\b/i,
  /\bconfirm\b/i,
  /\bapply\b/i,
  /\bcreate\b/i,
  /\bsave\b/i,
  /\bsearch\b/i,
  /\bsubscribe\b/i,
  /\bplace\b/i,
];

/** Input types that carry a password. */
const SENSITIVE_INPUT_TYPES = new Set(['password', 'file']);

/** Input types that carry an email address. */
const EMAIL_INPUT_TYPES = new Set(['email']);

/**
 * The HTTP method a form would use when the form does not declare one.
 *
 * HTML's default for `<form>` is GET, but a form whose method is unknown to
 * us is more likely a state-changing form than a search form, and treating an
 * unknown submit as a navigation would let a destructive POST through as a
 * read. The conservative choice is POST.
 */
const ASSUMED_FORM_METHOD = 'POST';

/** Roles that are read-only. */
const READ_ROLES = new Set([
  'article',
  'definition',
  'figure',
  'img',
  'list',
  'listitem',
  'paragraph',
  'region',
  'table',
  'term',
  'heading',
  'banner',
  'complementary',
  'contentinfo',
  'navigation',
  'main',
  'group',
  'note',
  'status',
  'timer',
  'tooltip',
  'document',
  'log',
]);

/** Roles that submit. */
const SUBMIT_ROLES = new Set(['button']);

/** Roles that are links, which navigate. */
const LINK_ROLES = new Set(['link']);

/** Roles that are editable. */
const INPUT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);

/** Roles that toggle. */
const TOGGLE_ROLES = new Set(['checkbox', 'radio', 'switch', 'menuitem', 'tab', 'option']);

/** True when any pattern matches. */
function matchesAny(patterns: readonly RegExp[], text: string | undefined): boolean {
  if (text === undefined || text.length === 0) return false;
  return patterns.some((p) => p.test(text));
}

/**
 * Classify an action.
 *
 * The order of the checks matters: the most dangerous class wins. A button
 * labelled "Delete and pay" is `destructive`, not `financial`, because the
 * destructive outcome is the one that cannot be undone.
 */
export function classifyAction(intent: ActionIntent): ActionClass {
  const label = intent.name ?? intent.text;

  // --- Explicit, unambiguous cases first ---------------------------------

  // Navigation.
  if (intent.kind === 'goto' || intent.kind === 'back' || intent.kind === 'reload') {
    return 'navigate';
  }

  // Downloads.
  if (intent.kind === 'download') return 'download';

  // Uploads.
  if (intent.kind === 'upload' || intent.isFileInput === true) return 'upload';

  // Read-only evaluation.
  if (intent.kind === 'eval-readonly' || intent.kind === 'read' || intent.kind === 'snapshot') {
    return 'read';
  }

  // --- Input-like actions -------------------------------------------------

  const isInput =
    intent.kind === 'fill' ||
    intent.kind === 'type' ||
    intent.kind === 'select' ||
    intent.kind === 'check' ||
    intent.kind === 'uncheck' ||
    intent.kind === 'press';

  if (isInput) {
    // A submit button clicked with `press`/`click` still submits.
    if (intent.role !== undefined && SUBMIT_ROLES.has(intent.role)) {
      const formMethod = (intent.formMethod ?? ASSUMED_FORM_METHOD).toUpperCase();
      // A submit inside a GET form is a navigation, not a state change.
      if (formMethod === 'GET') return 'navigate';
      if (matchesAny(DESTRUCTIVE_PATTERNS, label)) return 'destructive';
      if (matchesAny(FINANCIAL_PATTERNS, label)) return 'financial';
      if (matchesAny(MESSAGING_PATTERNS, label)) return 'messaging';
      return 'submit';
    }

    if (intent.inputType !== undefined && SENSITIVE_INPUT_TYPES.has(intent.inputType)) {
      return 'input';
    }
    if (intent.inputType !== undefined && EMAIL_INPUT_TYPES.has(intent.inputType)) {
      return 'input';
    }
    if (intent.role !== undefined && INPUT_ROLES.has(intent.role)) {
      return 'input';
    }
    if (intent.role !== undefined && TOGGLE_ROLES.has(intent.role)) {
      return 'input';
    }
    if (intent.inForm === true) {
      return 'input';
    }
    // An unrecognised input target: treat as input, which requires approval
    // only if the policy says so — but the classification itself is `input`.
    return 'input';
  }

  // --- Click-like actions -------------------------------------------------

  if (intent.kind === 'click' || intent.kind === 'dblclick' || intent.kind === 'hover') {
    // A destructive label wins over every other class.
    if (matchesAny(DESTRUCTIVE_PATTERNS, label)) return 'destructive';

    if (intent.role !== undefined && LINK_ROLES.has(intent.role)) {
      return 'navigate';
    }
    if (intent.role !== undefined && READ_ROLES.has(intent.role)) {
      return 'read';
    }
    if (intent.role !== undefined && SUBMIT_ROLES.has(intent.role)) {
      const formMethod = (intent.formMethod ?? ASSUMED_FORM_METHOD).toUpperCase();
      if (formMethod === 'GET') return 'navigate';
      if (matchesAny(FINANCIAL_PATTERNS, label)) return 'financial';
      if (matchesAny(MESSAGING_PATTERNS, label)) return 'messaging';
      if (matchesAny(UPLOAD_PATTERNS, label)) return 'upload';
      return 'submit';
    }

    // No role: fall back to the label.
    if (matchesAny(FINANCIAL_PATTERNS, label)) return 'financial';
    if (matchesAny(MESSAGING_PATTERNS, label)) return 'messaging';
    if (matchesAny(UPLOAD_PATTERNS, label)) return 'upload';
    if (matchesAny(SUBMIT_PATTERNS, label)) return 'submit';
    if (intent.inForm === true) return 'submit';

    // Unknown click target with no useful evidence: conservative default.
    return 'submit';
  }

  // --- Anything else ------------------------------------------------------
  // The method tells us whether it mutates state.
  const method = (intent.method ?? '').toUpperCase();
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    if (matchesAny(DESTRUCTIVE_PATTERNS, label)) return 'destructive';
    if (matchesAny(FINANCIAL_PATTERNS, label)) return 'financial';
    if (matchesAny(MESSAGING_PATTERNS, label)) return 'messaging';
    return 'submit';
  }
  if (method === 'GET' || method === 'HEAD') return 'read';

  // Unknown action kind: treat as a state-changing submit so it needs
  // approval rather than being waved through.
  return 'submit';
}

/**
 * The HTTP method each action class implies.
 *
 * A lookup table rather than a switch: every class is present, so there is
 * no default branch to cover, and the compiler checks the table is complete
 * because it is typed as `Record<ActionClass, ...>`.
 */
const CLASS_METHODS: Record<ActionClass, 'GET' | 'POST'> = {
  read: 'GET',
  navigate: 'GET',
  input: 'POST',
  submit: 'POST',
  destructive: 'POST',
  financial: 'POST',
  messaging: 'POST',
  download: 'POST',
  upload: 'POST',
};

/**
 * The default HTTP method for an action class.
 *
 * Used by the policy engine to decide whether an action would mutate state.
 */
export function methodForClass(actionClass: ActionClass): 'GET' | 'POST' {
  return CLASS_METHODS[actionClass];
}
