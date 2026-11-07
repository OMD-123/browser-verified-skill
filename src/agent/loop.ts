/**
 * The agent loop (M27).
 *
 * Mode B: a model decides what to do next, and this loop is where that
 * decision is carried out.
 *
 * The loop has one property that matters more than anything else: **the
 * safety gate is inside the loop, not above it**. Every action the model
 * proposes goes through the same `evaluateAction` the CLI uses. A model
 * that decides to click something it should not is refused exactly as it
 * would be if a human had asked.
 *
 * The loop also stops on its own. A model that keeps proposing the same
 * failing action is not making progress, and a loop that runs until the
 * budget dies is worse than one that says "I am stuck".
 */
import { evaluateAction, type GateInput, type GatePolicy } from '../safety/gate.js';
import type { Finding } from '../safety/injection/detectors.js';
import type { ActionIntent } from '../safety/classify.js';
import type { LlmClient, LlmRequest, LlmResponse } from '../llm/client.js';

/** What the loop asks the model to do. */
export type AgentAction =
  | { kind: 'snapshot' }
  | { kind: 'click'; target: string }
  | { kind: 'fill'; target: string; value: string }
  | { kind: 'type'; target: string; value: string }
  | { kind: 'select'; target: string; value: string }
  | { kind: 'hover'; target: string }
  | { kind: 'goto'; url: string }
  | { kind: 'verify'; condition: unknown }
  | { kind: 'done'; answer: string }
  | { kind: 'ask'; question: string };

/** What the loop did with one step. */
export interface AgentStep {
  /** The step number. */
  index: number;
  /** What the model proposed. */
  proposed: AgentAction;
  /** What happened. */
  outcome: 'ok' | 'refused' | 'failed' | 'done' | 'asked';
  /** The refusal or failure, when there was one. */
  reason?: string;
  /** The rule ids that refused it. */
  ruleIds?: string[];
  /** The approval id, when the action needed one. */
  approvalId?: string;
  /** How long it took. */
  durationMs: number;
}

/** The result of a whole loop. */
export interface AgentResult {
  /** Whether the loop finished on its own terms. */
  ok: boolean;
  /** The answer, when the model gave one. */
  answer?: string;
  /** Every step. */
  steps: AgentStep[];
  /** Why the loop stopped. */
  stopReason:
    | 'the model finished'
    | 'the step budget ran out'
    | 'the model asked a question'
    | 'the model repeated itself'
    | 'the model made no progress'
    | 'an error stopped the loop';
  /** The steps that were refused. */
  refusals: number;
  /** The steps that failed. */
  failures: number;
}

/** What the loop needs from its environment. */
export interface AgentEnvironment {
  /** Run the proposed action. */
  perform: (action: AgentAction) => Promise<{ ok: boolean; output: string }>;
  /** The current page URL. */
  currentUrl: () => string;
  /** The injection findings for the current page. */
  findings: () => readonly Finding[];
  /** Whether the value being used is tainted. */
  tainted?: () => boolean;
  /** The sink, when a value is being used. */
  sink?: () => GateInput['sink'];
}

/** The options for the loop. */
export interface AgentOptions {
  /** The model client. */
  client: LlmClient;
  /** The safety gate's inputs. */
  gate: GatePolicy;
  /** The maximum number of steps. */
  maxSteps?: number;
  /** The tier to send requests at. */
  tier?: 'fast' | 'standard' | 'deep';
  /** The system prompt. */
  system?: string;
  /** The budget guard, when there is one. */
  budget?: { check: (tier: 'fast' | 'standard' | 'deep', maxTokens: number) => void };
  /** Called after each step. */
  onStep?: (step: AgentStep) => void;
}

/** The default maximum number of steps. */
export const DEFAULT_MAX_STEPS = 30;

/**
 * The agent loop.
 *
 * It asks the model what to do, checks it, does it, and feeds the result
 * back. It stops when the model says it is done, when it asks a question,
 * when it repeats itself, or when the step budget runs out.
 */
