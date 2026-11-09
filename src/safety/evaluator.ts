/**
 * The policy engine.
 *
 * `evaluate(action, ctx)` returns a `PolicyDecision`. It is a pure function
 * over plain data, so it can be exhaustively unit-tested without a browser.
 *
 * The engine is the outermost gate: nothing reaches the browser without
 * passing it.
 */
import { classifyAction, type ActionIntent } from './classify.js';
import {
  ACTION_CLASSES,
  URL_MARKER,
  type ActionClass,
  type Policy,
  type PolicyDecision,
} from './policy.js';

/** The context an action is evaluated in. */
export interface PolicyContext {
  /** The policy to evaluate against. */
  policy: Policy;
  /** The URL the action would end at, when known. */
  url?: string;
  /** The URL the session is currently on. */
  currentUrl?: string;
  /** Whether the session is running non-interactively. */
  nonInteractive: boolean;
  /** Whether the target value came from the page (tainted). */
  tainted: boolean;
  /** Whether an approval token was supplied for this exact action. */
  approved: boolean;
}

/** The result of matching a host against a domain pattern. */
export interface DomainMatch {
  /** Whether the pattern matched. */
  matched: boolean;
  /** Which pattern matched. */
  pattern?: string;
}

/**
 * Normalise a domain pattern to a comparable form.
 *
 * `*.example.com` becomes `.example.com` (a suffix match), `example.com`
 * becomes `example.com` (an exact match), and a leading `www.` is ignored
 * for exact matches.
 */
function normalizePattern(pattern: string): { kind: 'exact' | 'suffix'; value: string } {
  const value = pattern.toLowerCase().replace(/^\.+/, '').replace(/\/+$/, '');
  if (value.startsWith('*.')) {
    return { kind: 'suffix', value: value.slice(1) };
  }
  return { kind: 'exact', value };
}

/** Extract the host from a URL, or undefined when the URL is invalid. */
export function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Match a host against a list of domain patterns.
 *
 * A pattern may be a plain host (`example.com`, `*.example.com`) or an
 * explicit URL using the `@url:` marker, in which case only the host of that
 * URL is used.
 */
export function matchDomains(host: string | undefined, patterns: readonly string[]): DomainMatch {
  if (host === undefined) return { matched: false };
  const lower = host.toLowerCase();

  for (const raw of patterns) {
    const pattern = raw.trim();
    if (pattern.length === 0) continue;

    let comparable = pattern;
    if (pattern.toLowerCase().startsWith(URL_MARKER)) {
      const url = pattern.slice(URL_MARKER.length).trim().replace(/^`|`$/g, '');
      const parsedHost = hostOf(url);
      if (parsedHost === undefined) continue;
      comparable = parsedHost;
    }

    const normalized = normalizePattern(comparable);
    if (normalized.kind === 'suffix') {
      if (lower === normalized.value.slice(1) || lower.endsWith(normalized.value)) {
        return { matched: true, pattern: raw };
      }
    } else if (lower === normalized.value || lower === `www.${normalized.value}`) {
      return { matched: true, pattern: raw };
    }
  }

  return { matched: false };
}

/**
 * Normalise an origin for comparison.
 *
 * `@url:` markers are stripped and the path is removed, so
 * `@url:`http://localhost:3000/app`` and `http://localhost:3000` are equal.
 */
