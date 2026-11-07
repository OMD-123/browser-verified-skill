/**
 * Tests for the agent loop (M27).
 *
 * The most important test in this file is the one that checks the safety
 * gate is **inside** the loop: a model that proposes a forbidden action
 * must be refused, exactly as a human's would be.
 */
import { describe, expect, it } from 'vitest';
import {
  runAgentLoop,
  parseAction,
  actionKey,
  gateInputFor,
  intentFor,
  type AgentAction,
  type AgentEnvironment,
} from '../../src/agent/loop.js';
import { validatePolicy } from '../../src/safety/policy.js';
import { PlanLock, createPlan } from '../../src/safety/planlock.js';
import { ApprovalStore } from '../../src/safety/approvals.js';
import type { LlmClient, LlmResponse, Tier } from '../../src/llm/client.js';

/** A model that replies with a fixed list. */
class ScriptedClient implements LlmClient {
  readonly name = 'scripted';
  readonly tiers: readonly Tier[] = ['fast', 'standard', 'deep'];
  readonly sent: number[] = [];

  constructor(private readonly replies: string[]) {}

  async send(): Promise<LlmResponse> {
    const index = this.sent.length;
    this.sent.push(index);
    // When the script runs out, the model says something that is not an
    // action. That is the honest behaviour of a model that has run out of
    // things to say, and it lets the loop's own handling be tested.
    return {
      text: this.replies[index] ?? 'I have nothing further to propose.',
      toolCalls: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      servedBy: 'standard',
      costUsd: 0,
      durationMs: 1,
    };
  }
}

/** An environment that records what it was asked to do. */
function environment(overrides: Partial<AgentEnvironment> = {}): {
  env: AgentEnvironment;
  performed: AgentAction[];
} {
  const performed: AgentAction[] = [];
  const env: AgentEnvironment = {
    perform: async (action) => {
      performed.push(action);
      return { ok: true, output: 'the page now shows something' };
    },
    currentUrl: () => 'https://example.test/',
    findings: () => [],
    ...overrides,
  };
  return { env, performed };
}

/** An action class the plan may allow. */
type PlanClass =
  | 'read'
  | 'navigate'
  | 'submit'
  | 'input'
  | 'upload'
  | 'destructive'
  | 'financial'
  | 'messaging'
  | 'download';

/** A permissive gate. */
function gate(
  overrides: {
    origins?: string[];
    classes?: PlanClass[];
    approvalRequired?: PlanClass[];
  } = {},
) {
  const planLock = new PlanLock();
  planLock.set(
    createPlan({
      goal: 'test',
      successCondition: { type: 'url_matches', pattern: '/x' },
      allowedOrigins: overrides.origins ?? ['https://example.test'],
      allowedActionClasses: overrides.classes ?? ['read', 'navigate', 'submit', 'input'],
      maxSteps: 20,
      createdAt: new Date().toISOString(),
    }),
  );
  return {
    policy: validatePolicy({
      version: 1,
      domains: { allow: [], deny: [] },
      ownedOrigins: [],
      actionClasses: {
        approvalRequired: overrides.approvalRequired ?? [],
        deny: [],
      },
    }),
    planLock,
    approvals: new ApprovalStore(),
  };
}

describe('the action parser', () => {
  it('parses a click', () => {
    expect(parseAction('{"action":"click","target":"role=button"}')).toEqual({
      kind: 'click',
      target: 'role=button',
    });
  });

  it('parses a fill', () => {
    expect(parseAction('{"action":"fill","target":"#email","value":"a@b.test"}')).toEqual({
      kind: 'fill',
      target: '#email',
      value: 'a@b.test',
    });
  });

  it('parses a goto', () => {
    expect(parseAction('{"action":"goto","url":"https://x.test/"}')).toEqual({
      kind: 'goto',
      url: 'https://x.test/',
    });
  });

  it('parses a done', () => {
    expect(parseAction('{"action":"done","answer":"finished"}')).toEqual({
      kind: 'done',
      answer: 'finished',
    });
  });

  it('parses JSON in a code fence', () => {
    expect(parseAction('```json\n{"action":"click","target":"#a"}\n```')).toEqual({
      kind: 'click',
      target: '#a',
    });
  });

  it('parses JSON with something around it', () => {
    expect(parseAction('Sure! {"action":"click","target":"#a"} Hope that helps.')).toEqual({
      kind: 'click',
      target: '#a',
    });
  });

  it('returns nothing for prose', () => {
    expect(parseAction('I think you should click the button')).toBeUndefined();
  });

  it('returns nothing for an unknown action', () => {
    expect(parseAction('{"action":"launch_missiles"}')).toBeUndefined();
  });

  it('returns nothing for a click with no target', () => {
    expect(parseAction('{"action":"click"}')).toBeUndefined();
  });

  it('returns nothing for a fill with no value', () => {
    expect(parseAction('{"action":"fill","target":"#a"}')).toBeUndefined();
  });
});

