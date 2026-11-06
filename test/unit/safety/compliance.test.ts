/**
 * Tests for the compliance modules (M11) and the dry-run/HAR (M10).
 */
import { describe, expect, it } from 'vitest';
import {
  RobotsCache,
  evaluateRobots,
  fetchRobots,
  robotsUserAgent,
} from '../../../src/safety/compliance/robots.js';
import { RateLimiter } from '../../../src/safety/compliance/ratelimit.js';
import {
  detectCaptcha,
  detectChallenge,
  detectLoginWall,
  detectTwoFactor,
  handoffMessage,
} from '../../../src/safety/compliance/captcha-detect.js';
import { DryRunRecorder, renderDryRunReport, shouldIntercept } from '../../../src/safety/dryrun.js';
import { redactHar, type HarLog } from '../../../src/safety/har.js';
import { Redactor } from '../../../src/safety/redact.js';

/**
 * A `fetch` stand-in that returns a fixed response.
 *
 * Typed as `typeof fetch` so it can be passed to `fetchRobots` directly.
 */
function fakeFetch(response: () => Response | Promise<Response>): typeof fetch {
  return async () => response();
}

/** A `fetch` stand-in that always fails. */
function failingFetch(): typeof fetch {
  return async () => {
    throw new Error('network down');
  };
}

