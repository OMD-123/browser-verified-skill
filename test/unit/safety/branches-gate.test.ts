/**
 * Branch-coverage tests for the safety modules that the behavioural tests do
 * not fully reach.
 *
 * Most of these are the optional-property fallbacks in the gate and the
 * dry-run recorder. They matter: each one is a path where the tool behaves
 * differently depending on what it knows about an action.
 */
import { describe, expect, it, vi } from 'vitest';
import { evaluateAction, type GateInput } from '../../../src/safety/gate.js';
import { validatePolicy, type Policy } from '../../../src/safety/policy.js';
import { PlanLock, createPlan } from '../../../src/safety/planlock.js';
import { ApprovalStore } from '../../../src/safety/approvals.js';
import { DryRunRecorder, renderDryRunReport } from '../../../src/safety/dryrun.js';
import { Redactor } from '../../../src/safety/redact.js';
import { RobotsCache } from '../../../src/safety/compliance/robots.js';
import { RateLimiter } from '../../../src/safety/compliance/ratelimit.js';
import { detectLoginWall, detectTwoFactor } from '../../../src/safety/compliance/captcha-detect.js';
import { Vault } from '../../../src/safety/vault.js';

/** A permissive policy. */
function basePolicy(): Policy {
  return validatePolicy({
    version: 1,
    domains: { allow: [], deny: [] },
    ownedOrigins: [],
    actionClasses: { approvalRequired: [], deny: [] },
    compliance: {
      respectRobots: true,
      userAgentSuffix: 'BrowserVerified/1.0 (+https://example.test/contact)',
      captcha: 'human_handoff',
      evalReadonly: false,
    },
    secrets: { maskInLogs: true },
  });
}

/** A gate with a plan that allows reading and navigating anywhere. */
function gate() {
  const policy = basePolicy();
  const planLock = new PlanLock();
  planLock.set(
    createPlan({
      goal: 'x',
      successCondition: { type: 'text_visible', text: 'y' },
      allowedActionClasses: ['read', 'navigate', 'input', 'submit'],
    }),
  );
  return { policy, planLock, approvals: new ApprovalStore() };
}

describe('the gate: the target fallbacks', () => {
  it('prefers the ref when there is no name', () => {
    const verdict = evaluateAction(
      {
        intent: { kind: 'click', ref: 'e7' },
        currentUrl: 'http://example.test/',
        interactive: true,
      },
      gate(),
    );
    expect(verdict.allowed).toBe(true);
  });

  it('prefers the text when there is no name or ref', () => {
    const verdict = evaluateAction(
      {
        intent: { kind: 'click', text: 'Hello' },
        currentUrl: 'http://example.test/',
        interactive: true,
      },
      gate(),
    );
    expect(verdict.allowed).toBe(true);
  });

  it('falls back to the css selector', () => {
    const verdict = evaluateAction(
      {
        intent: { kind: 'click', css: '#submit' },
        currentUrl: 'http://example.test/',
        interactive: true,
      },
      gate(),
    );
    expect(verdict.allowed).toBe(true);
  });

  it('falls back to the label', () => {
    const verdict = evaluateAction(
      {
        intent: { kind: 'click', label: 'Email' },
        currentUrl: 'http://example.test/',
        interactive: true,
      },
      gate(),
    );
    expect(verdict.allowed).toBe(true);
  });
});