describe('the action key', () => {
  it('distinguishes different actions', () => {
    expect(actionKey({ kind: 'click', target: '#a' })).not.toBe(
      actionKey({ kind: 'click', target: '#b' }),
    );
  });

  it('distinguishes different values', () => {
    expect(actionKey({ kind: 'fill', target: '#a', value: 'x' })).not.toBe(
      actionKey({ kind: 'fill', target: '#a', value: 'y' }),
    );
  });

  it('gives the same action the same key', () => {
    expect(actionKey({ kind: 'click', target: '#a' })).toBe(
      actionKey({ kind: 'click', target: '#a' }),
    );
  });
});

describe('the gate input', () => {
  it('describes the intent', () => {
    // The target is parsed into its parts, because the classifier needs the
    // role: a click on a link is a navigation, a click on a button is not.
    expect(intentFor({ kind: 'click', target: 'role=button name="Sign in"' })).toEqual({
      kind: 'click',
      role: 'button',
      name: 'Sign in',
    });
  });

  it('describes a plain selector as a name', () => {
    expect(intentFor({ kind: 'click', target: '#login' })).toEqual({
      kind: 'click',
      name: '#login',
    });
  });

  it('carries the current URL', () => {
    const { env } = environment({ currentUrl: () => 'https://x.test/page' });
    expect(gateInputFor({ kind: 'snapshot' }, env).currentUrl).toBe('https://x.test/page');
  });

  it('carries the findings', () => {
    const { env } = environment({
      findings: () => [
        {
          id: 'f-1',
          kind: 'instruction-phrase',
          severity: 'review',
          evidenceSnippet: 'x',
        },
      ],
    });
    expect(gateInputFor({ kind: 'snapshot' }, env).findings).toHaveLength(1);
  });

  it('carries the taint for a value', () => {
    const { env } = environment({ tainted: () => true, sink: () => 'email-recipient-field' });
    const input = gateInputFor({ kind: 'fill', target: '#a', value: 'x' }, env);
    expect(input.tainted).toBe(true);
    expect(input.sink).toBe('email-recipient-field');
  });
});

