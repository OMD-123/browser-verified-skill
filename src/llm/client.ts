/**
 * The LLM client (M20, Mode B only).
 *
 * Mode A never touches any of this: it is a deterministic browser driver
 * with no model in the loop. Mode B adds a model that decides what to do
 * next, and this is where that model lives.
 *
 * Two things are deliberate:
 *
 *  1. **The client is an interface.** The Anthropic implementation is
 *     loaded lazily, so a Mode A install never downloads it and the
 *     dependency is optional.
 *  2. **The budget is enforced here, not by the caller.** A run that has
 *     spent its budget stops; it does not get one more request "because
 *     this one is important".
 */
import type { z } from 'zod';

/** The tiers a request can be sent to. */
export type Tier = 'fast' | 'standard' | 'deep';

/** A message in the conversation. */
export interface LlmMessage {
  /** Who said it. */
  role: 'user' | 'assistant';
  /** What they said. */
  content: string;
  /** The images to send with it. */
  images?: { mediaType: string; data: string }[];
}

/** A request to a model. */
export interface LlmRequest {
  /** The tier to send it to. */
  tier: Tier;
  /** The messages. */
  messages: LlmMessage[];
  /** The system prompt. */
  system?: string;
  /** The tools the model may call. */
  tools?: LlmTool[];
  /** The maximum tokens to spend. */
  maxTokens?: number;
  /** The temperature. */
  temperature?: number;
}

/** A tool the model may call. */
export interface LlmTool {
  /** The tool's name. */
  name: string;
  /** What it does. */
  description: string;
  /** The schema of its input. */
  inputSchema: z.ZodType<unknown>;
}

/** The model's answer. */
export interface LlmResponse {
  /** The text it produced. */
  text: string;
  /** The tool calls it asked for. */
  toolCalls: { name: string; input: unknown }[];
  /** How many tokens it used. */
  usage: { inputTokens: number; outputTokens: number };
  /** Which tier actually served it. */
  servedBy: Tier;
  /** What it cost, in US dollars. */
  costUsd: number;
  /** How long it took, in milliseconds. */
  durationMs: number;
}

/** A model that can answer a request. */
export interface LlmClient {
  /** The name of the client, for the logs. */
  readonly name: string;
  /** Send a request. */
  send(request: LlmRequest): Promise<LlmResponse>;
  /** The tiers this client can serve. */
  readonly tiers: readonly Tier[];
}

/** The price of a model, per million tokens. */
export interface ModelPrice {
  /** The price per million input tokens, in US dollars. */
  inputPerMillion: number;
  /** The price per million output tokens, in US dollars. */
  outputPerMillion: number;
}

/** The default prices. These are configuration, never constants in code. */
export const DEFAULT_PRICES: Record<Tier, ModelPrice> = {
  fast: { inputPerMillion: 0.25, outputPerMillion: 1.25 },
  standard: { inputPerMillion: 3, outputPerMillion: 15 },
  deep: { inputPerMillion: 15, outputPerMillion: 75 },
};

/**
 * The cost of a request, in US dollars.
 */
export function estimateCost(
  usage: { inputTokens: number; outputTokens: number },
  price: ModelPrice,
): number {
  const input = (usage.inputTokens / 1_000_000) * price.inputPerMillion;
  const output = (usage.outputTokens / 1_000_000) * price.outputPerMillion;
  return input + output;
}

/** The state of the budget. */
export interface BudgetState {
  /** How much has been spent, in US dollars. */
  spentUsd: number;
  /** The limit, in US dollars. */
  limitUsd: number;
  /** The tokens spent. */
  tokens: number;
}

/** Raised when the budget is exhausted. */
export class BudgetExceededError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly limitUsd: number,
  ) {
    super(`the budget is exhausted: $${spentUsd.toFixed(4)} spent of $${limitUsd.toFixed(2)}`);
    this.name = 'BudgetExceededError';
  }
}

/**
 * The budget guard.
 *
 * The budget is checked **before** a request is sent, so a run cannot
 * overshoot by much: the largest single request that could still go
 * through is bounded by the remaining budget.
 */
export class BudgetGuard {
  private state: BudgetState;

  constructor(
    limitUsd: number,
    private readonly prices: Record<Tier, ModelPrice> = DEFAULT_PRICES,
  ) {
    this.state = { spentUsd: 0, limitUsd, tokens: 0 };
  }

  /** The current state. */
  get current(): BudgetState {
    return { ...this.state };
  }

  /** How much is left, in US dollars. */
  get remainingUsd(): number {
    return Math.max(0, this.state.limitUsd - this.state.spentUsd);
  }

  /**
   * Check that a request can be afforded.
   *
   * Throws when the remaining budget is too small for the request's
   * maximum output.
   */
  check(tier: Tier, maxOutputTokens: number): void {
    const price = this.prices[tier];
    const worstCase = (maxOutputTokens / 1_000_000) * price.outputPerMillion;
    if (this.remainingUsd <= worstCase) {
      throw new BudgetExceededError(this.state.spentUsd, this.state.limitUsd);
    }
  }

  /** Record what a request cost. */
  record(tier: Tier, usage: { inputTokens: number; outputTokens: number }): number {
    const cost = estimateCost(usage, this.prices[tier]);
    this.state.spentUsd += cost;
    this.state.tokens += usage.inputTokens + usage.outputTokens;
    return cost;
  }

  /** The report of what has been spent. */
  report(): string {
    return (
      `$${this.state.spentUsd.toFixed(4)} of $${this.state.limitUsd.toFixed(2)} ` +
      `(${this.state.tokens} tokens)`
    );
  }
}

/** The routing rule for a tier. */
export interface RouteRule {
  /** The tier this rule matches. */
  tier: Tier;
  /** The model to use. */
  model: string;
  /** The client that serves it. */
  client: LlmClient;
}

/**
 * The tier router.
 *
 * The router picks a client for a tier. A tier with no client falls back
 * to the `standard` tier, and then to whatever client is available —
 * because a request that has no route is a bug, but a request that fails
 * because of it is worse.
 */
export class TierRouter {
  private readonly rules = new Map<Tier, RouteRule>();

  constructor(private readonly fallback?: RouteRule) {}

  /** Register a route. */
  add(rule: RouteRule): void {
    this.rules.set(rule.tier, rule);
  }

  /** Find the route for a tier. */
  resolve(tier: Tier): RouteRule | undefined {
    const direct = this.rules.get(tier);
    if (direct !== undefined) return direct;

    const standard = this.rules.get('standard');
    if (standard !== undefined) return standard;

    if (this.fallback !== undefined) return this.fallback;
    return this.rules.values().next().value;
  }

  /** Send a request to the right client. */
  async send(request: LlmRequest): Promise<LlmResponse> {
    const route = this.resolve(request.tier);
    if (route === undefined) {
      throw new Error(`no client is registered for the tier ${request.tier}`);
    }

    const response = await route.client.send({ ...request, tier: route.tier });
    return { ...response, servedBy: route.tier };
  }
}

/**
 * A client that always fails.
 *
 * Used when the Anthropic client cannot be loaded, so the failure is
 * clear rather than a stack trace from deep inside a dependency.
 */
export class UnavailableClient implements LlmClient {
  readonly name = 'unavailable';
  readonly tiers: readonly Tier[] = ['fast', 'standard', 'deep'];

  constructor(private readonly reason: string) {}

  send(): Promise<LlmResponse> {
    return Promise.reject(new Error(`the model client is not available: ${this.reason}`));
  }
}
