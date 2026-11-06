/**
 * Exhaustive tests for the taint tracker (M07).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  taint,
  trust,
  derive,
  narrow,
  approveTaint,
  isTainted,
  provenanceOf,
  checkSink,
  sinkForField,
  enumValidator,
  numericValidator,
  taintRegistry,
  type TaintSink,
} from '../../../src/safety/taint.js';

describe('taint tracking', () => {
  beforeEach(() => {
    taintRegistry().clear();
  });

  it('marks a page-derived value as tainted', () => {
    const value = taint('attacker@evil.test', {
      source: 'page-text',
      url: 'https://evil.test/page',
      origin: 'https://evil.test',
      via: 'textbox[name=email]',
    });
    expect(isTainted(value)).toBe(true);
  });

  it('records the provenance of a tainted value', () => {
    const value = taint('attacker@evil.test', {
      source: 'page-text',
      url: 'https://evil.test/page',
      origin: 'https://evil.test',
      via: 'textbox[name=email]',
    });
    const record = provenanceOf(value);
    expect(record?.source).toBe('page-text');
    expect(record?.url).toBe('https://evil.test/page');
    expect(record?.origin).toBe('https://evil.test');
    expect(record?.via).toBe('textbox[name=email]');
    expect(record?.capturedAt).toBeDefined();
  });

  it('treats a user-supplied value as trusted', () => {
    const value = taint('user@example.test', { source: 'user' });
    expect(isTainted(value)).toBe(false);
  });

  it('trusts a value explicitly', () => {
    const value = taint('x', { source: 'page-text' });
    expect(isTainted(value)).toBe(true);
    trust(value);
    expect(isTainted(value)).toBe(false);
  });

  it('keeps a derived value tainted', () => {
    const source = taint('attacker@evil.test', {
      source: 'page-text',
      origin: 'https://evil.test',
    });
    const derived = derive('attacker@evil.test', [source], {
      source: 'model-output',
    });
    expect(isTainted(derived)).toBe(true);
    expect(provenanceOf(derived)?.source).toBe('model-output');
  });

  it('records what a derived value came from', () => {
    const source = taint('secret', { source: 'page-text' });
    const derived = derive('secret again', [source], { source: 'model-output' });
    const record = provenanceOf(derived);
    expect(record?.derivedFrom).toBeDefined();
    expect(record?.derivedFrom?.length).toBe(1);
  });

  it('clears taint through a deterministic validator', () => {
    const value = taint('INBOX', { source: 'page-text' });
    const result = narrow(value, enumValidator(['inbox', 'archive']));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('inbox');
      expect(isTainted(result.value)).toBe(false);
    }
  });

  it('refuses to clear taint when the validator rejects the value', () => {
    const value = taint('nonsense', { source: 'page-text' });
    const result = narrow(value, enumValidator(['inbox']));
    expect(result.ok).toBe(false);
    expect(isTainted(value)).toBe(true);
  });

  it('clears taint through a numeric validator', () => {
    const value = taint('1234', { source: 'page-text' });
    const result = narrow(value, numericValidator());
    expect(result.ok).toBe(true);
    if (result.ok) expect(isTainted(result.value)).toBe(false);
  });

  it('rejects a non-numeric value with the numeric validator', () => {
    const value = taint('abc', { source: 'page-text' });
    expect(narrow(value, numericValidator()).ok).toBe(false);
  });

  it('clears taint through an explicit approval', () => {
    const value = taint('attacker@evil.test', { source: 'page-text' });
    approveTaint(value, 'operator@example.test');
    expect(isTainted(value)).toBe(false);
  });

  it('allows an untainted value at every sink', () => {
    const sinks: TaintSink[] = [
      'cross-origin-navigation',
      'password-field',
      'card-field',
      'otp-field',
      'email-recipient-field',
      'file-path',
      'shell',
      'eval',
      'message-body',
    ];
    for (const sink of sinks) {
      expect(checkSink('safe value', sink).allowed).toBe(true);
    }
  });

  it('refuses a tainted value at every sink', () => {
    const sinks: TaintSink[] = [
      'cross-origin-navigation',
      'password-field',
      'card-field',
      'otp-field',
      'email-recipient-field',
      'file-path',
      'shell',
      'eval',
      'message-body',
    ];
    for (const sink of sinks) {
      const value = taint(`tainted for ${sink}`, {
        source: 'page-text',
        origin: 'https://evil.test',
      });
      const check = checkSink(value, sink);
      expect(check.allowed).toBe(false);
      expect(check.allowed === false ? check.ruleId : '').toBe(`taint.${sink}`);
      expect(check.allowed === false ? check.reason : '').toContain('https://evil.test');
    }
  });

  it('allows a tainted value at a sink once it has been approved', () => {
    const value = taint('attacker@evil.test', { source: 'page-text' });
    approveTaint(value, 'operator');
    expect(checkSink(value, 'password-field').allowed).toBe(true);
  });

  it('maps a password field to the password sink', () => {
    expect(sinkForField({ inputType: 'password' })).toBe('password-field');
  });

  it('maps a file field to the file-path sink', () => {
    expect(sinkForField({ inputType: 'file' })).toBe('file-path');
  });

  it('maps an OTP field to the otp sink', () => {
    expect(sinkForField({ role: 'textbox', name: 'One-time code' })).toBe('otp-field');
    expect(sinkForField({ role: 'textbox', name: 'Verification code' })).toBe('otp-field');
    expect(sinkForField({ role: 'textbox', name: '2FA code' })).toBe('otp-field');
    expect(sinkForField({ role: 'textbox', name: 'PIN' })).toBe('otp-field');
  });

  it('maps a card field to the card sink', () => {
    expect(sinkForField({ role: 'textbox', name: 'Card number' })).toBe('card-field');
    expect(sinkForField({ role: 'textbox', name: 'CVV' })).toBe('card-field');
    expect(sinkForField({ role: 'textbox', name: 'Expiry date' })).toBe('card-field');
    expect(sinkForField({ role: 'textbox', name: 'IBAN' })).toBe('card-field');
  });

  it('maps an email recipient field to the recipient sink', () => {
    expect(sinkForField({ role: 'textbox', name: 'Recipient' })).toBe('email-recipient-field');
    expect(sinkForField({ role: 'textbox', name: 'Email to' })).toBe('email-recipient-field');
    expect(sinkForField({ role: 'textbox', name: 'Cc' })).toBe('email-recipient-field');
  });

  it('maps an ordinary field to no sink', () => {
    expect(sinkForField({ role: 'textbox', name: 'Search' })).toBeUndefined();
    expect(sinkForField({})).toBeUndefined();
  });
});
