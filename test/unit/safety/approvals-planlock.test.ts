/**
 * Exhaustive tests for the approval gate (M05) and the plan-lock (M06).
 */
import { describe, expect, it } from 'vitest';
import { ApprovalStore, hashAction, actionHashMatches } from '../../../src/safety/approvals.js';
import { PlanLock, createPlan, PlanSchema, ConditionSchema } from '../../../src/safety/planlock.js';

describe('action hashing', () => {
  it('produces the same hash for the same action', () => {
    const a = hashAction({ kind: 'click', target: 'Sign in' });
    const b = hashAction({ kind: 'click', target: 'Sign in' });
    expect(a).toBe(b);
  });

  it('produces a different hash for a different kind', () => {
    expect(hashAction({ kind: 'click', target: 'x' })).not.toBe(
      hashAction({ kind: 'fill', target: 'x' }),
    );
  });

  it('produces a different hash for a different target', () => {
    expect(hashAction({ kind: 'click', target: 'x' })).not.toBe(
      hashAction({ kind: 'click', target: 'y' }),
    );
  });

  it('produces a different hash for a different value', () => {
    expect(hashAction({ kind: 'fill', target: 'x', value: 'a' })).not.toBe(
      hashAction({ kind: 'fill', target: 'x', value: 'b' }),
    );
  });

  it('treats an absent value as different from an empty one', () => {
    expect(hashAction({ kind: 'fill', target: 'x' })).not.toBe(
      hashAction({ kind: 'fill', target: 'x', value: '' }),
    );
  });

  it('compares hashes', () => {
    const h = hashAction({ kind: 'click', target: 'x' });
    expect(actionHashMatches(h, h)).toBe(true);
    expect(actionHashMatches(h, 'short')).toBe(false);
  });
});

describe('approval store', () => {
  it('records a pending request', () => {
    const store = new ApprovalStore();
    const request = store.request({
      actionId: 'a1',
      actionHash: 'h1',
      description: 'click Sign in',
    });
    expect(request.actionId).toBe('a1');
    expect(store.getPending('a1')).toBeDefined();
    expect(store.listPending()).toHaveLength(1);
  });

  it('issues a token for a pending request', () => {
    const store = new ApprovalStore();
    store.request({ actionId: 'a1', actionHash: 'h1', description: 'click' });
    const token = store.issue('a1');
    expect(token).toBeDefined();
    expect(token?.actionId).toBe('a1');
    expect(token?.actionHash).toBe('h1');
    expect(token?.token).toBeDefined();
  });

  it('does not issue a token for an unknown request', () => {
    const store = new ApprovalStore();
    expect(store.issue('nope')).toBeUndefined();
  });

  it('removes the pending request when a token is issued', () => {
    const store = new ApprovalStore();
    store.request({ actionId: 'a1', actionHash: 'h1', description: 'click' });
    store.issue('a1');
    expect(store.getPending('a1')).toBeUndefined();
    expect(store.issue('a1')).toBeUndefined();
  });

  it('consumes a token successfully', () => {
    const store = new ApprovalStore();
    store.request({ actionId: 'a1', actionHash: 'h1', description: 'click' });
    const token = store.issue('a1');
    const result = store.consume(token?.token ?? '', { actionId: 'a1', actionHash: 'h1' });
    expect(result.ok).toBe(true);
  });

  it('refuses to replay a consumed token', () => {
    const store = new ApprovalStore();
    store.request({ actionId: 'a1', actionHash: 'h1', description: 'click' });
    const token = store.issue('a1');
    const first = store.consume(token?.token ?? '', { actionId: 'a1', actionHash: 'h1' });
    expect(first.ok).toBe(true);
    const second = store.consume(token?.token ?? '', { actionId: 'a1', actionHash: 'h1' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.ok === false ? second.ruleId : '').toBe('approval.replayed');
  });

  it('refuses a token issued for a different action id', () => {
    const store = new ApprovalStore();
    store.request({ actionId: 'a1', actionHash: 'h1', description: 'click' });
    const token = store.issue('a1');
    const result = store.consume(token?.token ?? '', { actionId: 'a2', actionHash: 'h1' });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.ok === false ? result.ruleId : '').toBe('approval.action_mismatch');
  });

  it('refuses a token issued for a different action hash', () => {
    const store = new ApprovalStore();
    store.request({ actionId: 'a1', actionHash: 'h1', description: 'click' });
    const token = store.issue('a1');
    const result = store.consume(token?.token ?? '', { actionId: 'a1', actionHash: 'h2' });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.ok === false ? result.ruleId : '').toBe('approval.action_hash_mismatch');
  });

  it('refuses an unknown token', () => {
    const store = new ApprovalStore();
    const result = store.consume('made-up', { actionId: 'a1', actionHash: 'h1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.ok === false ? result.ruleId : '').toBe('approval.unknown_token');
  });

  it('refuses an expired token', () => {
    const store = new ApprovalStore();
    store.request({ actionId: 'a1', actionHash: 'h1', description: 'click' });
    const token = store.issue('a1');
    const future = Date.now() + 60 * 60 * 1000;
    const result = store.consume(token?.token ?? '', { actionId: 'a1', actionHash: 'h1' }, future);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.ok === false ? result.ruleId : '').toBe('approval.expired');
  });

  it('issues a different token for each request', () => {
    const store = new ApprovalStore();
    store.request({ actionId: 'a1', actionHash: 'h1', description: 'one' });
    store.request({ actionId: 'a2', actionHash: 'h2', description: 'two' });
    const t1 = store.issue('a1');
    const t2 = store.issue('a2');
    expect(t1?.token).not.toBe(t2?.token);
  });

  it('bounds the number of pending requests', () => {
    const store = new ApprovalStore();
    for (let i = 0; i < 150; i++) {
      store.request({
        actionId: `a${i}`,
        actionHash: 'h',
        description: 'x',
        requestedAt: new Date(Date.now() + i).toISOString(),
      });
    }
    expect(store.listPending().length).toBeLessThanOrEqual(100);
  });

  it('clears everything', () => {
    const store = new ApprovalStore();
    store.request({ actionId: 'a1', actionHash: 'h1', description: 'click' });
    store.issue('a1');
    store.clear();
    expect(store.listPending()).toHaveLength(0);
    expect(store.pendingTokenCount).toBe(0);
  });
});

