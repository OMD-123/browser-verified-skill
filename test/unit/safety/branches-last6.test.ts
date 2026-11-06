/**
 * The final safety branch-coverage tests: the last six branches.
 */
import { describe, expect, it } from 'vitest';
import { shouldIntercept, renderDryRunReport } from '../../../src/safety/dryrun.js';
import { evaluateAction } from '../../../src/safety/gate.js';
import { validatePolicy, type Policy } from '../../../src/safety/policy.js';
import { PlanLock, createPlan } from '../../../src/safety/planlock.js';
import { ApprovalStore } from '../../../src/safety/approvals.js';
import { RateLimiter } from '../../../src/safety/compliance/ratelimit.js';
import { taint, taintRegistry } from '../../../src/safety/taint.js';
import { detectLoginWall } from '../../../src/safety/compliance/captcha-detect.js';

describe('the dry-run: the interception rules', () => {
  it('intercepts an XHR request with a body', () => {
    expect(shouldIntercept('GET', true, 'xhr')).toBe(true);
  });

  it('does not intercept a body on a document request', () => {
    // A POST form navigation is intercepted by the method, but a GET
    // document with a body is not.
    expect(shouldIntercept('GET', true, 'document')).toBe(false);
  });

  it('intercepts a lower-case method name', () => {
    expect(shouldIntercept('post', false, 'fetch')).toBe(true);
  });

  it('does not intercept a body on an image request', () => {
    expect(shouldIntercept('GET', true, 'image')).toBe(false);
  });
});

describe('the dry-run report: the header rendering', () => {
  it('skips the headers that are not interesting', () => {
    const report = renderDryRunReport([
      {
        method: 'POST',
        url: 'https://example.test/api',
        headers: {
          accept: 'application/json',
          'accept-language': 'en',
          'user-agent': 'BrowserVerified',
          'accept-encoding': 'gzip',
          'content-type': 'application/json',
        },
        bodyPreview: '',
        hasBody: false,
        capturedAt: 'now',
        resourceType: 'fetch',
      },
    ]);
    expect(report).toContain('content-type');
    expect(report).not.toContain('accept-language');
    expect(report).not.toContain('user-agent');
  });

  it('renders a header with no value', () => {
    const report = renderDryRunReport([
      {
        method: 'POST',
        url: 'https://example.test/api',
        headers: { 'x-empty': '' },
        bodyPreview: '',
        hasBody: false,
        capturedAt: 'now',
        resourceType: 'fetch',
      },
    ]);
    expect(report).toContain('x-empty:');
  });
});

describe('the gate: the default approval reason', () => {
  it('supplies its own reason when the policy records no rule', () => {
    const policy: Policy = validatePolicy({
      version: 1,
      domains: { allow: [], deny: [] },
      ownedOrigins: [],
      actionClasses: { approvalRequired: [], deny: [] },
      compliance: {
        respectRobots: true,
        userAgentSuffix: 'x',
        captcha: 'human_handoff',
        evalReadonly: false,
      },
      secrets: { maskInLogs: true },
    });

    // A tainted value at a sink produces a taint rule, so the policy's own
    // approval rule is not what fires.
    const planLock = new PlanLock();
    planLock.set(
      createPlan({
        goal: 'x',
        successCondition: { type: 'text_visible', text: 'y' },
        allowedActionClasses: ['input'],
      }),
    );

    taintRegistry().clear();
    const value = taint('page-derived', {
      source: 'page-text',
      url: 'http://example.test/',
      origin: 'http://example.test',
    });

    const verdict = evaluateAction(
      {
        intent: { kind: 'fill', role: 'textbox', name: 'Search', value },
        currentUrl: 'http://example.test/',
        tainted: true,
        sink: 'file-path',
        interactive: true,
      },
      { policy, planLock, approvals: new ApprovalStore() },
    );

    expect(verdict.next).toBe('needs_approval');
    expect(verdict.ruleIds.some((id) => id.startsWith('taint.'))).toBe(true);
  });
});

describe('the rate limiter: the default sleep', () => {
  it('uses the real clock and a real sleep by default', () => {
    const limiter = new RateLimiter({ maxRpsPerDomain: 1, jitterMs: { min: 0, max: 0 } });
    expect(limiter.size).toBe(0);
    expect(limiter.check('a.test').allowed).toBe(true);
  });
});

describe('the challenge detector: the button-name fallback', () => {
  it('flags a password field with a Continue button', () => {
    const challenge = detectLoginWall({
      text: 'Welcome back',
      hasPasswordField: true,
      buttonNames: ['Continue'],
    });
    expect(challenge?.kind).toBe('login-wall');
  });
});