/**
 * The origin of a URL.
 *
 * A URL that does not parse has no origin, so the URL itself is used.
 * That is the safe answer: an unparseable URL is not an origin the
 * policy has allowed.
 */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export function normalizeOrigin(value: string): string {
  let raw = value.trim();
  if (raw.toLowerCase().startsWith(URL_MARKER)) {
    raw = raw.slice(URL_MARKER.length).trim().replace(/^`|`$/g, '');
  }
  try {
    const parsed = new URL(raw);
    return parsed.origin.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/** True when the origin is in the policy's `ownedOrigins`. */
export function isOwnedOrigin(origin: string | undefined, policy: Policy): boolean {
  if (origin === undefined) return false;
  const target = normalizeOrigin(origin);
  return policy.ownedOrigins.some((o) => normalizeOrigin(o) === target);
}

/** True when the action class is in the deny list. */
export function isDeniedClass(actionClass: ActionClass, policy: Policy): boolean {
  return policy.actionClasses.deny.includes(actionClass);
}

/** True when the action class requires approval. */
export function requiresApproval(actionClass: ActionClass, policy: Policy): boolean {
  return policy.actionClasses.approvalRequired.includes(actionClass);
}

/**
 * Evaluate an action against the policy.
 *
 * The checks run in a fixed order, and each one that fires records a rule id
 * so the decision can be explained and audited.
 */
export function evaluate(intent: ActionIntent, ctx: PolicyContext): PolicyDecision {
  const { policy } = ctx;
  const reasons: string[] = [];
  const ruleIds: string[] = [];

  // --- 1. Denied action classes -------------------------------------------
  const actionClass = classifyAction(intent);
  if (isDeniedClass(actionClass, policy)) {
    reasons.push(`the "${actionClass}" action class is denied by policy`);
    ruleIds.push(`policy.deny.${actionClass}`);
    return { verdict: 'deny', reasons, ruleIds, actionClass };
  }

  // --- 2. Domain deny ------------------------------------------------------
  // The URL the action would land at comes from the intent; the context's
  // `url` is the fallback for actions whose target URL is not in the intent.
  const effectiveUrl = intent.url ?? ctx.url;
  const targetHost = hostOf(effectiveUrl);
  if (targetHost !== undefined) {
    const denied = matchDomains(targetHost, policy.domains.deny);
    if (denied.matched) {
      reasons.push(`the host "${targetHost}" is denied by policy`);
      ruleIds.push('policy.domain.deny');
      return { verdict: 'deny', reasons, ruleIds, actionClass };
    }
  }

  // --- 3. Domain allow -----------------------------------------------------
  // Any action that would land on a URL must land on an allowed domain. A
  // missing `allow` list means "no restriction", which is the documented
  // behaviour of an empty list.
  if (effectiveUrl !== undefined && policy.domains.allow.length > 0) {
    const allowed = matchDomains(targetHost, policy.domains.allow);
    if (!allowed.matched) {
      reasons.push(`the host "${targetHost ?? 'unknown'}" is not in the policy's allowed domains`);
      ruleIds.push('policy.domain.allow');
      return { verdict: 'deny', reasons, ruleIds, actionClass };
    }
  }

  // --- 4. eval-readonly is off by default ---------------------------------
  if (intent.kind === 'eval-readonly' && policy.compliance.evalReadonly !== true) {
    reasons.push('eval-readonly is disabled; set compliance.evalReadonly to enable it');
    ruleIds.push('policy.eval_readonly.disabled');
    return { verdict: 'deny', reasons, ruleIds, actionClass };
  }

  // --- 5. Tainted input ----------------------------------------------------
  // This comes BEFORE the approval-required check. A tainted value in a
  // submit is a different problem from a submit that needs approval:
  // the first says "this content came from the page", the second says
  // "submits need a human". Reporting only the second hides the first.
  //
  // Both end in `needs_approval`, so the action is refused either way.
  if (ctx.tainted === true && (actionClass === 'submit' || actionClass === 'messaging')) {
    reasons.push('the action would send content derived from the page');
    ruleIds.push('policy.tainted.submit');
    return { verdict: 'needs_approval', reasons, ruleIds, actionClass };
  }

  // --- 6. Approval-required classes ----------------------------------------
  if (requiresApproval(actionClass, policy)) {
    if (ctx.approved === true) {
      reasons.push(`the "${actionClass}" action class was approved`);
      ruleIds.push(`policy.approval.granted.${actionClass}`);
      return { verdict: 'allow', reasons, ruleIds, actionClass };
    }
    if (ctx.nonInteractive) {
      // A non-interactive session cannot ask, so it cannot be approved on
      // the spot. It does NOT mean the action is forbidden: the caller may
      // still obtain an approval out of band (`bv approve` in another
      // terminal) and retry with the token.
      //
      // So this is `needs_approval`, not `deny`. The distinction matters:
      // a denial says "do not do this", while this says "do not do this
      // without a human's say-so".
      reasons.push(
        `the "${actionClass}" action class requires approval; this session is non-interactive, so approve it out of band and retry with the token`,
      );
      ruleIds.push(`policy.approval.required.${actionClass}`);
      return { verdict: 'needs_approval', reasons, ruleIds, actionClass };
    }
    reasons.push(`the "${actionClass}" action class requires approval`);
    ruleIds.push(`policy.approval.required.${actionClass}`);
    return { verdict: 'needs_approval', reasons, ruleIds, actionClass };
  }

  // --- 7. Allowed ----------------------------------------------------------
  reasons.push(`the "${actionClass}" action class is allowed by policy`);
  ruleIds.push(`policy.allow.${actionClass}`);
  return { verdict: 'allow', reasons, ruleIds, actionClass };
}

/** The action classes, re-exported for convenience. */
export { ACTION_CLASSES };
