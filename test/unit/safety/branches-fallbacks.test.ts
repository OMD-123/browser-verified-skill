/**
 * Coverage for the `??` chains in the safety modules.
 *
 * Each of these picks which value identifies an action, so each fallback
 * path is a distinct decision.
 */
import { describe, expect, it } from 'vitest';
import { actionHashFor, describeAction } from '../../../src/safety/gate.js';
import { checkSink, sinkForField, taint, taintRegistry } from '../../../src/safety/taint.js';
import { RobotsCache, evaluateRobots } from '../../../src/safety/compliance/robots.js';
import { RateLimiter } from '../../../src/safety/compliance/ratelimit.js';
import { detectCaptcha, detectLoginWall } from '../../../src/safety/compliance/captcha-detect.js';
import { Redactor } from '../../../src/safety/redact.js';

describe('action hashing: each target fallback', () => {
  it('uses the name when there is one', () => {
    expect(actionHashFor({ kind: 'click', name: 'A', text: 'B', ref: 'e1', css: '#a' })).toBe(
      actionHashFor({ kind: 'click', name: 'A' }),
    );
  });

  it('uses the text when there is no name', () => {
    expect(actionHashFor({ kind: 'click', text: 'B', ref: 'e1', css: '#a' })).toBe(
      actionHashFor({ kind: 'click', text: 'B' }),
    );
  });

  it('uses the ref when there is no name or text', () => {
    expect(actionHashFor({ kind: 'click', ref: 'e1', css: '#a' })).toBe(
      actionHashFor({ kind: 'click', ref: 'e1' }),
    );
  });

  it('uses the css when there is nothing else', () => {
    expect(actionHashFor({ kind: 'click', css: '#a' })).toBe(
      actionHashFor({ kind: 'click', css: '#a' }),
    );
  });

  it('uses an empty target when there is nothing at all', () => {
    expect(actionHashFor({ kind: 'click' })).toBe(actionHashFor({ kind: 'click' }));
  });

  it('hashes the value when there is one', () => {
    expect(actionHashFor({ kind: 'fill', name: 'A', value: 'x' })).not.toBe(
      actionHashFor({ kind: 'fill', name: 'A' }),
    );
  });
});

describe('action description: each target fallback', () => {
  it('describes the name', () => {
    expect(describeAction({ kind: 'click', name: 'A' }, 'read')).toContain('A');
  });

  it('describes the text', () => {
    expect(describeAction({ kind: 'click', text: 'B' }, 'read')).toContain('B');
  });

  it('describes the ref', () => {
    expect(describeAction({ kind: 'click', ref: 'e1' }, 'read')).toContain('e1');
  });

  it('describes the css', () => {
    expect(describeAction({ kind: 'click', css: '#a' }, 'read')).toContain('#a');
  });

  it('describes an unknown target', () => {
    expect(describeAction({ kind: 'click' }, 'read')).toContain('unknown target');
  });

  it('describes a value', () => {
    expect(describeAction({ kind: 'fill', name: 'A', value: 'v' }, 'input')).toContain('v');
  });

  it('describes an empty value', () => {
    expect(describeAction({ kind: 'fill', name: 'A', value: '' }, 'input')).not.toContain('value=');
  });
});

describe('the taint sink: the fallbacks', () => {
  it('allows an untainted value', () => {
    expect(checkSink('plain', 'shell').allowed).toBe(true);
  });

  it('reports the url when there is no origin', () => {
    taintRegistry().clear();
    const value = taint('x', { source: 'page-text', url: 'http://example.test/' });
    const decision = checkSink(value, 'shell');
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false ? decision.reason : '').toContain('http://example.test/');
  });

  it('reports "the page" when there is no provenance at all', () => {
    taintRegistry().clear();
    const value = taint('y', { source: 'page-text' });
    const decision = checkSink(value, 'shell');
    expect(decision.allowed === false ? decision.reason : '').toContain('the page');
  });

  it('classifies a password field by its input type', () => {
    expect(sinkForField({ inputType: 'password' })).toBe('password-field');
  });

  it('classifies a file field by its input type', () => {
    expect(sinkForField({ inputType: 'file' })).toBe('file-path');
  });

  it('classifies an OTP field by its name', () => {
    expect(sinkForField({ role: 'textbox', name: 'Your OTP' })).toBe('otp-field');
  });

  it('classifies a card field by its name', () => {
    expect(sinkForField({ role: 'textbox', name: 'Card number' })).toBe('card-field');
  });

  it('classifies a recipient field by its name', () => {
    expect(sinkForField({ role: 'textbox', name: 'Recipient' })).toBe('email-recipient-field');
  });

  it('returns undefined for a plain field', () => {
    expect(sinkForField({ role: 'textbox', name: 'Nickname' })).toBeUndefined();
  });

  it('returns undefined for a field with no role', () => {
    expect(sinkForField({ name: 'Recipient' })).toBeUndefined();
  });
});

describe('the robots evaluation: the fallbacks', () => {
  it('uses the origin when the rule has no crawl delay', () => {
    const cache = new RobotsCache();
    const entry = cache.set('https://example.test', 'User-agent: *\nDisallow: /x\n');
    const verdict = evaluateRobots(entry, 'https://example.test/x', 'bv');
    expect(verdict.reason).toContain('https://example.test/robots.txt');
    expect(verdict.crawlDelaySeconds).toBeUndefined();
  });

  it('has no crawl delay for an allowed path', () => {
    const cache = new RobotsCache();
    const entry = cache.set('https://example.test', 'User-agent: *\n');
    expect(evaluateRobots(entry, 'https://example.test/y', 'bv').crawlDelaySeconds).toBeUndefined();
  });
});

describe('the rate limiter: the jitter bounds', () => {
  it('returns the minimum when the range is a single value', () => {
    const limiter = new RateLimiter({ maxRpsPerDomain: 1, jitterMs: { min: 42, max: 42 } });
    expect(limiter.jitter()).toBe(42);
  });

  it('returns zero when the range is inverted', () => {
    const limiter = new RateLimiter({ maxRpsPerDomain: 1, jitterMs: { min: 0, max: -5 } });
    expect(limiter.jitter()).toBe(0);
  });
});

describe('the challenge detector: the fallbacks', () => {
  it('uses the title when there is no matching text', () => {
    expect(detectCaptcha({ title: 'Verify you are human', text: '' })?.kind).toBe('captcha');
  });

  it('finds a login wall in the title', () => {
    expect(detectLoginWall({ title: 'Sign in to continue', text: '' })?.kind).toBe('login-wall');
  });
});

describe('the redactor: the header fallback', () => {
  it('keeps a header value when the redactor does not return one', () => {
    const redactor = new Redactor();
    const headers = redactor.redactHeaders({ 'x-weird': 'value' });
    expect(headers['x-weird']).toBe('value');
  });
});
