/**
 * Plan-lock (M06).
 *
 * Before acting, a plan must be set. The plan declares the goal, a success
 * condition, the allowed origins, the allowed action classes and a step
 * budget. Any action outside that envelope is denied with the reason
 * `off_plan`.
 *
 * The lock lives in the daemon and is checked **at the point of execution**,
 * not in the CLI, so no code path can reach the browser without passing it.
 */
import { z } from 'zod';
import { ACTION_CLASSES, type ActionClass } from './policy.js';
import { normalizeOrigin, originOf } from './evaluator.js';

/**
 * The success-condition DSL.
 *
 * The zod schema and the `Condition` type are kept in step by deriving the
 * type from the schema. The `element` variant's optional fields are typed as
 * `?: string | undefined` rather than `?: string`, because that is what zod
 * produces for an optional field under `exactOptionalPropertyTypes`.
 */
export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(ConditionSchema) }).strict(),
    z.object({ any: z.array(ConditionSchema) }).strict(),
    z.object({ not: ConditionSchema }).strict(),
    z.object({ type: z.literal('url_matches'), pattern: z.string().min(1) }).strict(),
    z.object({ type: z.literal('text_visible'), text: z.string().min(1) }).strict(),
    z
      .object({
        type: z.literal('element'),
        role: z.string().min(1),
        name: z.string().optional(),
        min: z.number().int().min(0).optional(),
        max: z.number().int().min(0).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('network_response'),
        urlPattern: z.string().min(1),
        status: z.number().int(),
      })
      .strict(),
    z.object({ type: z.literal('storage'), key: z.string().min(1), matches: z.string() }).strict(),
    z.object({ type: z.literal('llm_judged'), claim: z.string().min(1) }).strict(),
  ]),
);

/** A success condition. */
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { type: 'url_matches'; pattern: string }
  | { type: 'text_visible'; text: string }
  | {
      type: 'element';
      role: string;
      name?: string | undefined;
      min?: number | undefined;
      max?: number | undefined;
    }
  | { type: 'network_response'; urlPattern: string; status: number }
  | { type: 'storage'; key: string; matches: string }
  | { type: 'llm_judged'; claim: string };

/** The plan schema. */
export const PlanSchema = z
  .object({
    goal: z.string().min(1),
    successCondition: ConditionSchema,
    allowedOrigins: z.array(z.string().min(1)).default([]),
    allowedActionClasses: z.array(z.enum(ACTION_CLASSES)).default([]),
    maxSteps: z.number().int().positive().default(80),
    createdAt: z.string().min(1),
  })
  .strict();

/** A plan. */
export type Plan = z.infer<typeof PlanSchema>;

/** The result of a plan-lock check. */
export type PlanDecision =
  | {
      /** The action is inside the plan. */
      allowed: true;
    }
  | {
      /** The action is outside the plan. */
      allowed: false;
      /** The reason it was refused. */
      reason: string;
      /** The rule id, for auditing. */
      ruleId: string;
    };

/** Build a plan. */
export function createPlan(input: {
  goal: string;
  successCondition: Condition;
  allowedOrigins?: readonly string[];
  allowedActionClasses?: readonly ActionClass[];
  maxSteps?: number;
  createdAt?: string;
}): Plan {
  return PlanSchema.parse({
    goal: input.goal,
    successCondition: input.successCondition,
    allowedOrigins: input.allowedOrigins === undefined ? [] : [...input.allowedOrigins],
    allowedActionClasses:
      input.allowedActionClasses === undefined ? [] : [...input.allowedActionClasses],
    maxSteps: input.maxSteps === undefined ? 80 : input.maxSteps,
    createdAt: input.createdAt === undefined ? new Date().toISOString() : input.createdAt,
  });
}

/**
 * The plan lock.
 *
 * Holds the current plan and checks actions against it.
 */
export class PlanLock {
  private plan: Plan | undefined;
  private stepsUsed = 0;

  /** The current plan. */
  get current(): Plan | undefined {
    return this.plan;
  }

  /** True when a plan is set. */
  get hasPlan(): boolean {
    return this.plan !== undefined;
  }

  /** How many steps have been taken under the current plan. */
  get steps(): number {
    return this.stepsUsed;
  }

  /**
   * Set the plan.
   *
   * Setting a plan resets the step counter.
   */
  set(plan: Plan): void {
    this.plan = plan;
    this.stepsUsed = 0;
  }

  /** Remove the plan. */
  clear(): void {
    this.plan = undefined;
    this.stepsUsed = 0;
  }

  /**
   * Amend the plan.
   *
   * Amending requires approval: the caller must pass `approved: true`, which
   * the approval gate sets after a human has agreed. Amending is also
   * audit-logged by the caller.
   */
  amend(
    changes: Partial<Omit<Plan, 'createdAt'>>,
    options: { approved: boolean },
  ): { ok: true; plan: Plan } | { ok: false; reason: string } {
    if (this.plan === undefined) {
      return { ok: false, reason: 'no plan is set' };
    }
    if (!options.approved) {
      return { ok: false, reason: 'amending a plan requires approval' };
    }
    const merged = PlanSchema.safeParse({
      ...this.plan,
      ...changes,
      createdAt: this.plan.createdAt,
    });
    if (!merged.success) {
      // zod always reports at least one issue for a failed parse.
      const firstIssue = merged.error.issues[0] as { message: string };
      return {
        ok: false,
        reason: `the amended plan is invalid: ${firstIssue.message}`,
      };
    }
    this.plan = merged.data;
    return { ok: true, plan: merged.data };
  }

  /**
   * Check an action against the plan.
   *
   * The checks, in order:
   *  1. a plan must be set,
   *  2. the step budget must not be exceeded,
   *  3. the action class must be in `allowedActionClasses`,
   *  4. the target origin must be in `allowedOrigins`.
   */
  check(options: {
    actionClass: ActionClass;
    /** The URL the action would land at. */
    url?: string;
    /** The URL the session is currently on. */
    currentUrl?: string;
    /** True when the action is a navigation to a different origin. */
    crossesOrigin?: boolean;
  }): PlanDecision {
    const plan = this.plan;
    if (plan === undefined) {
      return {
        allowed: false,
        reason: 'no plan is set: run `bv plan set <file>` before acting',
        ruleId: 'plan.not_set',
      };
    }

    if (this.stepsUsed >= plan.maxSteps) {
      return {
        allowed: false,
        reason: `the plan's step budget of ${plan.maxSteps} is exhausted`,
        ruleId: 'plan.budget_exhausted',
      };
    }

    if (!plan.allowedActionClasses.includes(options.actionClass)) {
      return {
        allowed: false,
        reason: `the "${options.actionClass}" action class is not in the plan`,
        ruleId: 'plan.off_plan.action_class',
      };
    }

    const target = options.url ?? options.currentUrl;
    if (target !== undefined && plan.allowedOrigins.length > 0) {
      const targetOrigin = normalizeOrigin(originOf(target));
      const allowed = plan.allowedOrigins.some((o) => normalizeOrigin(o) === targetOrigin);
      if (!allowed) {
        return {
          allowed: false,
          reason: `the origin "${targetOrigin}" is not in the plan`,
          ruleId: 'plan.off_plan.origin',
        };
      }
    }

    return { allowed: true };
  }

  /** Record that a step was taken. */
  recordStep(): void {
    this.stepsUsed += 1;
  }
}