export async function runAgentLoop(
  goal: string,
  environment: AgentEnvironment,
  options: AgentOptions,
): Promise<AgentResult> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const tier = options.tier ?? 'standard';

  const steps: AgentStep[] = [];
  const messages: LlmRequest['messages'] = [
    { role: 'user', content: `The goal is: ${goal}\n\nWhat should I do first?` },
  ];

  /** The actions already proposed, for the repetition check. */
  const seen = new Map<string, number>();
  let lastOutput = '';
  let consecutiveFailures = 0;

  for (let index = 1; index <= maxSteps; index++) {
    const startedAt = Date.now();

    // --- Ask the model ---------------------------------------------------
    let response: LlmResponse;
    try {
      options.budget?.check(tier, 4_000);
      response = await options.client.send({
        tier,
        messages,
        ...(options.system !== undefined ? { system: options.system } : {}),
        maxTokens: 2_000,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        steps,
        stopReason: 'an error stopped the loop',
        refusals: 0,
        failures: 0,
        ...(reason.length > 0 ? {} : {}),
      };
    }

    // --- Parse the proposal ----------------------------------------------
    const proposed = parseAction(response.text);
    if (proposed === undefined) {
      const step: AgentStep = {
        index,
        proposed: { kind: 'ask', question: response.text },
        outcome: 'failed',
        reason: 'the model did not propose an action this loop understands',
        durationMs: Date.now() - startedAt,
      };
      steps.push(step);
      options.onStep?.(step);
      consecutiveFailures += 1;
      if (consecutiveFailures >= 3) {
        return {
          ok: false,
          steps,
          stopReason: 'the model made no progress',
          refusals: 0,
          failures: steps.filter((s) => s.outcome === 'failed').length,
        };
      }
      messages.push({ role: 'assistant', content: response.text });
      messages.push({
        role: 'user',
        content:
          'That was not an action. Reply with one action and nothing else, in the form ' +
          '{"action":"click","target":"role=button name=\\"Sign in\\"}.',
      });
      continue;
    }

    // --- The loop ends here ----------------------------------------------
    if (proposed.kind === 'done') {
      const step: AgentStep = {
        index,
        proposed,
        outcome: 'done',
        durationMs: Date.now() - startedAt,
      };
      steps.push(step);
      options.onStep?.(step);
      return {
        ok: true,
        answer: proposed.answer,
        steps,
        stopReason: 'the model finished',
        refusals: steps.filter((s) => s.outcome === 'refused').length,
        failures: steps.filter((s) => s.outcome === 'failed').length,
      };
    }

    if (proposed.kind === 'ask') {
      const step: AgentStep = {
        index,
        proposed,
        outcome: 'asked',
        durationMs: Date.now() - startedAt,
      };
      steps.push(step);
      options.onStep?.(step);
      return {
        ok: false,
        steps,
        stopReason: 'the model asked a question',
        refusals: 0,
        failures: 0,
      };
    }

    // --- The repetition check ---------------------------------------------
    const key = actionKey(proposed);
    const timesSeen = (seen.get(key) ?? 0) + 1;
    seen.set(key, timesSeen);

    if (timesSeen >= 3) {
      const step: AgentStep = {
        index,
        proposed,
        outcome: 'failed',
        reason: `the model proposed "${key}" ${timesSeen} times; it is not making progress`,
        durationMs: Date.now() - startedAt,
      };
      steps.push(step);
      options.onStep?.(step);
      return {
        ok: false,
        steps,
        stopReason: 'the model repeated itself',
        refusals: steps.filter((s) => s.outcome === 'refused').length,
        failures: steps.filter((s) => s.outcome === 'failed').length,
      };
    }

    // --- The safety gate --------------------------------------------------
    const gateInput = gateInputFor(proposed, environment);
    const verdict = evaluateAction(gateInput, options.gate);

    if (!verdict.allowed) {
      const step: AgentStep = {
        index,
        proposed,
        outcome: 'refused',
        reason: verdict.reasons.join('; '),
        ruleIds: verdict.ruleIds,
        ...(verdict.approval !== undefined
          ? { approvalId: verdict.approval.actionId }
          : {}),
        durationMs: Date.now() - startedAt,
      };
      steps.push(step);
      options.onStep?.(step);
      consecutiveFailures += 1;

      // The refusal is fed back, so the model learns what happened. The
      // approval id is included when there is one, so the model can ask
      // for it rather than guessing.
      messages.push({ role: 'assistant', content: response.text });
      messages.push({
        role: 'user',
        content:
          `That action was refused: ${verdict.reasons.join('; ')}.` +
          (verdict.approval !== undefined
            ? ` If it should go ahead, it needs an approval (id ${verdict.approval.actionId}).`
            : ' Do not propose it again; choose a different action.'),
      });

      if (consecutiveFailures >= 5) {
        return {
          ok: false,
          steps,
          stopReason: 'the model made no progress',
          refusals: steps.filter((s) => s.outcome === 'refused').length,
          failures: steps.filter((s) => s.outcome === 'failed').length,
        };
      }
      continue;
    }

    // --- Perform it -------------------------------------------------------
    let outcome: { ok: boolean; output: string };
    try {
      outcome = await environment.perform(proposed);
    } catch (err) {
      outcome = { ok: false, output: err instanceof Error ? err.message : String(err) };
    }

    const step: AgentStep = {
      index,
      proposed,
      outcome: outcome.ok ? 'ok' : 'failed',
      ...(outcome.ok ? {} : { reason: outcome.output }),
      durationMs: Date.now() - startedAt,
    };
    steps.push(step);
    options.onStep?.(step);

    if (outcome.ok) {
      consecutiveFailures = 0;
      lastOutput = outcome.output;
    } else {
      consecutiveFailures += 1;
    }

    messages.push({ role: 'assistant', content: response.text });
    messages.push({
      role: 'user',
      content: outcome.ok
        ? `The action succeeded. The page now says:\n${truncate(outcome.output, 2_000)}\n\nWhat next?`
        : `The action failed: ${outcome.output}\n\nWhat next?`,
    });

    // An output identical to the last one means nothing changed.
    if (outcome.ok && outcome.output === lastOutput && index > 1) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 3) {
        return {
          ok: false,
          steps,
          stopReason: 'the model made no progress',
          refusals: steps.filter((s) => s.outcome === 'refused').length,
          failures: steps.filter((s) => s.outcome === 'failed').length,
        };
      }
    }
  }

  return {
    ok: false,
    steps,
    stopReason: 'the step budget ran out',
    refusals: steps.filter((s) => s.outcome === 'refused').length,
    failures: steps.filter((s) => s.outcome === 'failed').length,
  };
}

