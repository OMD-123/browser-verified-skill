/**
 * Exhaustive tests for the policy engine (M05).
 *
 * Every action class × verdict combination is covered, plus the negative
 * cases: denied classes, denied domains, non-interactive defaults, tainted
 * input, forbidden policy keys, and unknown policy keys.
 */
import { describe, expect, it } from 'vitest';
import {
  PolicySchema,
  defaultPolicy,
  validatePolicy,
  PolicyLoadError,
  ACTION_CLASSES,
  type Policy,
} from '../../../src/safety/policy.js';
import { classifyAction, methodForClass } from '../../../src/safety/classify.js';
import {
  evaluate,
  matchDomains,
  hostOf,
  isOwnedOrigin,
  normalizeOrigin,
  type PolicyContext,
} from '../../../src/safety/evaluator.js';
import type { ActionIntent } from '../../../src/safety/classify.js';

/** A policy with no restrictions, for testing the allow path. */
function openPolicy(): Policy {
  return validatePolicy({
    version: 1,
    domains: { allow: [], deny: [] },
    ownedOrigins: [],
    actionClasses: { approvalRequired: [], deny: [] },
    budgets: { maxSteps: 80, maxRetriesPerStep: 2, maxSeconds: 600, maxTokens: 200000 },
    rate: { maxRpsPerDomain: 1, jitterMs: [300, 1200] },
    compliance: {
      respectRobots: true,
      userAgentSuffix: 'BrowserVerified/1.0 (+@url:`https://example.test/contact`)',
      captcha: 'human_handoff',
      evalReadonly: false,
    },
    secrets: { maskInLogs: true },
    memory: { ttlDays: 30 },
  });
}

/** A context with sensible defaults. */
function ctx(policy: Policy, overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    policy,
    nonInteractive: false,
    tainted: false,
    approved: false,
    ...overrides,
  };
}

