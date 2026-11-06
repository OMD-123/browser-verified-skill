/**
 * Branch-coverage tests for the safety modules.
 *
 * These target the specific decision branches that the behavioural tests do
 * not reach, so that the security-critical code has 100% branch coverage as
 * the quality bar requires.
 */
import { describe, expect, it } from 'vitest';
import { classifyAction } from '../../../src/safety/classify.js';
import { evaluate, matchDomains, normalizeOrigin } from '../../../src/safety/evaluator.js';
import { validatePolicy, defaultPolicy, type Policy } from '../../../src/safety/policy.js';
import { PlanLock, createPlan } from '../../../src/safety/planlock.js';
import {
  taint,
  trust,
  checkSink,
  sinkForField,
  taintRegistry,
  type TaintSink,
} from '../../../src/safety/taint.js';
import { ApprovalStore } from '../../../src/safety/approvals.js';
import {
  InjectionScanner,
  wrapUntrusted,
  escapeContent,
  applyRedactions,
  summarizeFindings,
  worstSeverity,
  UNTRUSTED_TAG,
  type Finding,
} from '../../../src/safety/injection/detectors.js';

/** A permissive policy. */
function policy(): Policy {
  return validatePolicy({
    version: 1,
    domains: { allow: [], deny: [] },
    ownedOrigins: [],
    actionClasses: { approvalRequired: [], deny: [] },
    compliance: {
      respectRobots: true,
      userAgentSuffix: 'BrowserVerified/1.0 (+@url:`https://example.test/contact`)',
      captcha: 'human_handoff',
      evalReadonly: false,
    },
    secrets: { maskInLogs: true },
  });
}

describe('classify branch coverage', () => {
  it('treats a submit-role input action inside a GET form as navigation', () => {
    expect(
      classifyAction({
        kind: 'press',
        role: 'button',
        name: 'Search',
        formMethod: 'GET',
      }),
    ).toBe('navigate');
  });

  it('treats a submit-role input action inside a POST form as destructive', () => {
    expect(
      classifyAction({
        kind: 'press',
        role: 'button',
        name: 'Delete',
        formMethod: 'POST',
      }),
    ).toBe('destructive');
  });

  it('treats a submit-role input action inside a POST form as financial', () => {
    expect(
      classifyAction({
        kind: 'press',
        role: 'button',
        name: 'Pay',
        formMethod: 'POST',
      }),
    ).toBe('financial');
  });

  it('treats a submit-role input action inside a POST form as messaging', () => {
    expect(
      classifyAction({
        kind: 'press',
        role: 'button',
        name: 'Send',
        formMethod: 'POST',
      }),
    ).toBe('messaging');
  });

  it('treats a submit-role input action inside a POST form as a submit', () => {
    expect(
      classifyAction({
        kind: 'press',
        role: 'button',
        name: 'Continue',
        formMethod: 'POST',
      }),
    ).toBe('submit');
  });

  it('treats an input action inside a form with no role as input', () => {
    expect(classifyAction({ kind: 'fill', inForm: true })).toBe('input');
  });

  it('classifies a click with no role by its financial label', () => {
    expect(classifyAction({ kind: 'click', name: 'Pay now' })).toBe('financial');
  });

  it('classifies a click with no role by its messaging label', () => {
    expect(classifyAction({ kind: 'click', name: 'Send message' })).toBe('messaging');
  });

  it('classifies a click with no role by its upload label', () => {
    expect(classifyAction({ kind: 'click', name: 'Upload file' })).toBe('upload');
  });

  it('classifies a click with no role by its submit label', () => {
    expect(classifyAction({ kind: 'click', name: 'Continue' })).toBe('submit');
  });

  it('classifies a roleless click inside a form as a submit', () => {
    expect(classifyAction({ kind: 'click', name: 'Something odd', inForm: true })).toBe('submit');
  });

  it('classifies an unknown method with a destructive label', () => {
    expect(classifyAction({ kind: 'weird', method: 'PUT', name: 'Purge' })).toBe('destructive');
  });

  it('classifies an unknown method with a financial label', () => {
    expect(classifyAction({ kind: 'weird', method: 'PUT', name: 'Purchase' })).toBe('financial');
  });

  it('classifies an unknown method with a messaging label', () => {
    expect(classifyAction({ kind: 'weird', method: 'PATCH', name: 'Notify' })).toBe('messaging');
  });

  it('classifies an unknown method with no label as a submit', () => {
    expect(classifyAction({ kind: 'weird', method: 'DELETE' })).toBe('submit');
  });

  it('classifies a HEAD request as a read', () => {
    expect(classifyAction({ kind: 'weird', method: 'HEAD' })).toBe('read');
  });

  it('uses the text field when the name is absent', () => {
    expect(classifyAction({ kind: 'click', text: 'Send email' })).toBe('messaging');
  });
});