/**
 * Build the gate's input for a proposed action.
 *
 * This is the same input the CLI's `act` handler builds, so the gate sees
 * the same thing either way.
 */
export function gateInputFor(
  action: AgentAction,
  environment: AgentEnvironment,
): GateInput {
  const base: GateInput = {
    intent: intentFor(action),
    currentUrl: environment.currentUrl(),
    findings: environment.findings(),
    interactive: true,
  };

  if (action.kind === 'fill' || action.kind === 'type' || action.kind === 'select') {
    const sink = environment.sink?.();
    return {
      ...base,
      ...(environment.tainted?.() === true ? { tainted: true } : {}),
      ...(sink !== undefined ? { sink } : {}),
    };
  }

  return base;
}

/**
 * The action intent for a proposed action.
 *
 * The target is a descriptor like `role=button name="Sign in"`, and it is
 * **parsed into its parts**. Passing the whole string as the name would
 * lose the role, and the classifier needs the role: a click on a link is
 * a navigation, while a click on a button is a submit, and the two are
 * treated very differently.
 */
export function intentFor(action: AgentAction): ActionIntent {
  switch (action.kind) {
    case 'click':
      return { kind: 'click', ...describeTarget(action.target) };
    case 'fill':
      return { kind: 'fill', ...describeTarget(action.target), value: action.value };
    case 'type':
      return { kind: 'type', ...describeTarget(action.target), value: action.value };
    case 'select':
      return { kind: 'select', ...describeTarget(action.target), value: action.value };
    case 'hover':
      return { kind: 'hover', ...describeTarget(action.target) };
    case 'goto':
      return { kind: 'goto', name: action.url };
    case 'snapshot':
      return { kind: 'snapshot' };
    case 'verify':
      return { kind: 'verify' };
    default:
      return { kind: action.kind };
  }
}

