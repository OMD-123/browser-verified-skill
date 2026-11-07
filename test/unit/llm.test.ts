/**
 * Tests for the LLM client, budget guard and tier router (M20).
 *
 * No network calls: the tests use a fake client, so they are deterministic
 * and free.
 */
import { describe, expect, it } from 'vitest';
import {
  BudgetExceededError,
  BudgetGuard,
  DEFAULT_PRICES,
  TierRouter,
  UnavailableClient,
  estimateCost,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  type Tier,
} from '../../src/llm/client.js';

/** A fake client that records what it was asked. */
class FakeClient implements LlmClient {
  readonly name = 'fake';
  readonly tiers: readonly Tier[] = ['fast', 'standard', 'deep'];
  readonly received: LlmRequest[] = [];

  constructor(
    private readonly usage = { inputTokens: 1000, outputTokens: 500 },
    private readonly text = 'the answer',
  ) {}

  async send(request: LlmRequest): Promise<LlmResponse> {
    this.received.push(request);
    return {
      text: this.text,
      toolCalls: [],
      usage: this.usage,
      servedBy: request.tier,
      costUsd: estimateCost(this.usage, DEFAULT_PRICES[request.tier]),
      durationMs: 1,
    };
  }
}

describe('the cost estimate', () => {
  it('prices the input and the output', () => {
    const cost = estimateCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      { inputPerMillion: 3, outputPerMillion: 15 },
    );
    expect(cost).toBe(18);
  });

  it('is zero for no tokens', () => {
    expect(
      estimateCost(
        { inputTokens: 0, outputTokens: 0 },
        { inputPerMillion: 3, outputPerMillion: 15 },
      ),
    ).toBe(0);
  });

  it('charges a fraction for a fraction of a million', () => {
    const cost = estimateCost(
      { inputTokens: 500_000, outputTokens: 0 },
      { inputPerMillion: 3, outputPerMillion: 15 },
    );
    expect(cost).toBe(1.5);
  });
});

describe('the budget guard', () => {
  it('starts with the whole budget', () => {
    const guard = new BudgetGuard(10);
    expect(guard.remainingUsd).toBe(10);
    expect(guard.current.spentUsd).toBe(0);
  });

  it('records what a request cost', () => {
    const guard = new BudgetGuard(10);
    const cost = guard.record('standard', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBe(18);
    expect(guard.current.spentUsd).toBe(18);
  });

  it('counts the tokens', () => {
    const guard = new BudgetGuard(10);
    guard.record('fast', { inputTokens: 100, outputTokens: 50 });
    expect(guard.current.tokens).toBe(150);
  });

  it('allows a request that fits', () => {
    const guard = new BudgetGuard(1);
    expect(() => guard.check('fast', 1000)).not.toThrow();
  });

  it('refuses a request that cannot fit', () => {
    const guard = new BudgetGuard(0.001);
    expect(() => guard.check('deep', 100_000)).toThrow(BudgetExceededError);
  });

  it('refuses a request when the budget is exactly spent', () => {
    const guard = new BudgetGuard(1);
    guard.record('deep', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(() => guard.check('fast', 1000)).toThrow(BudgetExceededError);
  });

  it('never reports a negative remainder', () => {
    const guard = new BudgetGuard(1);
    guard.record('deep', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(guard.remainingUsd).toBe(0);
  });

  it('reports what has been spent', () => {
    const guard = new BudgetGuard(10);
    guard.record('fast', { inputTokens: 1000, outputTokens: 500 });
    expect(guard.report()).toContain('$');
    expect(guard.report()).toContain('tokens');
  });

  it('uses the configured prices', () => {
    const guard = new BudgetGuard(10, {
      fast: { inputPerMillion: 1, outputPerMillion: 1 },
      standard: { inputPerMillion: 1, outputPerMillion: 1 },
      deep: { inputPerMillion: 1, outputPerMillion: 1 },
    });
    const cost = guard.record('fast', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBe(2);
  });
});

describe('the tier router', () => {
  it('sends a request to the client for its tier', async () => {
    const fast = new FakeClient(undefined, 'fast answer');
    const standard = new FakeClient(undefined, 'standard answer');
    const router = new TierRouter();
    router.add({ tier: 'fast', model: 'm1', client: fast });
    router.add({ tier: 'standard', model: 'm2', client: standard });

    const response = await router.send({
      tier: 'fast',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.text).toBe('fast answer');
    expect(response.servedBy).toBe('fast');
  });

  it('falls back to the standard tier', async () => {
    const standard = new FakeClient(undefined, 'standard answer');
    const router = new TierRouter();
    router.add({ tier: 'standard', model: 'm2', client: standard });

    const response = await router.send({
      tier: 'deep',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.text).toBe('standard answer');
    expect(response.servedBy).toBe('standard');
  });

  it('falls back to any client when there is no standard one', async () => {
    const fast = new FakeClient(undefined, 'fast answer');
    const router = new TierRouter();
    router.add({ tier: 'fast', model: 'm1', client: fast });

    const response = await router.send({
      tier: 'deep',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.text).toBe('fast answer');
  });

  it('uses the explicit fallback when there is one', async () => {
    const fallback = new FakeClient(undefined, 'fallback answer');
    const router = new TierRouter({ tier: 'fast', model: 'm0', client: fallback });

    const response = await router.send({
      tier: 'deep',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.text).toBe('fallback answer');
  });

  it('fails when there is no client at all', async () => {
    const router = new TierRouter();
    await expect(
      router.send({ tier: 'fast', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow('no client is registered');
  });

  it('passes the request to the client', async () => {
    const fast = new FakeClient();
    const router = new TierRouter();
    router.add({ tier: 'fast', model: 'm1', client: fast });

    await router.send({ tier: 'fast', messages: [{ role: 'user', content: 'hello' }] });
    expect(fast.received[0]?.messages[0]?.content).toBe('hello');
  });
});

describe('the unavailable client', () => {
  it('says why it is unavailable', async () => {
    const client = new UnavailableClient('the api key is not set');
    await expect(client.send()).rejects.toThrow('the api key is not set');
  });

  it('serves every tier', () => {
    expect(new UnavailableClient('x').tiers).toEqual(['fast', 'standard', 'deep']);
  });
});
