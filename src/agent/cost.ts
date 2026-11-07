/**
 * Cost reporting (M28).
 *
 * A run that spends money should say how much, and say it while it is
 * running rather than at the end.
 *
 * The report is built from the **actual token counts** the provider
 * returned. It is not an estimate of an estimate: the numbers come from
 * the usage field, and the prices come from the configuration.
 *
 * Two things the report refuses to do:
 *
 *  1. **It does not round away a small number.** A run that spent
 *     $0.0004 says $0.0004, not $0.00. A report that rounds a cost to
 *     zero is a report that hides a real spend.
 *  2. **It does not mix currencies.** Everything is in US dollars, and
 *     the report says so.
 */
import type { BudgetGuard, BudgetState, LlmResponse, Tier } from '../llm/client.js';

/** One request's cost. */
export interface CostEntry {
  /** When it happened. */
  at: string;
  /** The tier it was sent at. */
  tier: Tier;
  /** The input tokens. */
  inputTokens: number;
  /** The output tokens. */
  outputTokens: number;
  /** What it cost, in US dollars. */
  costUsd: number;
  /** How long it took. */
  durationMs: number;
  /** What it was for, when the caller said. */
  purpose?: string;
}

/** The running total of a run. */
export class CostTracker {
  private entries: CostEntry[] = [];

  /** Record a request. */
  record(response: LlmResponse, purpose?: string): CostEntry {
    const entry: CostEntry = {
      at: new Date().toISOString(),
      tier: response.servedBy,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costUsd: response.costUsd,
      durationMs: response.durationMs,
      ...(purpose !== undefined ? { purpose } : {}),
    };
    this.entries.push(entry);
    return entry;
  }

  /** Every entry. */
  get all(): readonly CostEntry[] {
    return this.entries;
  }

  /** How many requests were made. */
  get count(): number {
    return this.entries.length;
  }

  /** The total cost, in US dollars. */
  get totalUsd(): number {
    return this.entries.reduce((sum, entry) => sum + entry.costUsd, 0);
  }

  /** The total tokens. */
  get totalTokens(): number {
    return this.entries.reduce((sum, entry) => sum + entry.inputTokens + entry.outputTokens, 0);
  }

  /** The total time spent waiting for the model. */
  get totalDurationMs(): number {
    return this.entries.reduce((sum, entry) => sum + entry.durationMs, 0);
  }

  /** The cost per tier. */
  byTier(): Record<Tier, { calls: number; costUsd: number; tokens: number }> {
    const totals: Record<Tier, { calls: number; costUsd: number; tokens: number }> = {
      fast: { calls: 0, costUsd: 0, tokens: 0 },
      standard: { calls: 0, costUsd: 0, tokens: 0 },
      deep: { calls: 0, costUsd: 0, tokens: 0 },
    };

    for (const entry of this.entries) {
      const bucket = totals[entry.tier];
      bucket.calls += 1;
      bucket.costUsd += entry.costUsd;
      bucket.tokens += entry.inputTokens + entry.outputTokens;
    }

    return totals;
  }

  /** The report. */
  report(): string {
    if (this.entries.length === 0) {
      return 'No model requests were made, so nothing was spent.';
    }

    const lines: string[] = [];
    lines.push(
      `${this.count} request(s), ${this.totalTokens} token(s), ` +
        `$${formatUsd(this.totalUsd)} USD in total.`,
    );
    lines.push(`Model time: ${(this.totalDurationMs / 1000).toFixed(1)}s`);

    const tiers = this.byTier();
    lines.push('');
    lines.push('  tier      calls  tokens      cost');
    for (const tier of ['fast', 'standard', 'deep'] as const) {
      const bucket = tiers[tier];
      if (bucket.calls === 0) continue;
      lines.push(
        `  ${tier.padEnd(9)}${String(bucket.calls).padStart(4)}` +
          `${String(bucket.tokens).padStart(9)}  $${formatUsd(bucket.costUsd).padStart(10)}`,
      );
    }

    return lines.join('\n');
  }

  /** The report as JSON. */
  reportJson(): string {
    return JSON.stringify(
      {
        requests: this.count,
        tokens: this.totalTokens,
        costUsd: this.totalUsd,
        durationMs: this.totalDurationMs,
        byTier: this.byTier(),
        entries: this.entries,
        currency: 'USD',
      },
      null,
      2,
    );
  }
}

/**
 * Format a dollar amount.
 *
 * Four decimal places, and never fewer: a cost that rounds to zero is a
 * cost that looks free.
 */
export function formatUsd(amount: number): string {
  if (amount === 0) return '0.0000';
  if (Math.abs(amount) < 0.0001) return amount.toExponential(2);
  return amount.toFixed(4);
}

/**
 * Combine the cost tracker and the budget guard into one report.
 *
 * The budget's state is included, so the report says not only what was
 * spent but how much of the allowance is left.
 */
export function combinedReport(tracker: CostTracker, budget: BudgetGuard | undefined): string {
  if (budget === undefined) return tracker.report();

  const state: BudgetState = budget.current;
  const lines: string[] = [];
  lines.push(tracker.report());
  lines.push('');
  lines.push(
    `Budget: $${formatUsd(state.spentUsd)} of $${formatUsd(state.limitUsd)} spent, ` +
      `$${formatUsd(budget.remainingUsd)} left.`,
  );
  return lines.join('\n');
}

/**
 * The cost per step of a run.
 *
 * A run's cost is more useful per step than in total: a step that costs
 * twenty times the others is the one worth looking at.
 */
export function costPerStep(
  tracker: CostTracker,
  stepCount: number,
): { totalUsd: number; perStepUsd: number } {
  const totalUsd = tracker.totalUsd;
  return {
    totalUsd,
    perStepUsd: stepCount === 0 ? 0 : totalUsd / stepCount,
  };
}

/**
 * The most expensive step.
 *
 * Returns undefined when there were no requests.
 */
export function costliestStep(tracker: CostTracker): CostEntry | undefined {
  let costliest: CostEntry | undefined;
  for (const entry of tracker.all) {
    if (costliest === undefined || entry.costUsd > costliest.costUsd) {
      costliest = entry;
    }
  }
  return costliest;
}
