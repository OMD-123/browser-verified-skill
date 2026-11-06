/**
 * The replay engine (M15).
 *
 * `bv replay flows/x.spec.ts --var k=v` runs a compiled flow deterministically,
 * with **zero LLM cost**. The flow is a list of IR steps; the replayer
 * executes each one and reports what happened.
 *
 * The replayer is deliberately not a TypeScript interpreter. The compiled
 * script is for humans and for CI; the replayer works from the IR, which is
 * what the healer can repair.
 */
import type { Page } from 'playwright';
import type { RecordedStep } from './ir.js';
import { DriftLog, healStep, locatorFor } from './heal.js';

/** The result of replaying one step. */
export interface ReplayStepResult {
  /** The step number. */
  index: number;
  /** Whether it succeeded. */
  ok: boolean;
  /** The strategy that worked. */
  strategy?: string;
  /** The strategies that were tried. */
  attempted: string[];
  /** Why it failed. */
  message?: string;
  /** How long it took. */
  durationMs: number;
  /** The URL after the step. */
  urlAfter: string;
  /** Whether the step was healed. */
  healed: boolean;
}

/** The result of a whole replay. */
export interface ReplayResult {
  /** Whether every step succeeded. */
  ok: boolean;
  /** The result of each step. */
  steps: ReplayStepResult[];
  /** The drift that was recorded while healing. */
  drift: DriftLog;
  /** How many steps were healed. */
  healedCount: number;
  /** How long the replay took. */
  durationMs: number;
}

/** The options for a replay. */
export interface ReplayOptions {
  /** Whether to heal a step whose locator breaks. */
  heal: boolean;
  /** The values of the flow's variables. */
  variables?: Record<string, string>;
}

/**
 * Replay a flow.
 *
 * Each step is executed with the recorded locator chain. When healing is
 * enabled and the first locator fails, the healer walks the fallbacks.
 */
export async function replay(
  page: Page,
  steps: readonly RecordedStep[],
  options: ReplayOptions,
): Promise<ReplayResult> {
  const drift = new DriftLog();
  const results: ReplayStepResult[] = [];
  const startedAt = Date.now();
  let healedCount = 0;

  for (const step of steps) {
    const stepStarted = Date.now();
    const attempted: string[] = [];

    // A `goto` has no target: it navigates.
    if (step.kind === 'goto') {
      try {
        const url = resolveValue(step.params.value, options.variables ?? {}) ?? step.pre.url;
        await page.goto(url);
        results.push({
          index: step.index,
          ok: true,
          strategy: 'goto',
          attempted: [url],
          durationMs: Date.now() - stepStarted,
          urlAfter: page.url(),
          healed: false,
        });
      } catch (err) {
        results.push({
          index: step.index,
          ok: false,
          attempted: [],
          message: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - stepStarted,
          urlAfter: page.url(),
          healed: false,
        });
      }
      continue;
    }

    // Try the **primary** locator first.
    let locator = undefined;
    let strategy: string | undefined;
    let workingStep = step;

    const primary = step.locators[0];
    if (primary !== undefined) {
      attempted.push(primary.value);
      const built = locatorFor(page, primary);
      if (built !== undefined) {
        const count = await built.count().catch(() => 0);
        if (count > 0) {
          locator = built;
          strategy = primary.strategy;
        }
      }
    }

    // The primary locator failed: walk the fallback chain. When healing is
    // enabled this is also recorded as drift, because the step's primary
    // locator has changed and the flow should say so.
    if (locator === undefined && options.heal) {
      const healed = await healStep(page, step, drift);
      attempted.push(...healed.attempted);
      if (healed.healed && healed.step !== undefined) {
        workingStep = healed.step;
        healedCount += 1;
        const repaired = healed.step.locators[0];
        if (repaired !== undefined) {
          const built = locatorFor(page, repaired);
          if (built !== undefined) {
            const count = await built.count().catch(() => 0);
            if (count > 0) {
              locator = built;
              strategy = repaired.strategy;
            }
          }
        }
      }
    }

    // Nothing matched and healing is off: try the remaining chain anyway,
    // so a flow with a broken primary still runs when it can.
    if (locator === undefined && !options.heal) {
      for (const candidate of step.locators.slice(1)) {
        attempted.push(candidate.value);
        const built = locatorFor(page, candidate);
        if (built === undefined) continue;
        const count = await built.count().catch(() => 0);
        if (count > 0) {
          locator = built;
          strategy = candidate.strategy;
          break;
        }
      }
    }

    if (locator === undefined) {
      results.push({
        index: step.index,
        ok: false,
        attempted,
        message: `no locator matched: ${attempted.join(', ')}`,
        durationMs: Date.now() - stepStarted,
        urlAfter: page.url(),
        healed: false,
      });
      continue;
    }

    try {
      await performStep(page, workingStep, locator, options.variables ?? {});
      results.push({
        index: step.index,
        ok: true,
        ...(strategy !== undefined ? { strategy } : {}),
        attempted,
        durationMs: Date.now() - stepStarted,
        urlAfter: page.url(),
        healed: workingStep !== step,
      });
    } catch (err) {
      results.push({
        index: step.index,
        ok: false,
        ...(strategy !== undefined ? { strategy } : {}),
        attempted,
        message: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - stepStarted,
        urlAfter: page.url(),
        healed: false,
      });
    }
  }

  return {
    ok: results.every((r) => r.ok),
    steps: results,
    drift,
    healedCount,
    durationMs: Date.now() - startedAt,
  };
}

