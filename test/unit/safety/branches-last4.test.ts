/**
 * The last four safety branches.
 */
import { describe, expect, it } from 'vitest';
import { renderDryRunReport } from '../../../src/safety/dryrun.js';
import { redactHar, type HarLog } from '../../../src/safety/har.js';
import { detectLoginWall } from '../../../src/safety/compliance/captcha-detect.js';
import { RateLimiter } from '../../../src/safety/compliance/ratelimit.js';
import { Redactor } from '../../../src/safety/redact.js';

describe('the dry-run report: a header key with no value', () => {
  it('renders an empty value rather than "undefined"', () => {
    // The header map is built from `Object.keys`, so a key always has a
    // value. The fallback exists for a hand-built record.
    const report = renderDryRunReport([
      {
        method: 'POST',
        url: 'https://example.test/api',
        headers: {},
        bodyPreview: '',
        hasBody: false,
        capturedAt: 'now',
        resourceType: 'fetch',
      },
    ]);
    expect(report).not.toContain('undefined');
  });
});

describe('the HAR redactor: a header the redactor drops', () => {
  it('keeps the original value', () => {
    // A redactor that returns an empty map for this header.
    const redactor = {
      redactHeaders: () => ({}),
      redactUrl: (url: string) => url,
      redactBody: (body: string) => body,
    };
    const log: HarLog = {
      log: {
        version: '1.2',
        creator: { name: 'x', version: '1' },
        pages: [],
        entries: [
          {
            request: {
              method: 'GET',
              url: 'https://example.test/',
              headers: [{ name: 'x-dropped', value: 'original' }],
            },
            response: { status: 200, headers: [] },
          },
        ],
      },
    };
    const redacted = redactHar(log, redactor);
    const entry = redacted.log.entries[0];
    expect(entry?.request.headers?.[0]?.value).toBe('original');
  });

  it('uses the redacted value when the redactor provides one', () => {
    const redactor = new Redactor();
    redactor.add('token', 'abc123');
    const log: HarLog = {
      log: {
        version: '1.2',
        creator: { name: 'x', version: '1' },
        pages: [],
        entries: [
          {
            request: {
              method: 'GET',
              url: 'https://example.test/',
              headers: [{ name: 'x-token', value: 'abc123' }],
            },
            response: { status: 200, headers: [] },
          },
        ],
      },
    };
    const redacted = redactHar(log, redactor);
    const entry = redacted.log.entries[0];
    expect(entry?.request.headers?.[0]?.value).not.toBe('abc123');
  });
});

describe('the challenge detector: the button-name fallback', () => {
  it('flags a password field with a submit button', () => {
    const challenge = detectLoginWall({
      text: 'Welcome back',
      hasPasswordField: true,
      buttonNames: ['Submit'],
    });
    expect(challenge?.kind).toBe('login-wall');
  });

  it('flags a password field with a log in button', () => {
    const challenge = detectLoginWall({
      text: 'Welcome back',
      hasPasswordField: true,
      buttonNames: ['Log in'],
    });
    expect(challenge?.kind).toBe('login-wall');
  });

  it('does not flag a password field whose only button is unrelated', () => {
    // The wording check already passed ("Sign in to continue"), so this
    // exercises the password-field branch's negative side directly.
    expect(
      detectLoginWall({
        text: 'Nothing to see here',
        hasPasswordField: true,
        buttonNames: ['Cancel', 'Back'],
      }),
    ).toBeUndefined();
  });

  it('does not flag a page with no password field at all', () => {
    // `hasPasswordField` is unknown rather than false: the wording check
    // found nothing, so there is no login wall.
    expect(detectLoginWall({ text: 'Nothing to see here' })).toBeUndefined();
    expect(
      detectLoginWall({ text: 'Nothing to see here', hasPasswordField: false }),
    ).toBeUndefined();
  });
});

describe('the rate limiter: the default wait', () => {
  it('actually sleeps when it has to', async () => {
    // The default `wait` uses a real timer. With a one-request-per-second
    // limit, the second acquire waits about a second.
    const limiter = new RateLimiter({ maxRpsPerDomain: 1, jitterMs: { min: 0, max: 0 } });
    await limiter.acquire('a.test');
    const started = Date.now();
    await limiter.acquire('a.test');
    const elapsed = Date.now() - started;
    // The wait is at least a few hundred milliseconds; the exact value
    // depends on the clock, so the assertion is loose.
    expect(elapsed).toBeGreaterThan(100);
  });
});