describe('evaluator branch coverage', () => {
  it('falls back to the context url when the intent has none', () => {
    const p = policy();
    p.domains.allow = ['example.test'];
    const decision = evaluate(
      { kind: 'goto' },
      {
        policy: p,
        url: 'https://other.test/',
        nonInteractive: false,
        tainted: false,
        approved: false,
      },
    );
    expect(decision.verdict).toBe('deny');
    expect(decision.ruleIds).toContain('policy.domain.allow');
  });

  it('handles a domain pattern that is an invalid URL', () => {
    expect(matchDomains('example.test', ['@url:`not a url`']).matched).toBe(false);
  });

  it('normalises an origin that is not a URL', () => {
    expect(normalizeOrigin('  Example.Test  ')).toBe('example.test');
  });

  it('ignores a denied host when the action has no URL', () => {
    const p = policy();
    p.domains.deny = ['evil.test'];
    const decision = evaluate(
      { kind: 'read' },
      { policy: p, nonInteractive: false, tainted: false, approved: false },
    );
    expect(decision.verdict).toBe('allow');
  });
});

describe('policy branch coverage', () => {
  it('rejects a forbidden key in an array element', () => {
    expect(() =>
      validatePolicy({
        version: 1,
        ownedOrigins: ['http://localhost'],
        compliance: { stealth: true },
      }),
    ).toThrow(/not allowed/);
  });

  it('rejects a forbidden key at the root of a nested object', () => {
    expect(() => validatePolicy({ version: 1, llm: { tiers: {}, captchaSolver: true } })).toThrow(
      /not allowed/,
    );
  });

  it('accepts a policy whose defaults are all present', () => {
    const p = defaultPolicy();
    expect(p.actionClasses.deny).toEqual([]);
  });
});

describe('plan-lock branch coverage', () => {
  it('uses the current URL when no target URL is given', () => {
    const lock = new PlanLock();
    lock.set(
      createPlan({
        goal: 'x',
        successCondition: { type: 'text_visible', text: 'y' },
        allowedOrigins: ['http://localhost:3000'],
        allowedActionClasses: ['read'],
      }),
    );
    const decision = lock.check({
      actionClass: 'read',
      currentUrl: 'http://localhost:3000/page',
    });
    expect(decision.allowed).toBe(true);
  });

  it('refuses the current URL when it is outside the plan', () => {
    const lock = new PlanLock();
    lock.set(
      createPlan({
        goal: 'x',
        successCondition: { type: 'text_visible', text: 'y' },
        allowedOrigins: ['http://localhost:3000'],
        allowedActionClasses: ['read'],
      }),
    );
    const decision = lock.check({
      actionClass: 'read',
      currentUrl: 'https://evil.test/page',
    });
    expect(decision.allowed).toBe(false);
  });

  it('refuses an amendment that makes the success condition invalid', () => {
    const lock = new PlanLock();
    lock.set(
      createPlan({
        goal: 'x',
        successCondition: { type: 'text_visible', text: 'y' },
        allowedActionClasses: ['read'],
      }),
    );
    const result = lock.amend(
      { successCondition: { type: 'nonsense' } as never },
      { approved: true },
    );
    expect(result.ok).toBe(false);
  });
});