/**
 * Parse a target descriptor into its parts.
 *
 * The descriptor format is the same one the CLI uses:
 * `role=button name="Sign in"`, or `label="Email"`, or `text="Continue"`,
 * or a plain CSS selector.
 */
export function describeTarget(target: string): Partial<ActionIntent> {
  const trimmed = target.trim();

  const roleMatch = /^role=(\S+)(?:\s+name="(.*)")?$/.exec(trimmed);
  if (roleMatch !== null) {
    return {
      role: roleMatch[1] ?? '',
      name: roleMatch[2] ?? '',
    };
  }

  const labelMatch = /^label="(.*)"$/.exec(trimmed);
  if (labelMatch !== null) return { name: labelMatch[1] ?? '' };

  const textMatch = /^text="(.*)"$/.exec(trimmed);
  if (textMatch !== null) return { text: textMatch[1] ?? '' };

  // A plain CSS selector: the name is whatever is in it.
  return { name: trimmed };
}

/**
 * Parse the model's reply into an action.
 *
 * The model is asked for JSON. A reply that is not JSON, or that is JSON
 * but not an action, returns undefined — and the loop tells the model what
 * format it wanted, rather than guessing.
 */
export function parseAction(text: string): AgentAction | undefined {
  const trimmed = text.trim();

  // A JSON object, possibly wrapped in a code fence.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced !== null ? fenced[1]?.trim() ?? trimmed : trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    // Maybe it is JSON with something around it.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) return undefined;
    try {
      parsed = JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;

  const kind = record['action'] ?? record['kind'];
  if (typeof kind !== 'string') return undefined;

  const target = record['target'];
  const value = record['value'];

  switch (kind) {
    case 'snapshot':
      return { kind: 'snapshot' };
    case 'click':
      return typeof target === 'string' ? { kind: 'click', target } : undefined;
    case 'fill':
      return typeof target === 'string' && typeof value === 'string'
        ? { kind: 'fill', target, value }
        : undefined;
    case 'type':
      return typeof target === 'string' && typeof value === 'string'
        ? { kind: 'type', target, value }
        : undefined;
    case 'select':
      return typeof target === 'string' && typeof value === 'string'
        ? { kind: 'select', target, value }
        : undefined;
    case 'hover':
      return typeof target === 'string' ? { kind: 'hover', target } : undefined;
    case 'goto':
      return typeof target === 'string'
        ? { kind: 'goto', url: target }
        : typeof record['url'] === 'string'
          ? { kind: 'goto', url: record['url'] }
          : undefined;
    case 'verify':
      return { kind: 'verify', condition: record['condition'] };
    case 'done': {
      const answer = record['answer'];
      return { kind: 'done', answer: typeof answer === 'string' ? answer : '(finished)' };
    }
    case 'ask': {
      const question = record['question'];
      return typeof question === 'string'
        ? { kind: 'ask', question }
        : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * The key of an action, for the repetition check.
 */
export function actionKey(action: AgentAction): string {
  switch (action.kind) {
    case 'click':
    case 'hover':
      return `${action.kind}:${action.target}`;
    case 'fill':
    case 'type':
    case 'select':
      return `${action.kind}:${action.target}:${action.value}`;
    case 'goto':
      return `goto:${action.url}`;
    case 'verify':
      return 'verify';
    default:
      return action.kind;
  }
}

/**
 * Truncate a string.
 */
function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