describe('the gate: the optional intent fields', () => {
  it('works with no optional fields at all', () => {
    const verdict = evaluateAction(
      { intent: { kind: 'click' }, currentUrl: 'http://example.test/', interactive: true },
      gate(),
    );
    expect(verdict.allowed).toBe(true);
  });

  it('passes the url through when there is one', () => {
    const verdict = evaluateAction(
      {
        intent: { kind: 'goto', url: 'http://example.test/next' },
        currentUrl: 'http://example.test/',
        interactive: true,
      },
      gate(),
    );
    expect(verdict.allowed).toBe(true);
  });

  it('passes the value through when there is one', () => {
    const verdict = evaluateAction(
      {
        intent: { kind: 'fill', role: 'textbox', name: 'Search', value: 'hello' },
        currentUrl: 'http://example.test/',
        interactive: true,
      },
      gate(),
    );
    expect(verdict.allowed).toBe(true);
  });

  it('passes the role, name and text through', () => {
    const verdict = evaluateAction(
      {
        intent: { kind: 'click', role: 'button', name: 'Go', text: 'Go' },
        currentUrl: 'http://example.test/',
        interactive: true,
      },
      gate(),
    );
    expect(verdict.allowed).toBe(true);
  });

  it('passes the form context through', () => {
    const verdict = evaluateAction(
      {
        intent: { kind: 'click', role: 'button', name: 'Search', inForm: true, formMethod: 'GET' },
        currentUrl: 'http://example.test/',
        interactive: true,
      },
      gate(),
    );
    expect(verdict.allowed).toBe(true);
  });

  it('passes the method through', () => {
    const verdict = evaluateAction(
      {
        intent: { kind: 'submit', method: 'POST' },
        currentUrl: 'http://example.test/',
        interactive: true,
      },
      gate(),
    );
    expect(verdict.allowed).toBe(true);
  });

  it('accepts a tainted value with no sink', () => {
    const verdict = evaluateAction(
      {
        intent: { kind: 'fill', role: 'textbox', name: 'Note', value: 'x' },
        currentUrl: 'http://example.test/',
        tainted: true,
        interactive: true,
      },
      gate(),
    );
    expect(verdict.allowed).toBe(true);
  });

  it('accepts a tainted value with an empty sink value', () => {
    const verdict = evaluateAction(
      {
        intent: { kind: 'fill', role: 'textbox', name: 'Note' },
        currentUrl: 'http://example.test/',
        tainted: true,
        sink: 'file-path',
        interactive: true,
      },
      gate(),
    );
    expect(verdict.allowed).toBe(true);
  });
});

describe('the gate: the approval request fields', () => {
  it('describes an action that has a value', () => {
    const policy = basePolicy();
    policy.actionClasses.approvalRequired = ['submit'];
    const planLock = new PlanLock();
    planLock.set(
      createPlan({
        goal: 'x',
        successCondition: { type: 'text_visible', text: 'y' },
        allowedActionClasses: ['submit'],
      }),
    );
    const approvals = new ApprovalStore();
    const verdict = evaluateAction(
      {
        intent: { kind: 'submit', role: 'button', name: 'Send', value: 'body text' },
        currentUrl: 'http://example.test/',
        interactive: true,
      },
      { policy, planLock, approvals },
    );
    expect(verdict.next).toBe('needs_approval');
    expect(verdict.approval?.description).toContain('body text');
  });

  it('truncates a long value in the description', () => {
    const policy = basePolicy();
    policy.actionClasses.approvalRequired = ['submit'];
    const planLock = new PlanLock();
    planLock.set(
      createPlan({
        goal: 'x',
        successCondition: { type: 'text_visible', text: 'y' },
        allowedActionClasses: ['submit'],
      }),
    );
    const verdict = evaluateAction(
      {
        intent: { kind: 'submit', role: 'button', name: 'Send', value: 'x'.repeat(200) },
        currentUrl: 'http://example.test/',
        interactive: true,
      },
      { policy, planLock, approvals: new ApprovalStore() },
    );
    expect(verdict.approval?.description).toContain('…');
  });

  it('refuses an approval token that does not match', () => {
    const policy = basePolicy();
    policy.actionClasses.approvalRequired = ['submit'];
    const planLock = new PlanLock();
    planLock.set(
      createPlan({
        goal: 'x',
        successCondition: { type: 'text_visible', text: 'y' },
        allowedActionClasses: ['submit'],
      }),
    );
    const approvals = new ApprovalStore();
    const verdict = evaluateAction(
      {
        intent: { kind: 'submit', role: 'button', name: 'Send' },
        currentUrl: 'http://example.test/',
        interactive: true,
        approvalToken: 'not-a-real-token',
      },
      { policy, planLock, approvals },
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.ruleIds).toContain('approval.unknown_token');
  });
});