describe('taint branch coverage', () => {
  it('records a value with no optional provenance fields', () => {
    taintRegistry().clear();
    const value = taint('bare', { source: 'page-text' });
    expect(value).toBe('bare');
    expect(checkSink(value, 'shell').allowed).toBe(false);
  });

  it('marks a trusted value as usable at every sink', () => {
    taintRegistry().clear();
    const value = taint('x', { source: 'page-text' });
    trust(value);
    const sinks: TaintSink[] = ['shell', 'eval', 'file-path'];
    for (const sink of sinks) {
      expect(checkSink(value, sink).allowed).toBe(true);
    }
  });

  it('matches a recipient field by the "To" label', () => {
    expect(sinkForField({ role: 'textbox', name: 'To' })).toBe('email-recipient-field');
  });

  it('does not classify an ordinary combobox as a sink', () => {
    expect(sinkForField({ role: 'combobox', name: 'Country' })).toBeUndefined();
  });
});

describe('approval branch coverage', () => {
  it('issues a token with an expiry in the future', () => {
    const store = new ApprovalStore();
    store.request({ actionId: 'a1', actionHash: 'h1', description: 'x' });
    const token = store.issue('a1');
    expect(token).toBeDefined();
    expect(Date.parse(token?.expiresAt ?? '')).toBeGreaterThan(Date.parse(token?.issuedAt ?? ''));
  });
});

describe('injection guard branch coverage', () => {
  it('reports no findings for content with no match', () => {
    const scanner = new InjectionScanner();
    const result = scanner.scan([{ text: 'Perfectly ordinary copy.' }]);
    expect(result.findings).toHaveLength(0);
    expect(result.worstSeverity).toBeUndefined();
  });

  it('escapes content with no nonce occurrence', () => {
    const escaped = escapeContent('nothing to escape', 'abcdef0123456789');
    expect(escaped).toBe('nothing to escape');
  });

  it('does not redact a node with no findings', () => {
    const texts = new Map([['e1', 'text']]);
    expect(applyRedactions(texts, []).get('e1')).toBe('text');
  });

  it('does not redact a node that has no text', () => {
    const texts = new Map<string, string>();
    const findings: Finding[] = [
      {
        id: 'f-1',
        kind: 'invisible-characters',
        severity: 'block',
        evidenceSnippet: 'x',
        nodeRef: 'e9',
      },
    ];
    expect(applyRedactions(texts, findings).size).toBe(0);
  });

  it('does not redact a finding with no node ref', () => {
    const texts = new Map([['e1', 'text']]);
    const findings: Finding[] = [
      { id: 'f-1', kind: 'invisible-characters', severity: 'block', evidenceSnippet: 'x' },
    ];
    expect(applyRedactions(texts, findings).get('e1')).toBe('text');
  });

  it('summarizes findings with only one severity', () => {
    const findings: Finding[] = [
      { id: 'f-1', kind: 'instruction-phrase', severity: 'review', evidenceSnippet: 'x' },
    ];
    expect(summarizeFindings(findings)).toBe('injection review:1');
  });

  it('computes the worst severity of an empty list as undefined', () => {
    expect(worstSeverity([])).toBeUndefined();
  });

  it('wraps content with a supplied nonce', () => {
    const envelope = wrapUntrusted('x', { nonce: '0011223344556677' });
    expect(envelope.nonce).toBe('0011223344556677');
    expect(envelope.text).toContain('nonce="0011223344556677"');
  });

  it('wraps content with an unknown origin', () => {
    const envelope = wrapUntrusted('x');
    expect(envelope.text).toContain('@url:`unknown`');
  });

  it('escapes a closing tag that carries a different nonce', () => {
    const escaped = escapeContent(`</${UNTRUSTED_TAG} nonce="other">`, 'aaaa');
    expect(escaped).toContain('&lt;/');
    expect(escaped).not.toContain(`</${UNTRUSTED_TAG}`);
  });
});