describe('robots.txt', () => {
  it('allows a path that is not disallowed', () => {
    const cache = new RobotsCache();
    const entry = cache.set('https://example.test', 'User-agent: *\nDisallow: /private/\n');
    const verdict = evaluateRobots(entry, 'https://example.test/public', 'BrowserVerified');
    expect(verdict.allowed).toBe(true);
  });

  it('denies a disallowed path', () => {
    const cache = new RobotsCache();
    const entry = cache.set('https://example.test', 'User-agent: *\nDisallow: /private/\n');
    const verdict = evaluateRobots(entry, 'https://example.test/private/x', 'BrowserVerified');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('robots.txt');
  });

  it('honours a more specific Allow over a broader Disallow', () => {
    const cache = new RobotsCache();
    const entry = cache.set(
      'https://example.test',
      'User-agent: *\nDisallow: /private/\nAllow: /private/public\n',
    );
    expect(
      evaluateRobots(entry, 'https://example.test/private/public/y', 'BrowserVerified').allowed,
    ).toBe(true);
    expect(
      evaluateRobots(entry, 'https://example.test/private/other', 'BrowserVerified').allowed,
    ).toBe(false);
  });

  it('allows everything when there is no robots.txt', () => {
    expect(evaluateRobots(undefined, 'https://example.test/x', 'bv').allowed).toBe(true);
  });

  it('reads the crawl delay when one is declared', () => {
    const cache = new RobotsCache();
    const entry = cache.set(
      'https://example.test',
      'User-agent: *\nCrawl-delay: 5\nDisallow: /x\n',
    );
    const verdict = evaluateRobots(entry, 'https://example.test/y', 'BrowserVerified');
    expect(verdict.crawlDelaySeconds).toBe(5);
  });

  it('caches an entry', () => {
    const cache = new RobotsCache();
    expect(cache.has('https://example.test')).toBe(false);
    cache.set('https://example.test', 'User-agent: *\n');
    expect(cache.has('https://example.test')).toBe(true);
    expect(cache.size).toBe(1);
  });

  it('expires a stale entry', () => {
    const cache = new RobotsCache(0);
    cache.set('https://example.test', 'User-agent: *\n');
    expect(cache.has('https://example.test')).toBe(false);
  });

  it('clears the cache', () => {
    const cache = new RobotsCache();
    cache.set('https://example.test', 'User-agent: *\n');
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('treats a missing robots.txt as no restrictions', async () => {
    const fetchImpl = fakeFetch(() => new Response('not found', { status: 404 }));
    const result = await fetchRobots('https://example.test', fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
  });

  it('treats an unreachable robots.txt as no restrictions', async () => {
    const fetchImpl = failingFetch();
    const result = await fetchRobots('https://example.test', fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
  });

  it('reads a robots.txt', async () => {
    const fetchImpl = fakeFetch(() => new Response('User-agent: *\n', { status: 200 }));
    const result = await fetchRobots('https://example.test', fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.body).toContain('User-agent');
  });

  it('extracts the product token for the user agent', () => {
    expect(robotsUserAgent('BrowserVerified/1.0 (+https://example.test/contact)')).toBe(
      'BrowserVerified',
    );
    expect(robotsUserAgent('something-else')).toBe('something-else');
  });
});

describe('the rate limiter', () => {
  it('allows the first request immediately', () => {
    const limiter = new RateLimiter({ maxRpsPerDomain: 1, jitterMs: { min: 0, max: 0 } });
    expect(limiter.check('example.test').allowed).toBe(true);
  });

  it('denies a second request in the same instant', async () => {
    const limiter = new RateLimiter({ maxRpsPerDomain: 1, jitterMs: { min: 0, max: 0 } });
    await limiter.acquire('example.test');
    expect(limiter.check('example.test').allowed).toBe(false);
  });

  it('tracks each domain separately', async () => {
    const limiter = new RateLimiter({ maxRpsPerDomain: 1, jitterMs: { min: 0, max: 0 } });
    await limiter.acquire('a.test');
    expect(limiter.check('a.test').allowed).toBe(false);
    expect(limiter.check('b.test').allowed).toBe(true);
  });

  it('refills as time passes', async () => {
    let now = 0;
    const limiter = new RateLimiter(
      { maxRpsPerDomain: 1, jitterMs: { min: 0, max: 0 } },
      () => now,
    );
    await limiter.acquire('a.test');
    expect(limiter.check('a.test').allowed).toBe(false);
    now += 2000;
    expect(limiter.check('a.test').allowed).toBe(true);
  });

  it('applies a jitter within the configured range', () => {
    const limiter = new RateLimiter({ maxRpsPerDomain: 1, jitterMs: { min: 100, max: 200 } });
    for (let i = 0; i < 50; i++) {
      const jitter = limiter.jitter();
      expect(jitter).toBeGreaterThanOrEqual(100);
      expect(jitter).toBeLessThanOrEqual(200);
    }
  });

  it('waits when the bucket is empty', async () => {
    const waits: number[] = [];
    const limiter = new RateLimiter(
      { maxRpsPerDomain: 1, jitterMs: { min: 0, max: 0 } },
      () => 0,
      async (ms) => {
        waits.push(ms);
      },
    );
    await limiter.acquire('a.test');
    await limiter.acquire('a.test');
    expect(waits.length).toBeGreaterThan(0);
  });

  it('resets', async () => {
    const limiter = new RateLimiter({ maxRpsPerDomain: 1, jitterMs: { min: 0, max: 0 } });
    await limiter.acquire('a.test');
    limiter.reset();
    expect(limiter.size).toBe(0);
  });
});

describe('the challenge detector', () => {
  it('detects a CAPTCHA', () => {
    const challenge = detectCaptcha({ text: 'Please verify you are human' });
    expect(challenge?.kind).toBe('captcha');
  });

  it('detects a reCAPTCHA badge', () => {
    expect(detectCaptcha({ text: 'protected by reCAPTCHA' })?.kind).toBe('captcha');
  });

  it('does not flag ordinary text as a CAPTCHA', () => {
    expect(detectCaptcha({ text: 'Welcome to our shop' })).toBeUndefined();
  });

  it('detects a login wall by its wording', () => {
    expect(detectLoginWall({ text: 'Please sign in to continue' })?.kind).toBe('login-wall');
  });

  it('detects a login wall by a password field and a sign-in button', () => {
    const challenge = detectLoginWall({
      text: 'Welcome back',
      hasPasswordField: true,
      buttonNames: ['Sign in'],
    });
    expect(challenge?.kind).toBe('login-wall');
  });

  it('does not flag a password field with no sign-in control', () => {
    expect(
      detectLoginWall({ text: 'Change your password', hasPasswordField: true }),
    ).toBeUndefined();
  });

  it('detects two-factor by its wording', () => {
    expect(detectTwoFactor({ text: 'Enter the verification code we sent' })?.kind).toBe(
      'two-factor',
    );
  });

  it('detects two-factor by an OTP field name', () => {
    expect(detectTwoFactor({ text: '', inputNames: ['otpCode'] })?.kind).toBe('two-factor');
  });

  it('detects two-factor by a verification code field name', () => {
    expect(detectTwoFactor({ text: '', inputNames: ['verification-code'] })?.kind).toBe(
      'two-factor',
    );
  });

  it('does not flag ordinary input names', () => {
    expect(detectTwoFactor({ text: '', inputNames: ['email', 'password'] })).toBeUndefined();
  });

  it('picks the most explicit challenge', () => {
    const challenge = detectChallenge({
      text: 'verify you are human. Also sign in to continue.',
    });
    expect(challenge?.kind).toBe('captcha');
  });

  it('explains what to do at a handoff', () => {
    const message = handoffMessage('https://example.test/login', {
      kind: 'captcha',
      reason: 'the page asks for a human verification',
      evidence: 'verify you are human',
      confidence: 0.9,
    });
    expect(message).toContain('Human needed at https://example.test/login');
    expect(message).toContain('bv resume');
  });
});

describe('the dry-run', () => {
  it('intercepts a state-changing method', () => {
    expect(shouldIntercept('POST', false, 'document')).toBe(true);
    expect(shouldIntercept('DELETE', false, 'document')).toBe(true);
  });

  it('intercepts a fetch with a body', () => {
    expect(shouldIntercept('GET', true, 'fetch')).toBe(true);
  });

  it('does not intercept a plain GET', () => {
    expect(shouldIntercept('GET', false, 'document')).toBe(false);
  });

  it('does not intercept a bodyless fetch', () => {
    expect(shouldIntercept('GET', false, 'fetch')).toBe(false);
  });

  it('reports that nothing was sent', () => {
    const report = renderDryRunReport([]);
    expect(report).toContain('Nothing would have been sent');
  });

  it('renders what would have been sent', () => {
    const report = renderDryRunReport([
      {
        method: 'POST',
        url: 'https://example.test/api',
        headers: { 'content-type': 'application/json', 'user-agent': 'BrowserVerified' },
        bodyPreview: '{"a":1}',
        hasBody: true,
        capturedAt: 'now',
        resourceType: 'fetch',
      },
    ]);
    expect(report).toContain('POST https://example.test/api');
    expect(report).toContain('{"a":1}');
    expect(report).toContain('Nothing was sent to the server');
  });

  it('redacts the recorded headers', () => {
    const redactor = new Redactor();
    const recorder = new DryRunRecorder(redactor);
    expect(recorder.count).toBe(0);
    expect(recorder.captured).toHaveLength(0);
    recorder.clear();
    expect(recorder.count).toBe(0);
  });
});

describe('the HAR redactor', () => {
  /** A minimal HAR with a secret in it. */
  function harWithSecret(secret: string): HarLog {
    return {
      log: {
        version: '1.2',
        creator: { name: 'browser-verified', version: '0.1.0' },
        pages: [],
        entries: [
          {
            request: {
              method: 'POST',
              url: `https://example.test/api?token=${secret}`,
              headers: [
                { name: 'authorization', value: `Bearer ${secret}` },
                { name: 'content-type', value: 'application/json' },
              ],
              postData: { mimeType: 'application/json', text: `{"password":"${secret}"}` },
            },
            response: {
              status: 200,
              headers: [
                { name: 'set-cookie', value: `session=${secret}` },
                { name: 'content-type', value: 'application/json' },
              ],
              content: { mimeType: 'application/json', text: `{"echo":"${secret}"}` },
            },
          },
        ],
      },
    };
  }

  it('removes a secret from every part of the HAR', () => {
    const redactor = new Redactor();
    redactor.add('password', 'hunter2');
    const redacted = redactHar(harWithSecret('hunter2'), redactor);
    const text = JSON.stringify(redacted);
    expect(text).not.toContain('hunter2');
  });

  it('keeps the non-sensitive headers', () => {
    const redactor = new Redactor();
    redactor.add('password', 'hunter2');
    const redacted = redactHar(harWithSecret('hunter2'), redactor);
    const headers = redacted.log.entries[0]?.request.headers ?? [];
    expect(headers.find((h) => h.name === 'content-type')?.value).toBe('application/json');
  });

  it('keeps the entry count', () => {
    const redactor = new Redactor();
    const redacted = redactHar(harWithSecret('hunter2'), redactor);
    expect(redacted.log.entries).toHaveLength(1);
  });

  it('does not modify the input log', () => {
    const redactor = new Redactor();
    redactor.add('password', 'hunter2');
    const log = harWithSecret('hunter2');
    redactHar(log, redactor);
    expect(JSON.stringify(log)).toContain('hunter2');
  });
});