describe('the agent loop', () => {
  it('runs an action and finishes', async () => {
    const client = new ScriptedClient([
      '{"action":"click","target":"role=button"}',
      '{"action":"done","answer":"signed in"}',
    ]);
    const { env, performed } = environment();

    // A click on a button named "Sign in" is classified as a submit, so
    // the policy does not ask for an approval here.
    const result = await runAgentLoop('sign in', env, { client, gate: gate() });

    expect(result.ok).toBe(true);
    expect(result.answer).toBe('signed in');
    expect(result.stopReason).toBe('the model finished');
    expect(
      performed,
      `the step was not performed: ${result.steps.map((s) => `${s.outcome}: ${s.reason ?? ''}`).join('; ')}`,
    ).toHaveLength(1);
  });

  it('refuses an action the gate refuses', async () => {
    // The plan allows reads only, so a click is off-plan.
    const client = new ScriptedClient([
      '{"action":"click","target":"role=button"}',
      '{"action":"done","answer":"gave up"}',
    ]);
    const { env, performed } = environment();

    const result = await runAgentLoop('test', env, {
      client,
      gate: gate({ classes: ['read'] }),
    });

    expect(result.steps[0]?.outcome).toBe('refused');
    expect(result.refusals).toBe(1);
    // The action was NOT performed.
    expect(performed).toHaveLength(0);
  });

  it('feeds the refusal back to the model', async () => {
    const client = new ScriptedClient([
      '{"action":"click","target":"role=button"}',
      '{"action":"done","answer":"gave up"}',
    ]);
    const { env } = environment();

    const result = await runAgentLoop('test', env, {
      client,
      gate: gate({ classes: ['read'] }),
    });

    // The second step happened, so the model was told about the refusal.
    expect(result.steps).toHaveLength(2);
  });

  it('asks for an approval when the action needs one', async () => {
    const client = new ScriptedClient([
      '{"action":"click","target":"role=button name=\\"Submit\\""}',
      '{"action":"done","answer":"gave up"}',
    ]);
    const { env } = environment();

    const result = await runAgentLoop('test', env, {
      client,
      gate: gate({ approvalRequired: ['submit'] }),
    });

    expect(result.steps[0]?.outcome).toBe('refused');
    expect(result.steps[0]?.approvalId).toBeDefined();
  });

  it('stops when the model asks a question', async () => {
    const client = new ScriptedClient(['{"action":"ask","question":"which account?"}']);
    const { env } = environment();

    const result = await runAgentLoop('test', env, { client, gate: gate() });

    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('the model asked a question');
  });

  it('stops when the model repeats itself', async () => {
    const client = new ScriptedClient([
      '{"action":"click","target":"#a"}',
      '{"action":"click","target":"#a"}',
      '{"action":"click","target":"#a"}',
    ]);
    const { env } = environment();

    const result = await runAgentLoop('test', env, { client, gate: gate() });

    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('the model repeated itself');
  });

  it('stops when the step budget runs out', async () => {
    const client = new ScriptedClient(
      Array.from({ length: 20 }, (_, index) => `{"action":"click","target":"#different-${index}"}`),
    );
    const { env } = environment();

    const result = await runAgentLoop('test', env, {
      client,
      gate: gate(),
      maxSteps: 5,
    });

    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('the step budget ran out');
    expect(result.steps).toHaveLength(5);
  });

  it('stops when the model says something it cannot act on', async () => {
    const client = new ScriptedClient(['I am not sure what to do here']);
    const { env } = environment();

    const result = await runAgentLoop('test', env, { client, gate: gate() });

    expect(result.ok).toBe(false);
    expect(result.steps[0]?.outcome).toBe('failed');
  });

  it('stops when the model keeps failing', async () => {
    const client = new ScriptedClient(Array.from({ length: 5 }, () => 'not json at all'));
    const { env } = environment();

    const result = await runAgentLoop('test', env, { client, gate: gate() });

    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('the model made no progress');
  });

  it('reports a failure from the environment', async () => {
    const client = new ScriptedClient([
      '{"action":"click","target":"#a"}',
      '{"action":"done","answer":"gave up"}',
    ]);
    const { env } = environment({
      perform: async () => ({ ok: false, output: 'the element was not there' }),
    });

    const result = await runAgentLoop('test', env, { client, gate: gate() });

    expect(result.steps[0]?.outcome).toBe('failed');
    expect(result.steps[0]?.reason).toContain('not there');
  });

  it('calls back after every step', async () => {
    const client = new ScriptedClient(['{"action":"done","answer":"x"}']);
    const { env } = environment();
    const seen: number[] = [];

    await runAgentLoop('test', env, {
      client,
      gate: gate(),
      onStep: (step) => seen.push(step.index),
    });

    expect(seen).toEqual([1]);
  });

  it('stops when the budget runs out', async () => {
    const client = new ScriptedClient(['{"action":"done","answer":"x"}']);
    const { env } = environment();

    const result = await runAgentLoop('test', env, {
      client,
      gate: gate(),
      budget: {
        check: () => {
          throw new Error('the budget is exhausted');
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('an error stopped the loop');
  });

  it('never performs an action the gate refused', async () => {
    const client = new ScriptedClient(
      Array.from({ length: 10 }, () => '{"action":"click","target":"#forbidden"}'),
    );
    const { env, performed } = environment();

    await runAgentLoop('test', env, {
      client,
      gate: gate({ classes: ['read'] }),
    });

    // Every one of them was off-plan, so none was performed.
    expect(performed).toHaveLength(0);
  });
});
