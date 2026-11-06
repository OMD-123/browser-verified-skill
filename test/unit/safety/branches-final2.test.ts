/**
 * The last safety branch-coverage tests: the paths that need an unusual but
 * realistic input to reach.
 */
import { describe, expect, it } from 'vitest';
import { classifyAction } from '../../../src/safety/classify.js';
import { PlanLock, createPlan } from '../../../src/safety/planlock.js';
import { InjectionScanner } from '../../../src/safety/injection/detectors.js';

describe('classifier: the submit-role path with no form method', () => {
  it('treats a submit-role input action with no form method as a submit', () => {
    // No `formMethod`: the assumed method is POST, so this is a submit.
    expect(classifyAction({ kind: 'press', role: 'button', name: 'Continue' })).toBe('submit');
  });

  it('treats a submit-role click with no form method as a submit', () => {
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Continue' })).toBe('submit');
  });
});

describe('classifier: the messaging patterns', () => {
  it('recognises a share button', () => {
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Share' })).toBe('messaging');
  });

  it('recognises a tweet button', () => {
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Tweet this' })).toBe('messaging');
  });

  it('recognises a comment button', () => {
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Comment' })).toBe('messaging');
  });

  it('recognises a reply button', () => {
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Reply' })).toBe('messaging');
  });

  it('recognises a forward button', () => {
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Forward' })).toBe('messaging');
  });

  it('recognises a report button', () => {
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Report' })).toBe('messaging');
  });

  it('recognises a mention button', () => {
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Mention' })).toBe('messaging');
  });

  it('classifies a newsletter subscription as financial, because subscribe is a paid action', () => {
    // "Subscribe" is in the financial pattern list, and financial takes
    // priority over messaging. A newsletter subscription that costs money is
    // the more dangerous reading.
    expect(
      classifyAction({ kind: 'click', role: 'button', name: 'Subscribe to the newsletter' }),
    ).toBe('financial');
  });

  it('recognises a contact-us button', () => {
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Contact us' })).toBe('messaging');
  });

  it('recognises a notify button', () => {
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Notify' })).toBe('messaging');
  });

  it('recognises a flag button', () => {
    expect(classifyAction({ kind: 'click', role: 'button', name: 'Flag' })).toBe('messaging');
  });
});

describe('plan-lock: the defaults', () => {
  it('defaults the origins, classes, steps and timestamp', () => {
    const plan = createPlan({
      goal: 'x',
      successCondition: { type: 'text_visible', text: 'y' },
    });
    expect(plan.allowedOrigins).toEqual([]);
    expect(plan.allowedActionClasses).toEqual([]);
    expect(plan.maxSteps).toBe(80);
    expect(plan.createdAt).toBeDefined();
  });

  it('keeps supplied values', () => {
    const plan = createPlan({
      goal: 'x',
      successCondition: { type: 'text_visible', text: 'y' },
      allowedOrigins: ['http://localhost:3000'],
      allowedActionClasses: ['read'],
      maxSteps: 5,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(plan.allowedOrigins).toEqual(['http://localhost:3000']);
    expect(plan.allowedActionClasses).toEqual(['read']);
    expect(plan.maxSteps).toBe(5);
    expect(plan.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('reports an amendment error with a message', () => {
    const lock = new PlanLock();
    lock.set(
      createPlan({
        goal: 'x',
        successCondition: { type: 'text_visible', text: 'y' },
        allowedActionClasses: ['read'],
      }),
    );
    const result = lock.amend({ maxSteps: -5 }, { approved: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('invalid');
  });
});

describe('detector: a base64 finding with no node ref', () => {
  it('omits the node ref', () => {
    const scanner = new InjectionScanner();
    const result = scanner.scan([{ text: 'SGVsbG8gV29ybGQhIQ==' }]);
    const finding = result.findings.find((f) => f.kind === 'base64-blob');
    expect(finding).toBeDefined();
    expect(finding?.nodeRef).toBeUndefined();
  });

  it('includes the node ref when the content has one', () => {
    const scanner = new InjectionScanner();
    const result = scanner.scan([{ text: 'SGVsbG8gV29ybGQhIQ==', ref: 'e7' }]);
    const finding = result.findings.find((f) => f.kind === 'base64-blob');
    expect(finding?.nodeRef).toBe('e7');
  });
});