describe('the plan lock', () => {
  /** A plan that allows everything on one origin. */
  function plan() {
    return createPlan({
      goal: 'sign in',
      successCondition: { type: 'text_visible', text: 'Signed in' },
      allowedOrigins: ['http://localhost:3000'],
      allowedActionClasses: ['read', 'navigate', 'input', 'submit'],
      maxSteps: 5,
    });
  }

  it('refuses everything when no plan is set', () => {
    const lock = new PlanLock();
    expect(lock.hasPlan).toBe(false);
    const decision = lock.check({ actionClass: 'read' });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false ? decision.ruleId : '').toBe('plan.not_set');
  });

  it('allows an action inside the plan', () => {
    const lock = new PlanLock();
    lock.set(plan());
    expect(lock.hasPlan).toBe(true);
    const decision = lock.check({ actionClass: 'read', url: 'http://localhost:3000/x' });
    expect(decision.allowed).toBe(true);
  });

  it('refuses an action class that is not in the plan', () => {
    const lock = new PlanLock();
    lock.set(plan());
    const decision = lock.check({ actionClass: 'destructive' });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false ? decision.ruleId : '').toBe('plan.off_plan.action_class');
  });

  it('refuses navigation to an origin that is not in the plan', () => {
    const lock = new PlanLock();
    lock.set(plan());
    const decision = lock.check({ actionClass: 'navigate', url: 'https://evil.test/' });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false ? decision.ruleId : '').toBe('plan.off_plan.origin');
  });

  it('refuses a page that says go to evil.test', () => {
    const lock = new PlanLock();
    lock.set(plan());
    // The page says "go to evil.test"; the agent tries to navigate there.
    const decision = lock.check({ actionClass: 'navigate', url: 'https://evil.test/' });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false ? decision.reason : '').toContain('evil.test');
  });

  it('allows any origin when the plan lists none', () => {
    const lock = new PlanLock();
    lock.set(
      createPlan({
        goal: 'x',
        successCondition: { type: 'text_visible', text: 'y' },
        allowedActionClasses: ['read'],
      }),
    );
    const decision = lock.check({ actionClass: 'read', url: 'https://anywhere.test/' });
    expect(decision.allowed).toBe(true);
  });

  it('refuses an action once the step budget is exhausted', () => {
    const lock = new PlanLock();
    lock.set(plan());
    for (let i = 0; i < 5; i++) lock.recordStep();
    const decision = lock.check({ actionClass: 'read', url: 'http://localhost:3000/x' });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false ? decision.ruleId : '').toBe('plan.budget_exhausted');
  });

  it('resets the step counter when a new plan is set', () => {
    const lock = new PlanLock();
    lock.set(plan());
    lock.recordStep();
    lock.recordStep();
    expect(lock.steps).toBe(2);
    lock.set(plan());
    expect(lock.steps).toBe(0);
  });

  it('refuses to amend without approval', () => {
    const lock = new PlanLock();
    lock.set(plan());
    const result = lock.amend({ goal: 'something else' }, { approved: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.ok === false ? result.reason : '').toContain('requires approval');
  });

  it('amends with approval', () => {
    const lock = new PlanLock();
    lock.set(plan());
    const result = lock.amend({ goal: 'something else' }, { approved: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.goal).toBe('something else');
  });

  it('refuses to amend when no plan is set', () => {
    const lock = new PlanLock();
    const result = lock.amend({ goal: 'x' }, { approved: true });
    expect(result.ok).toBe(false);
  });

  it('refuses an amendment that makes the plan invalid', () => {
    const lock = new PlanLock();
    lock.set(plan());
    const result = lock.amend({ maxSteps: -1 }, { approved: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.ok === false ? result.reason : '').toContain('invalid');
  });

  it('keeps the original createdAt when amended', () => {
    const lock = new PlanLock();
    const original = plan();
    lock.set(original);
    lock.amend({ goal: 'new goal' }, { approved: true });
    expect(lock.current?.createdAt).toBe(original.createdAt);
  });

  it('clears the plan', () => {
    const lock = new PlanLock();
    lock.set(plan());
    lock.clear();
    expect(lock.hasPlan).toBe(false);
  });
});

describe('the condition schema', () => {
  it('accepts every condition type', () => {
    const conditions = [
      { type: 'url_matches', pattern: '/done' },
      { type: 'text_visible', text: 'Signed in' },
      { type: 'element', role: 'button', name: 'Next', min: 1, max: 3 },
      { type: 'network_response', urlPattern: '/api/ok', status: 200 },
      { type: 'storage', key: 'auth', matches: 'ok' },
      { type: 'llm_judged', claim: 'the page shows a receipt' },
    ];
    for (const condition of conditions) {
      expect(ConditionSchema.safeParse(condition).success).toBe(true);
    }
  });

  it('accepts compositions', () => {
    const nested = {
      all: [
        { type: 'url_matches', pattern: '/done' },
        {
          any: [{ type: 'text_visible', text: 'a' }, { not: { type: 'text_visible', text: 'b' } }],
        },
      ],
    };
    expect(ConditionSchema.safeParse(nested).success).toBe(true);
  });

  it('rejects an unknown condition type', () => {
    expect(ConditionSchema.safeParse({ type: 'vibes', ok: true }).success).toBe(false);
  });

  it('rejects an unknown key in a condition', () => {
    expect(
      ConditionSchema.safeParse({ type: 'url_matches', pattern: '/x', extra: 1 }).success,
    ).toBe(false);
  });

  it('rejects an empty pattern', () => {
    expect(ConditionSchema.safeParse({ type: 'url_matches', pattern: '' }).success).toBe(false);
  });
});

describe('the plan schema', () => {
  it('accepts a complete plan', () => {
    const result = PlanSchema.safeParse({
      goal: 'sign in',
      successCondition: { type: 'text_visible', text: 'Signed in' },
      allowedOrigins: ['http://localhost:3000'],
      allowedActionClasses: ['read'],
      maxSteps: 10,
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown key', () => {
    const result = PlanSchema.safeParse({
      goal: 'x',
      successCondition: { type: 'text_visible', text: 'y' },
      createdAt: new Date().toISOString(),
      rogue: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a plan with no goal', () => {
    const result = PlanSchema.safeParse({
      successCondition: { type: 'text_visible', text: 'y' },
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});
