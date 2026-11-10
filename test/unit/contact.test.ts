/**
 * The honest user agent (Phase 0, gap 5).
 *
 * The gap: the default user agent literally contained
 * `+@url:`https://your-site/contact``. Two problems in one string.
 *
 *   - the `@url:` marker is an INTERNAL marker. It is how the policy
 *     says "this entry is an explicit URL, not a host pattern". It
 *     means nothing to a site, and shipping it is noise.
 *
 *   - `https://your-site/contact` is a PLACEHOLDER. A site owner who
 *     reads the user agent and tries to contact it reaches a domain
 *     that does not exist, or worse, one that does.
 *
 * So: the marker is stripped, and a session does not start on a
 * placeholder contact URL unless the operator gave a real one.
 */
import { describe, expect, it } from 'vitest';
import { buildUserAgent } from '../../src/core/session.js';
import { URL_MARKER } from '../../src/safety/policy.js';
import { isPlaceholderContact, honestContact } from '../../src/safety/contact.js';

describe('the user agent', () => {
  it('has no marker and no placeholder by default', () => {
    const ua = buildUserAgent(undefined);

    expect(ua).not.toContain(URL_MARKER);
    expect(ua).not.toContain('@url:');
    expect(ua).not.toContain('your-site');
    expect(ua).toMatch(/^BrowserVerifiedSkill\/\d+\.\d+\.\d+/);
  });

  it('strips the marker from a contact URL', () => {
    const ua = buildUserAgent('@url:`https://example.test/contact`');

    expect(ua).not.toContain(URL_MARKER);
    expect(ua).not.toContain('@url:');
    expect(ua).toContain('https://example.test/contact');
  });

  it('keeps a plain contact URL', () => {
    const ua = buildUserAgent('https://example.test/contact');

    expect(ua).toContain('https://example.test/contact');
    expect(ua).not.toContain('@url:');
  });
});

describe('the contact URL', () => {
  it('recognises the placeholders', () => {
    expect(isPlaceholderContact('https://your-site/contact')).toBe(true);
    expect(isPlaceholderContact('@url:`https://your-site/contact`')).toBe(true);
    expect(isPlaceholderContact('https://example.com/contact')).toBe(false);
    expect(isPlaceholderContact('https://example.test/contact')).toBe(false);
  });

  it('recognises a missing contact', () => {
    expect(isPlaceholderContact(undefined)).toBe(true);
    expect(isPlaceholderContact('')).toBe(true);
  });

  it('refuses to invent a contact', () => {
    // There is no honest contact to give, so none is given.
    expect(honestContact(undefined, [])).toBeUndefined();
  });

  it('accepts a contact the operator gave', () => {
    expect(honestContact('https://example.test/contact', [])).toBe('https://example.test/contact');
  });

  it('accepts a contact on an owned origin', () => {
    // The operator owns the site, so a contact there is reachable.
    expect(honestContact('https://mysite.test/contact', ['https://mysite.test'])).toBe(
      'https://mysite.test/contact',
    );
  });

  it('recognises a user-agent suffix, not just a bare URL', () => {
    // The shipped value is a whole suffix, not a URL:
    // `BrowserVerifiedSkill/1.0 (+https://your-site/contact)`.
    expect(isPlaceholderContact('BrowserVerifiedSkill/1.0 (+https://your-site/contact)')).toBe(
      true,
    );
  });

  it('treats a value with no URL in it as a placeholder', () => {
    // There is nothing to contact, so it is a placeholder.
    expect(isPlaceholderContact('BrowserVerifiedSkill/1.0')).toBe(true);
  });

  it('refuses a placeholder contact even on an owned origin', () => {
    // The placeholder is not a contact. Owning the origin does not make
    // 'your-site' reachable.
    expect(honestContact('https://your-site/contact', ['https://your-site'])).toBeUndefined();
  });

  it('refuses a contact that was not given at all', () => {
    // Nothing given and nothing owned: there is no honest contact, so
    // the user agent has none. That is better than a contact that goes
    // nowhere.
    expect(honestContact(undefined, ['https://mysite.test'])).toBeUndefined();
    expect(honestContact('', ['https://mysite.test'])).toBeUndefined();
  });

  it('refuses to start a session on a placeholder contact', () => {
    // The requirement: a session does not START on a placeholder contact
    // URL unless the operator gave one, or the origin is owned.
    const placeholder = 'https://your-site/contact';

    // No contact given, the placeholder is what the policy holds.
    expect(honestContact(placeholder, [])).toBeUndefined();

    // The operator gave a real one.
    expect(honestContact('https://example.test/contact', [])).toBe('https://example.test/contact');

    // The operator owns the origin the contact is on.
    expect(honestContact(placeholder, ['https://your-site'])).toBeUndefined();
  });

  it('strips the marker from the contact it returns', () => {
    expect(honestContact('@url:`https://example.test/contact`', [])).toBe(
      'https://example.test/contact',
    );
  });
});
