/**
 * Integration tests for the safety layer as it is actually enforced.
 *
 * These drive the daemon's HTTP API the way the CLI does, so they test the
 * wiring and not just the pure functions.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon, type DaemonHandler } from '../../src/core/daemon.js';
import { evaluateAction } from '../../src/safety/gate.js';
import { validatePolicy, type Policy } from '../../src/safety/policy.js';
import { PlanLock, createPlan } from '../../src/safety/planlock.js';
import { ApprovalStore } from '../../src/safety/approvals.js';

/** A permissive policy. */
function policy(): Policy {
  return validatePolicy({
    version: 1,
    domains: { allow: [], deny: [] },
    ownedOrigins: [],
    actionClasses: { approvalRequired: ['submit', 'destructive'], deny: [] },
    compliance: {
      respectRobots: true,
      userAgentSuffix: 'BrowserVerifiedSkill/1.0 (+https://example.test/contact)',
      captcha: 'human_handoff',
      evalReadonly: false,
    },
    secrets: { maskInLogs: true },
  });
}

/** The gate, with a plan that allows reading. */
function gate(plan: ReturnType<typeof createPlan>) {
  const planLock = new PlanLock();
  planLock.set(plan);
  return { policy: policy(), planLock, approvals: new ApprovalStore() };
}

describe('the safety gate through the daemon handler shape', () => {
  it('refuses an action whose class is not in the plan', () => {
    const g = gate(
      createPlan({
        goal: 'read',
        successCondition: { type: 'text_visible', text: 'x' },
        allowedActionClasses: ['read'],
      }),
    );
    const verdict = evaluateAction(
      {
        intent: { kind: 'click', role: 'button', name: 'Delete' },
        currentUrl: 'http://example.test/',
        interactive: true,
      },
      g,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.next).toBe('off_plan');
  });

  it('refuses a navigation outside the plan origins', () => {
    const g = gate(
      createPlan({
        goal: 'read',
        successCondition: { type: 'text_visible', text: 'x' },
        allowedOrigins: ['http://example.test'],
        allowedActionClasses: ['read', 'navigate'],
      }),
    );
    const verdict = evaluateAction(
      {
        intent: { kind: 'goto', url: 'https://evil.test/' },
        currentUrl: 'http://example.test/',
        interactive: true,
      },
      g,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.next).toBe('off_plan');
  });
});

describe('the daemon: the plan handlers', () => {
  let dir: string;
  let server: { port: number; close: () => Promise<void> };
  let handlers: Record<string, DaemonHandler>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bv-safety-'));
    const planLock = new PlanLock();
    const approvals = new ApprovalStore();
    handlers = {
      'plan.set': async (request) => {
        const raw = (request.params ?? {})['plan'];
        if (raw === undefined) return { data: { ok: false, error: 'no plan' } };
        planLock.set(raw as never);
        return { data: { ok: true, plan: raw } };
      },
      'plan.show': async () => ({ data: { plan: planLock.current } }),
      'approve.issue': async (request) => {
        const actionId = String((request.params ?? {})['actionId']);
        const pending = approvals.getPending(actionId);
        if (pending === undefined) {
          return { data: { ok: false, error: 'not found' } };
        }
        const token = approvals.issue(actionId);
        return { data: { ok: true, token: token?.token ?? '', description: pending.description } };
      },
    };
    server = await startDaemon({ handlers, token: 'test-token' });
  });

  afterAll(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** The daemon's URL. The method travels in the request body. */
  function url(): string {
    return `http://127.0.0.1:${server.port}/rpc`;
  }

  it('serves the plan handlers over HTTP', async () => {
    const response = await fetch(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({ method: 'plan.show' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { plan: unknown } };
    expect(body.data.plan).toBeUndefined();
  });

  it('refuses a request without the token', async () => {
    const response = await fetch(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'plan.show' }),
    });
    expect(response.status).toBe(401);
  });

  it('refuses a request with the wrong token', async () => {
    const response = await fetch(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify({ method: 'plan.show' }),
    });
    expect(response.status).toBe(401);
  });

  it('refuses a request for an unknown method', async () => {
    const response = await fetch(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({ method: 'nope' }),
    });
    expect(response.status).toBe(404);
  });
});