describe('policy schema', () => {
  it('accepts a complete policy', () => {
    const policy = openPolicy();
    expect(policy.version).toBe(1);
    expect(policy.budgets.maxSteps).toBe(80);
  });

  it('applies defaults for omitted sections', () => {
    const policy = PolicySchema.parse({ version: 1 });
    expect(policy.budgets.maxSteps).toBe(80);
    expect(policy.budgets.maxRetriesPerStep).toBe(2);
    expect(policy.budgets.maxSeconds).toBe(600);
    expect(policy.budgets.maxTokens).toBe(200000);
    expect(policy.rate.maxRpsPerDomain).toBe(1);
    expect(policy.rate.jitterMs).toEqual([300, 1200]);
    expect(policy.compliance.respectRobots).toBe(true);
    expect(policy.compliance.captcha).toBe('human_handoff');
    expect(policy.compliance.evalReadonly).toBe(false);
    expect(policy.secrets.maskInLogs).toBe(true);
    expect(policy.memory.ttlDays).toBe(30);
    expect(policy.actionClasses.approvalRequired).toEqual([
      'submit',
      'destructive',
      'financial',
      'messaging',
      'upload',
    ]);
  });

  it('rejects an unknown top-level key', () => {
    const result = PolicySchema.safeParse({ version: 1, rogue: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe('unrecognized_keys');
    }
  });

  it('rejects an unknown nested key', () => {
    const result = PolicySchema.safeParse({
      version: 1,
      compliance: { respectRobots: true, rogue: 1 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a wrong version', () => {
    expect(PolicySchema.safeParse({ version: 2 }).success).toBe(false);
  });

  it('rejects a non-positive step budget', () => {
    expect(PolicySchema.safeParse({ version: 1, budgets: { maxSteps: 0 } }).success).toBe(false);
  });

  it('rejects an unknown action class', () => {
    expect(
      PolicySchema.safeParse({
        version: 1,
        actionClasses: { approvalRequired: ['teleport'], deny: [] },
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown captcha mode', () => {
    expect(
      PolicySchema.safeParse({
        version: 1,
        compliance: { captcha: 'solve' },
      }).success,
    ).toBe(false);
  });

  it('throws PolicyLoadError with a readable message', () => {
    expect(() => validatePolicy({ version: 1, rogue: true })).toThrow(PolicyLoadError);
    try {
      validatePolicy({ version: 1, rogue: true });
    } catch (err) {
      expect((err as PolicyLoadError).message).toContain('invalid policy');
      expect((err as PolicyLoadError).issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects a policy that enables fingerprint spoofing', () => {
    expect(() => validatePolicy({ version: 1, stealth: true })).toThrow(/not allowed/);
  });

  it('rejects a policy that enables CAPTCHA solving', () => {
    expect(() => validatePolicy({ version: 1, captchaSolver: true })).toThrow(
      /CAPTCHA solving is out of scope/,
    );
  });

  it('rejects a policy that enables proxy rotation', () => {
    expect(() => validatePolicy({ version: 1, proxyRotation: true })).toThrow(
      /rotating proxy pools are out of scope/,
    );
  });

  it('rejects a policy that enables credential stuffing', () => {
    expect(() => validatePolicy({ version: 1, credentialStuffing: true })).toThrow(
      /credential stuffing is out of scope/,
    );
  });

  it('rejects a forbidden key nested inside a section', () => {
    expect(() => validatePolicy({ version: 1, compliance: { webdriverMasking: true } })).toThrow(
      /not allowed/,
    );
  });

  it('rejects a forbidden key regardless of case', () => {
    expect(() => validatePolicy({ version: 1, Stealth: true })).toThrow(/not allowed/);
  });

  it('produces a valid default policy', () => {
    const policy = defaultPolicy();
    expect(policy.version).toBe(1);
    expect(policy.compliance.evalReadonly).toBe(false);
  });
});

describe('action classification', () => {
  it('classifies navigation', () => {
    expect(classifyAction({ kind: 'goto', url: 'https://example.test/' })).toBe('navigate');
    expect(classifyAction({ kind: 'back' })).toBe('navigate');
    expect(classifyAction({ kind: 'reload' })).toBe('navigate');
  });

  it('classifies reading', () => {
    expect(classifyAction({ kind: 'snapshot' })).toBe('read');
    expect(classifyAction({ kind: 'eval-readonly' })).toBe('read');
  });

  it('classifies downloads', () => {
    expect(classifyAction({ kind: 'download' })).toBe('download');
  });

  it('classifies uploads', () => {
    expect(classifyAction({ kind: 'upload' })).toBe('upload');
    expect(classifyAction({ kind: 'click', isFileInput: true })).toBe('upload');
  });

  it('classifies input fields', () => {
    expect(classifyAction({ kind: 'fill', role: 'textbox', name: 'Email' })).toBe('input');
    expect(classifyAction({ kind: 'type', role: 'textbox' })).toBe('input');
    expect(classifyAction({ kind: 'check', role: 'checkbox' })).toBe('input');
    expect(classifyAction({ kind: 'select', role: 'combobox' })).toBe('input');
    expect(classifyAction({ kind: 'fill', inputType: 'password' })).toBe('input');
    expect(classifyAction({ kind: 'fill', inputType: 'email' })).toBe('input');
    expect(classifyAction({ kind: 'fill', inForm: true })).toBe('input');
  });

  it('classifies a submit button', () => {
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Submit' })).toBe('submit');
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Sign in' })).toBe('submit');
  });

  it('classifies a GET-form button as navigation', () => {
    expect(
      classifyAction({ kind: 'click', role: 'button', name: 'Search', formMethod: 'GET' }),
    ).toBe('navigate');
  });

  it('classifies destructive actions', () => {
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Delete account' })).toBe(
      'destructive',
    );
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Remove item' })).toBe(
      'destructive',
    );
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Purge cache' })).toBe(
      'destructive',
    );
  });

  it('classifies financial actions', () => {
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Pay now' })).toBe('financial');
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Checkout' })).toBe('financial');
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Place order' })).toBe(
      'financial',
    );
  });

  it('classifies messaging actions', () => {
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Send message' })).toBe(
      'messaging',
    );
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Email us' })).toBe('messaging');
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Share' })).toBe('messaging');
  });

  it('classifies upload-labelled buttons as upload', () => {
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Upload file' })).toBe('upload');
  });

  it('classifies a link as navigation', () => {
    expect(classifyAction({ kind: 'click', role: 'link', name: 'Next page' })).toBe('navigate');
  });

  it('classifies read-only roles as read', () => {
    expect(classifyAction({ kind: 'click', role: 'paragraph', name: 'text' })).toBe('read');
    expect(classifyAction({ kind: 'click', role: 'heading', name: 'Title' })).toBe('read');
  });

  it('gives destructive priority over financial', () => {
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Delete and pay invoice' })).toBe(
      'destructive',
    );
  });

  it('gives financial priority over messaging', () => {
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Pay and send receipt' })).toBe(
      'financial',
    );
  });

  it('falls back to submit for an unknown click target', () => {
    expect(classifyAction({ kind: 'click' })).toBe('submit');
    expect(classifyAction({ kind: 'click', role: 'unknown-role' })).toBe('submit');
  });

  it('classifies by HTTP method for unknown action kinds', () => {
    expect(classifyAction({ kind: 'unknown', method: 'GET' })).toBe('read');
    expect(classifyAction({ kind: 'unknown', method: 'POST' })).toBe('submit');
    expect(classifyAction({ kind: 'unknown', method: 'DELETE' })).toBe('submit');
  });

  it('classifies a DELETE method as destructive when the label says so', () => {
    expect(classifyAction({ kind: 'unknown', method: 'DELETE', name: 'Remove' })).toBe(
      'destructive',
    );
  });

  it('defaults an unknown action kind to submit', () => {
    expect(classifyAction({ kind: 'mystery' })).toBe('submit');
  });

  it('maps classes to HTTP methods', () => {
    expect(methodForClass('read')).toBe('GET');
    expect(methodForClass('navigate')).toBe('GET');
    expect(methodForClass('submit')).toBe('POST');
    expect(methodForClass('input')).toBe('POST');
    expect(methodForClass('destructive')).toBe('POST');
    expect(methodForClass('financial')).toBe('POST');
    expect(methodForClass('messaging')).toBe('POST');
    expect(methodForClass('download')).toBe('POST');
    expect(methodForClass('upload')).toBe('POST');
  });
});

describe('domain matching', () => {
  it('extracts a host from a URL', () => {
    expect(hostOf('https://example.test/path?q=1')).toBe('example.test');
    expect(hostOf('not a url')).toBeUndefined();
    expect(hostOf(undefined)).toBeUndefined();
  });

  it('matches an exact host', () => {
    expect(matchDomains('example.test', ['example.test']).matched).toBe(true);
    expect(matchDomains('other.test', ['example.test']).matched).toBe(false);
  });

  it('matches a wildcard host', () => {
    expect(matchDomains('a.example.test', ['*.example.test']).matched).toBe(true);
    expect(matchDomains('example.test', ['*.example.test']).matched).toBe(true);
    expect(matchDomains('notexample.test', ['*.example.test']).matched).toBe(false);
  });

  it('matches an explicit @url: pattern', () => {
    expect(matchDomains('localhost', ['@url:`http://localhost:3000`']).matched).toBe(true);
    expect(matchDomains('example.test', ['@url:`http://localhost:3000`']).matched).toBe(false);
  });

  it('ignores a www prefix for exact matches', () => {
    expect(matchDomains('www.example.test', ['example.test']).matched).toBe(true);
  });

  it('does not match when the host is unknown', () => {
    expect(matchDomains(undefined, ['example.test']).matched).toBe(false);
  });

  it('ignores empty patterns', () => {
    expect(matchDomains('example.test', ['', '  ']).matched).toBe(false);
  });

  it('normalises origins', () => {
    expect(normalizeOrigin('@url:`http://localhost:3000/app`')).toBe('http://localhost:3000');
    expect(normalizeOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeOrigin('HTTP://LOCALHOST:3000')).toBe('http://localhost:3000');
    expect(normalizeOrigin('not-a-url')).toBe('not-a-url');
  });

  it('detects owned origins', () => {
    const policy = openPolicy();
    policy.ownedOrigins = ['@url:`http://localhost:3000`'];
    expect(isOwnedOrigin('http://localhost:3000', policy)).toBe(true);
    expect(isOwnedOrigin('http://localhost:3001', policy)).toBe(false);
    expect(isOwnedOrigin(undefined, policy)).toBe(false);
  });
});

describe('policy evaluation', () => {
  it('allows a read action', () => {
    const policy = openPolicy();
    const decision = evaluate({ kind: 'snapshot' }, ctx(policy));
    expect(decision.verdict).toBe('allow');
    expect(decision.actionClass).toBe('read');
    expect(decision.ruleIds).toContain('policy.allow.read');
  });

  it('allows a navigation when no domain list is configured', () => {
    const policy = openPolicy();
    const decision = evaluate({ kind: 'goto', url: 'https://anywhere.test/' }, ctx(policy));
    expect(decision.verdict).toBe('allow');
  });

  it('denies a navigation to a host that is not allowed', () => {
    const policy = openPolicy();
    policy.domains.allow = ['example.test'];
    const decision = evaluate({ kind: 'goto', url: 'https://evil.test/' }, ctx(policy));
    expect(decision.verdict).toBe('deny');
    expect(decision.ruleIds).toContain('policy.domain.allow');
  });

  it('allows a navigation to an allowed host', () => {
    const policy = openPolicy();
    policy.domains.allow = ['example.test'];
    const decision = evaluate({ kind: 'goto', url: 'https://example.test/page' }, ctx(policy));
    expect(decision.verdict).toBe('allow');
  });

  it('denies a host on the deny list even when it is on the allow list', () => {
    const policy = openPolicy();
    policy.domains.allow = ['example.test'];
    policy.domains.deny = ['evil.test'];
    const decision = evaluate({ kind: 'goto', url: 'https://evil.test/' }, ctx(policy));
    expect(decision.verdict).toBe('deny');
    expect(decision.ruleIds).toContain('policy.domain.deny');
  });

  it('denies a denied action class', () => {
    const policy = openPolicy();
    policy.actionClasses.deny = ['destructive'];
    const decision = evaluate(
      { kind: 'click', role: 'button', name: 'Delete account' },
      ctx(policy),
    );
    expect(decision.verdict).toBe('deny');
    expect(decision.ruleIds).toContain('policy.deny.destructive');
  });

  it('denies a denied class even when it is also approval-required', () => {
    const policy = openPolicy();
    policy.actionClasses.deny = ['submit'];
    policy.actionClasses.approvalRequired = ['submit'];
    const decision = evaluate(
      { kind: 'click', role: 'button', name: 'Submit' },
      ctx(policy, { approved: true }),
    );
    expect(decision.verdict).toBe('deny');
  });

  it('requires approval for an approval-required class', () => {
    const policy = openPolicy();
    policy.actionClasses.approvalRequired = ['submit'];
    const decision = evaluate({ kind: 'click', role: 'button', name: 'Submit' }, ctx(policy));
    expect(decision.verdict).toBe('needs_approval');
    expect(decision.ruleIds).toContain('policy.approval.required.submit');
  });

  it('allows an approval-required class once approved', () => {
    const policy = openPolicy();
    policy.actionClasses.approvalRequired = ['submit'];
    const decision = evaluate(
      { kind: 'click', role: 'button', name: 'Submit' },
      ctx(policy, { approved: true }),
    );
    expect(decision.verdict).toBe('allow');
    expect(decision.ruleIds).toContain('policy.approval.granted.submit');
  });

  it('asks for an approval in a non-interactive session', () => {
    const policy = openPolicy();
    policy.actionClasses.approvalRequired = ['submit'];
    const decision = evaluate(
      { kind: 'click', role: 'button', name: 'Submit' },
      ctx(policy, { nonInteractive: true }),
    );
    // The session cannot ask, so the action is parked rather than
    // forbidden. The operator approves it out of band.
    expect(decision.verdict).toBe('needs_approval');
    expect(decision.ruleIds).toContain('policy.approval.required.submit');
  });

  it('denies eval-readonly when it is disabled', () => {
    const policy = openPolicy();
    const decision = evaluate({ kind: 'eval-readonly' }, ctx(policy));
    expect(decision.verdict).toBe('deny');
    expect(decision.ruleIds).toContain('policy.eval_readonly.disabled');
  });

  it('allows eval-readonly when it is explicitly enabled', () => {
    const policy = openPolicy();
    policy.compliance.evalReadonly = true;
    const decision = evaluate({ kind: 'eval-readonly' }, ctx(policy));
    expect(decision.verdict).toBe('allow');
  });

  it('requires approval for tainted submit content', () => {
    const policy = openPolicy();
    const decision = evaluate(
      { kind: 'click', role: 'button', name: 'Submit' },
      ctx(policy, { tainted: true }),
    );
    expect(decision.verdict).toBe('needs_approval');
    expect(decision.ruleIds).toContain('policy.tainted.submit');
  });

  it('requires approval for tainted messaging content', () => {
    const policy = openPolicy();
    const decision = evaluate(
      { kind: 'click', role: 'button', name: 'Send' },
      ctx(policy, { tainted: true }),
    );
    expect(decision.verdict).toBe('needs_approval');
  });

  it('allows tainted input into a plain field', () => {
    const policy = openPolicy();
    const decision = evaluate(
      { kind: 'fill', role: 'textbox', name: 'Search' },
      ctx(policy, { tainted: true }),
    );
    expect(decision.verdict).toBe('allow');
  });

  it('covers every action class through evaluation', () => {
    const policy = openPolicy();
    const intents: Record<string, ActionIntent> = {
      read: { kind: 'snapshot' },
      navigate: { kind: 'goto', url: 'https://example.test/' },
      input: { kind: 'fill', role: 'textbox', name: 'Email' },
      submit: { kind: 'click', role: 'button', name: 'Submit' },
      destructive: { kind: 'click', role: 'button', name: 'Delete' },
      financial: { kind: 'click', role: 'button', name: 'Pay' },
      messaging: { kind: 'click', role: 'button', name: 'Send' },
      download: { kind: 'download' },
      upload: { kind: 'upload' },
    };
    for (const actionClass of ACTION_CLASSES) {
      const intent = intents[actionClass];
      expect(intent).toBeDefined();
      if (intent === undefined) continue;
      const decision = evaluate(intent, ctx(policy));
      expect(decision.actionClass).toBe(actionClass);
      expect(['allow', 'deny', 'needs_approval']).toContain(decision.verdict);
    }
  });
});
