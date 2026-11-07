/**
 * The last safety branch-coverage tests.
 *
 * These cover the remaining defensive paths in the gate, the HAR redactor,
 * the redactor and the challenge detector.
 */
import { describe, expect, it } from 'vitest';
import { evaluateAction } from '../../../src/safety/gate.js';
import { validatePolicy, type Policy } from '../../../src/safety/policy.js';
import { PlanLock, createPlan } from '../../../src/safety/planlock.js';
import { ApprovalStore } from '../../../src/safety/approvals.js';
import { redactHar, type HarLog } from '../../../src/safety/har.js';
import { Redactor, redactError } from '../../../src/safety/redact.js';
import { detectLoginWall, detectChallenge } from '../../../src/safety/compliance/captcha-detect.js';
import { RateLimiter } from '../../../src/safety/compliance/ratelimit.js';
import { RobotsCache, evaluateRobots } from '../../../src/safety/compliance/robots.js';

/** A policy whose approval list is empty. */
function permissivePolicy(): Policy {
  return validatePolicy({
    version: 1,
    domains: { allow: [], deny: [] },
    ownedOrigins: [],
    actionClasses: { approvalRequired: [], deny: [] },
    compliance: {
      respectRobots: true,
      userAgentSuffix: 'BrowserVerifiedSkill/1.0 (+https://example.test/contact)',
      captcha: 'human_handoff',
      evalReadonly: false,
    },
    secrets: { maskInLogs: true },
  });
}

describe('the gate: the empty-rule-list path', () => {
  it('adds the default approval reason when the policy gives no reason', () => {
    // The policy requires approval for the class but the evaluator records
    // no rule id, so the gate supplies its own.
    const policy = permissivePolicy();
    policy.actionClasses.approvalRequired = ['read'];
    const planLock = new PlanLock();
    planLock.set(
      createPlan({
        goal: 'x',
        successCondition: { type: 'text_visible', text: 'y' },
        allowedActionClasses: ['read'],
      }),
    );
    const verdict = evaluateAction(
      {
        intent: { kind: 'click', role: 'paragraph' },
        currentUrl: 'http://example.test/',
        interactive: true,
      },
      { policy, planLock, approvals: new ApprovalStore() },
    );
    expect(verdict.next).toBe('needs_approval');
    expect(verdict.reasons.join(' ')).toContain('requires approval');
  });
});

describe('the HAR redactor: the header value fallback', () => {
  it('keeps the original value when the redactor does not return the header', () => {
    const redactor = new Redactor();
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
              headers: [{ name: 'x-header', value: 'value' }],
            },
            response: { status: 200, headers: [] },
          },
        ],
      },
    };
    const redacted = redactHar(log, redactor);
    const entry = redacted.log.entries[0];
    expect(entry?.request.headers?.[0]?.value).toBe('value');
  });
});

describe('the redactor: the error fallback', () => {
  it('masks a string that is not an Error', () => {
    const redactor = new Redactor();
    redactor.add('password', 'hunter2');
    expect(redactError('failed with hunter2', redactor)).not.toContain('hunter2');
  });
});

describe('the challenge detector: the password-field path', () => {
  it('does not flag a password field with no submit control', () => {
    expect(
      detectLoginWall({
        text: 'Change your password',
        hasPasswordField: true,
        buttonNames: ['Cancel'],
      }),
    ).toBeUndefined();
  });

  it('does not flag a password field with no button names at all', () => {
    expect(
      detectLoginWall({ text: 'Change your password', hasPasswordField: true }),
    ).toBeUndefined();
  });
});

describe('the challenge detector: the kind precedence', () => {
  it('prefers a CAPTCHA over two-factor and a login wall', () => {
    const challenge = detectChallenge({
      text: 'Verify you are human. Enter the verification code we sent. Sign in to continue.',
    });
    expect(challenge?.kind).toBe('captcha');
  });

  it('prefers two-factor over a login wall', () => {
    const challenge = detectChallenge({
      text: 'Enter the verification code we sent. Sign in to continue.',
    });
    expect(challenge?.kind).toBe('two-factor');
  });

  it('falls back to a login wall', () => {
    const challenge = detectChallenge({ text: 'Sign in to continue' });
    expect(challenge?.kind).toBe('login-wall');
  });
});

describe('the rate limiter: the empty-jitter path', () => {
  it('uses the default clock and wait', async () => {
    const limiter = new RateLimiter({
      maxRpsPerDomain: 1,
      jitterMs: { min: 0, max: 0 },
    });
    await limiter.acquire('a.test');
    expect(limiter.size).toBe(1);
  });
});

describe('the robots evaluation: the crawl-delay path', () => {
  it('includes the crawl delay on a disallowed path', () => {
    const cache = new RobotsCache();
    const entry = cache.set(
      'https://example.test',
      'User-agent: *\nCrawl-delay: 3\nDisallow: /x\n',
    );
    const verdict = evaluateRobots(entry, 'https://example.test/x', 'bv');
    expect(verdict.crawlDelaySeconds).toBe(3);
  });

  it('includes the crawl delay on an allowed path', () => {
    const cache = new RobotsCache();
    const entry = cache.set('https://example.test', 'User-agent: *\nCrawl-delay: 3\n');
    const verdict = evaluateRobots(entry, 'https://example.test/y', 'bv');
    expect(verdict.crawlDelaySeconds).toBe(3);
  });
});