/** Perform one step. */
async function performStep(
  page: Page,
  step: RecordedStep,
  locator: ReturnType<Page['locator']>,
  variables: Record<string, string>,
): Promise<void> {
  const value = resolveValue(step.params.value, variables);

  switch (step.kind) {
    case 'goto':
      await page.goto(value ?? step.pre.url);
      break;
    case 'click':
      await locator.click();
      break;
    case 'dblclick':
      await locator.dblclick();
      break;
    case 'hover':
      await locator.hover();
      break;
    case 'fill':
      await locator.fill(value ?? '');
      break;
    case 'type':
      await locator.pressSequentially(value ?? '', { delay: 20 });
      break;
    case 'select':
      await locator.selectOption(step.params.option ?? '');
      break;
    case 'check':
      await locator.check();
      break;
    case 'uncheck':
      await locator.uncheck();
      break;
    case 'press':
      await locator.press(step.params.key ?? 'Enter');
      break;
    case 'upload':
      await locator.setInputFiles(step.params.file ?? '');
      break;
    case 'scroll':
      await page.mouse.wheel(0, step.params.amount ?? 0);
      break;
    case 'wait':
      await locator.waitFor({ state: (step.params.condition ?? 'visible') as 'visible' });
      break;
    default:
      break;
  }
}

/**
 * Resolve a `{{var}}` slot against the supplied variables.
 */
export function resolveValue(
  value: string | undefined,
  variables: Record<string, string>,
): string | undefined {
  if (value === undefined) return undefined;
  const match = /^\{\{(\w+)\}\}$/.exec(value);
  if (match === null) return value;
  const name = match[1] ?? '';
  return variables[name] ?? value;
}

/**
 * Parse the `--var k=v` arguments.
 *
 * A later value for the same name wins, so a command line can override an
 * earlier one.
 */
export function parseVariables(pairs: readonly string[]): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (key.length === 0) continue;
    variables[key] = value;
  }
  return variables;
}

/**
 * Render a replay result for a human.
 */
export function renderReplay(result: ReplayResult): string {
  const lines: string[] = [];
  lines.push(
    result.ok
      ? `Replay succeeded: ${result.steps.length} step(s) in ${result.durationMs}ms.`
      : `Replay failed: ${result.steps.filter((s) => !s.ok).length} of ${result.steps.length} step(s) failed.`,
  );

  if (result.healedCount > 0) {
    lines.push(`${result.healedCount} step(s) were healed.`);
    lines.push(result.drift.render());
  }

  for (const step of result.steps) {
    if (step.ok) {
      lines.push(`  ${step.index}: ok (${step.strategy ?? 'unknown'})`);
    } else {
      lines.push(`  ${step.index}: FAILED — ${step.message ?? 'unknown reason'}`);
      lines.push(`      tried: ${step.attempted.join(', ')}`);
    }
  }

  return lines.join('\n');
}