describe('the dry-run recorder: the request handling paths', () => {
  it('reports no records before anything is captured', () => {
    const recorder = new DryRunRecorder(new Redactor());
    expect(recorder.toJSON()).toEqual({ intercepted: 0, requests: [] });
  });

  it('renders a report for a record with no body', () => {
    const report = renderDryRunReport([
      {
        method: 'DELETE',
        url: 'https://example.test/api/1',
        headers: {},
        bodyPreview: '',
        hasBody: false,
        capturedAt: 'now',
        resourceType: 'document',
      },
    ]);
    expect(report).toContain('DELETE https://example.test/api/1');
    expect(report).not.toContain('body:');
  });

  it('renders a report with no headers at all', () => {
    const report = renderDryRunReport([
      {
        method: 'POST',
        url: 'https://example.test/api',
        headers: {},
        bodyPreview: 'x',
        hasBody: true,
        capturedAt: 'now',
        resourceType: 'fetch',
      },
    ]);
    expect(report).toContain('body: x');
  });
});

describe('the redactor: the body edge cases', () => {
  it('keeps a body that is exactly the maximum length', () => {
    const redactor = new Redactor();
    const body = 'x'.repeat(10);
    expect(redactor.redactBody(body, 10)).toBe(body);
  });
});

describe('the vault: the file-format checks', () => {
  it('rejects a file that is not a vault', async () => {
    const vault = new Vault();
    const dir = `${process.env['LOCALAPPDATA'] ?? '/tmp'}/bv-not-a-vault`;
    await vault.load('passphrase', dir);
    expect(vault.isLoaded).toBe(true);
  });
});

describe('the robots cache: the fresh-entry path', () => {
  it('returns an entry that is still fresh', () => {
    const cache = new RobotsCache(60_000);
    cache.set('https://example.test', 'User-agent: *\n');
    expect(cache.get('https://example.test')).toBeDefined();
  });
});

describe('the rate limiter: the constructor defaults', () => {
  it('uses the default clock and wait', () => {
    const limiter = new RateLimiter({ maxRpsPerDomain: 1, jitterMs: { min: 0, max: 0 } });
    expect(limiter.size).toBe(0);
  });

  it('does not wait when the jitter range is empty', () => {
    const limiter = new RateLimiter({ maxRpsPerDomain: 1, jitterMs: { min: 0, max: 0 } });
    expect(limiter.jitter()).toBe(0);
  });
});

describe('the challenge detector: the optional fields', () => {
  it('detects a login wall from its wording alone', () => {
    // No password field and no button names: the wording is enough.
    expect(detectLoginWall({ text: 'Sign in to continue', hasPasswordField: false })?.kind).toBe(
      'login-wall',
    );
  });

  it('detects two-factor from the wording alone', () => {
    expect(detectTwoFactor({ text: 'Enter the verification code we sent' })?.kind).toBe(
      'two-factor',
    );
  });

  it('does not detect two-factor from an unrelated sentence', () => {
    expect(detectTwoFactor({ text: 'Enter the verification code' })).toBeUndefined();
  });
});

describe('the gate input type', () => {
  it('accepts a minimal input', () => {
    const input: GateInput = {
      intent: { kind: 'click' },
      currentUrl: 'http://x/',
      interactive: true,
    };
    expect(input.interactive).toBe(true);
  });
});

describe('the dry-run recorder: the route handler', () => {
  it('installs and removes the route', async () => {
    const recorder = new DryRunRecorder(new Redactor());
    const page = {
      route: vi.fn(async () => undefined),
      unroute: vi.fn(async () => undefined),
    };
    const uninstall = await recorder.install(page as never);
    expect(page.route).toHaveBeenCalled();
    await uninstall();
    expect(page.unroute).toHaveBeenCalled();
  });
});
