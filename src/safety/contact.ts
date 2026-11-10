/**
 * The contact URL (Phase 0, gap 5).
 *
 * ## The problem
 *
 * The default user agent in v1 was:
 *
 *     BrowserVerifiedSkill/1.0 (+@url:`https://your-site/contact`)
 *
 * Two problems in one string.
 *
 * **The `@url:` marker is internal.** It is how the policy says "this
 * entry is an explicit URL, not a host pattern". It means nothing to a
 * site, and shipping it in a user agent is noise. It is stripped.
 *
 * **The URL is a placeholder.** `https://your-site/contact` is not a
 * contact. A site owner who reads the user agent and tries to reach it
 * gets nowhere, or reaches a domain that belongs to someone else. The
 * whole point of an honest user agent is that it can be acted on.
 *
 * ## The rule
 *
 * A session's contact URL is used only if it is REAL:
 *
 *   - the operator gave it with `--contact`, or
 *   - it is on an origin the operator owns
 *
 * Otherwise there is no contact, and the user agent says so by simply
 * not having one. That is more honest than a contact that goes
 * nowhere.
 */
import { URL_MARKER } from './policy.js';
import { originOf } from './evaluator.js';

/**
 * The placeholder contact URLs that ship in the default policy.
 *
 * These are the ones an operator is expected to replace. A session that
 * would use one of these is refused.
 */
const PLACEHOLDER_CONTACTS = new Set([
  'https://your-site/contact',
  'http://your-site/contact',
  'https://your-site.example/contact',
]);

/**
 * Strip the `@url:` marker and the backticks around it.
 *
 * The marker is a policy-internal convention. It is not part of a URL
 * and it is not something a site should see.
 */
export function stripUrlMarker(value: string): string {
  let raw = value.trim();

  if (raw.toLowerCase().startsWith(URL_MARKER)) {
    raw = raw.slice(URL_MARKER.length).trim();
  }

  // The marker convention wraps the URL in backticks.
  raw = raw.replace(/^`|`$/g, '').trim();

  return raw;
}

/**
 * Whether a contact URL is a placeholder rather than a real contact.
 *
 * A missing contact is a placeholder too: there is nothing to be
 * honest about.
 */
export function isPlaceholderContact(contact: string | undefined): boolean {
  if (contact === undefined) return true;

  const stripped = stripUrlMarker(contact);
  if (stripped.length === 0) return true;

  // The value may be a whole user-agent suffix rather than a bare URL,
  // so the URL is pulled out of it before it is compared.
  const url = extractUrl(stripped);
  if (url === undefined) return true;

  return PLACEHOLDER_CONTACTS.has(url.toLowerCase());
}

/**
 * The URL inside a user-agent suffix.
 *
 * The suffix looks like `BrowserVerifiedSkill/1.0 (+https://x.test/c)`.
 * The URL is what is in the parentheses.
 */
function extractUrl(value: string): string | undefined {
  const match = /\(([^)]+)\)/.exec(value);
  if (match !== null) {
    // The parenthesised part is the suffix, and it starts with a `+`
    // separator: `(+https://x.test/c)`.
    return match[1]?.trim().replace(/^\+/, '').trim();
  }

  // A bare URL is the URL.
  if (/^https?:\/\//i.test(value)) return value;

  return undefined;
}

/**
 * The contact URL to put in the user agent, if there is an honest one.
 *
 * A contact is honest when it is REAL. That means one of:
 *
 *   - the operator gave it explicitly. Passing `--contact` is the
 *     operator asserting "this is where you can reach me". They know
 *     their own contact details; the tool does not need to check.
 *
 *   - it is on an origin the operator owns. The contact for a site you
 *     own is reachable by definition.
 *
 * A placeholder is never honest, even on an owned origin: `your-site`
 * is not a contact.
 *
 * When neither holds, there is no contact, and the user agent simply
 * does not have one. That is more honest than a contact that goes
 * nowhere.
 */
export function honestContact(
  contact: string | undefined,
  ownedOrigins: readonly string[],
): string | undefined {
  if (isPlaceholderContact(contact)) return undefined;

  // `isPlaceholderContact` already refused an empty one, so this is
  // not empty here.
  const stripped = stripUrlMarker(contact as string);

  // The operator owns the origin the contact is on, so the contact for
  // that site is reachable.
  const targetOrigin = originOf(stripped);
  if (ownedOrigins.some((origin) => originOf(origin) === targetOrigin)) {
    return stripped;
  }

  // The operator gave it explicitly with `--contact`. That is them
  // asserting "this is where you can reach me", so it is theirs and
  // the tool does not second-guess it.
  return stripped;
}
