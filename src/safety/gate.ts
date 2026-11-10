/**
 * The safety gate (M05-M08, M11).
 *
 * This is the single place where an action is checked before it happens. It
 * combines the policy engine, the plan-lock, the taint tracker and the
 * injection guard into one verdict, so that no code path can perform an
 * action without passing through it.
 *
 * The order of the checks matters:
 *
 *  1. **Plan-lock.** An action outside the plan is refused outright, before
 *     any other consideration. A page cannot widen the plan.
 *  2. **Domain.** The action must land on an allowed domain.
 *  3. **Classification.** What kind of action is this?
 *  4. **Injection.** Is the target node injection-suspect?
 *  5. **Taint.** Does the value carry page-sourced data?
 *  6. **Approval.** Does the class or the taint require an approval?
 *
 * A denial at any step stops the action.
 */
import type { ActionClass } from './policy.js';
import { evaluate } from './evaluator.js';
import type { PolicyDecision } from './policy.js';
import { classifyAction, type ActionIntent } from './classify.js';
import { originOf } from './evaluator.js';
import type { PlanDecision, PlanLock } from './planlock.js';
import { checkSink, type TaintSink } from './taint.js';
import { hashAction, type ApprovalRequest, type ApprovalStore } from './approvals.js';
import {
  nodesBlocking,
  nodesNeedingApproval,
  blockingFindingsForValue,
  type Finding,
} from './injection/detectors.js';

/** The verdict of the safety gate. */
export interface GateVerdict {
  /** Whether the action may proceed. */
  allowed: boolean;
  /** The action's class. */
  actionClass: ActionClass;
  /** Why the action was refused, or what it needs. */
  reasons: string[];
  /** The policy rules that were consulted. */
  ruleIds: string[];
  /** What the caller must do next. */
  next: 'proceed' | 'deny' | 'needs_approval' | 'off_plan';
  /** The approval request, when one is needed. */
  approval?: ApprovalRequest;
  /** The plan decision, when the plan refused the action. */
  plan?: PlanDecision;
}

/** What the gate needs to know about the action. */
export interface GateInput {
  /** What the agent wants to do. */
  intent: ActionIntent;
  /** The current page URL. */
  currentUrl: string;
  /**
   * The run this action belongs to.
   *
   * Part of the action hash, so an approval cannot cross runs.
   */
  runId?: string;
  /** Whether the value being used is tainted. */
  tainted?: boolean;
  /** The taint sink, when a value is being used. */
  sink?: TaintSink;
  /** The node the action targets, when it has one. */
  targetRef?: string;
  /** The injection findings for the current snapshot. */
  findings?: readonly Finding[];
  /** Whether the run is interactive (a human can approve). */
  interactive: boolean;
  /** An approval token supplied with the action. */
  approvalToken?: string;
}

/** The policy the gate enforces. */
export interface GatePolicy {
  /** The policy. */
  policy: Parameters<typeof evaluate>[1]['policy'];
  /** The plan-lock. */
  planLock: PlanLock;
  /** The approval store. */
  approvals: ApprovalStore;
}

/**
 * The hash of an action, used to bind an approval to it.
 *
 * The context is part of the hash: an approval for one page must not be
 * spendable on another, and it must not cross runs.
 */
export function actionHashFor(
  intent: ActionIntent,
  context?: { url?: string; origin?: string; runId?: string },
): string {
  const target = intent.name ?? intent.text ?? intent.ref ?? intent.css ?? '';
  return hashAction({
    kind: intent.kind,
    target,
    ...(intent.value !== undefined ? { value: intent.value } : {}),
    ...(context?.url !== undefined ? { url: context.url } : {}),
    ...(context?.origin !== undefined ? { origin: context.origin } : {}),
    ...(context?.runId !== undefined ? { runId: context.runId } : {}),
  });
}

/**
 * Check an action against every safety control.
 *
 * Returns the verdict. The caller must not perform the action unless
 * `allowed` is true.
 */
export function evaluateAction(input: GateInput, gate: GatePolicy): GateVerdict {
  const reasons: string[] = [];
  const ruleIds: string[] = [];
  const actionClass = classifyAction(input.intent);

  // --- 1. The plan-lock ----------------------------------------------------
  const planDecision = gate.planLock.check({
    actionClass,
    ...(input.intent.url !== undefined ? { url: input.intent.url } : {}),
    currentUrl: input.currentUrl,
  });

  if (!planDecision.allowed) {
    return {
      allowed: false,
      actionClass,
      // `planDecision` is narrowed to the refusal variant, so both fields
      // are present.
      reasons: [planDecision.reason],
      ruleIds: [planDecision.ruleId],
      next: 'off_plan',
      plan: planDecision,
    };
  }

  // --- 2. The policy engine ------------------------------------------------
  const decision: PolicyDecision = evaluate(
    {
      kind: input.intent.kind,
      ...(input.intent.url !== undefined ? { url: input.intent.url } : {}),
      ...(input.intent.value !== undefined ? { value: input.intent.value } : {}),
      ...(input.intent.role !== undefined ? { role: input.intent.role } : {}),
      ...(input.intent.name !== undefined ? { name: input.intent.name } : {}),
      ...(input.intent.text !== undefined ? { text: input.intent.text } : {}),
      ...(input.intent.ref !== undefined ? { ref: input.intent.ref } : {}),
      ...(input.intent.inForm !== undefined ? { inForm: input.intent.inForm } : {}),
      ...(input.intent.formMethod !== undefined ? { formMethod: input.intent.formMethod } : {}),
      ...(input.intent.method !== undefined ? { method: input.intent.method } : {}),
    },
    {
      policy: gate.policy,
      url: input.currentUrl,
      nonInteractive: !input.interactive,
      tainted: input.tainted === true,
      approved: false,
    },
  );

  reasons.push(...decision.reasons);
  ruleIds.push(...decision.ruleIds);

  // --- 3. The injection guard ----------------------------------------------
  //
  // Two severities, two different answers:
  //
  //   - `block`: the node IS an attack. Acting on it is what the attack
  //     wants, so it is a hard refusal. It cannot be approved away:
  //     approving it is the attack succeeding.
  //
  //   - `review`: the node looks suspicious. A human should look before
  //     it is acted on, so it needs an approval.
  //
  // A block finding on the TARGET is a refusal. A block finding on the
  // VALUE is also a refusal: the page carried a payload, and the value
  // about to reach a sink is that payload.
  const blockingRefs = nodesBlocking(input.findings ?? []);
  if (input.targetRef !== undefined && blockingRefs.includes(input.targetRef)) {
    reasons.push(
      `the target node ${input.targetRef} has a prompt-injection finding that blocks it; this action is refused and cannot be approved`,
    );
    ruleIds.push('injection.blocked');
    return {
      allowed: false,
      actionClass,
      reasons,
      ruleIds,
      next: 'deny',
    };
  }

  // A target that was named by a DESCRIPTOR rather than a ref has no
  // ref, so its own text is matched against the findings instead. A
  // targetless scan would be too blunt: the page might carry a payload
  // somewhere else entirely, and refusing every action because of it
  // would train the operator to ignore the refusals.
  //
  // Only findings with NO node ref are matched this way. A finding with
  // a node ref belongs to a specific node, and it is checked against
  // that node above. Matching a page-wide finding against the target's
  // text would refuse actions because of a payload that sits somewhere
  // else on the page.
  const targetText = input.intent.text ?? input.intent.name ?? '';
  if (targetText.trim().length > 0) {
    const ownFindings = (input.findings ?? []).filter((finding) => finding.nodeRef === undefined);
    const targetFindings = blockingFindingsForValue(ownFindings, targetText);
    if (targetFindings.length > 0) {
      reasons.push(
        `the target carries a prompt-injection finding (${targetFindings
          .map((finding) => finding.kind)
          .join(', ')}); this action is refused and cannot be approved`,
      );
      ruleIds.push('injection.blocked');
      return {
        allowed: false,
        actionClass,
        reasons,
        ruleIds,
        next: 'deny',
      };
    }
  }

  // Only the findings on a specific node are matched against the
  // value. A page-wide finding's evidence is a window of the page, and
  // the value is usually inside it, so matching against it would refuse
  // every action on a page that carries a payload anywhere.
  const nodeFindings = (input.findings ?? []).filter(
    (finding) => finding.nodeRef !== undefined && finding.nodeRef !== 'page',
  );
  const valueFindings = blockingFindingsForValue(nodeFindings, input.intent.value ?? '');
  if (valueFindings.length > 0) {
    reasons.push(
      `the value carries a prompt-injection finding (${valueFindings
        .map((finding) => finding.kind)
        .join(', ')}); this action is refused and cannot be approved`,
    );
    ruleIds.push('injection.blocked');
    return {
      allowed: false,
      actionClass,
      reasons,
      ruleIds,
      next: 'deny',
    };
  }

  // A node with a "review" finding needs an approval before anything is done
  // to it.
  const suspectRefs = nodesNeedingApproval(input.findings ?? []);
  if (input.targetRef !== undefined && suspectRefs.includes(input.targetRef)) {
    reasons.push(
      `the target node ${input.targetRef} has an injection-suspect finding; it needs review before it is acted on`,
    );
    ruleIds.push('injection.review_required');
  }

  // --- 4. The taint tracker ------------------------------------------------
  // A tainted value cannot reach a sink without an approval. The rule id is
  // `taint.<sink>`, so the check below looks for that prefix rather than a
  // single fixed id.
  if (input.tainted && input.sink !== undefined) {
    const sinkDecision = checkSink(input.intent.value ?? '', input.sink);
    if (!sinkDecision.allowed) {
      // `sinkDecision` is narrowed to the refusal variant.
      reasons.push(sinkDecision.reason);
      ruleIds.push(sinkDecision.ruleId);
    }
  }

  // --- 5. The approval gate ------------------------------------------------
  // An approval is needed when the policy requires it for the class, when the
  // taint refused the sink, or when the injection guard flagged the node.
  const taintedSinkRefused = ruleIds.some((id) => id.startsWith('taint.'));
  const needsApproval =
    decision.verdict === 'needs_approval' ||
    taintedSinkRefused ||
    ruleIds.includes('injection.review_required');

  // A hard denial is never upgraded to "needs approval": a denied action
  // stays denied, whatever the approval state.
  if (decision.verdict === 'deny') {
    return {
      allowed: false,
      actionClass,
      reasons,
      ruleIds,
      next: 'deny',
    };
  }

  if (needsApproval) {
    // The evaluator always records a rule id when it returns
    // `needs_approval`, and the taint and injection paths each add their
    // own, so there is always something to explain the refusal.
    //
    // This fallback is a safety net for a future change to the evaluator. It
    // is unreachable today, so it is excluded from the branch-coverage
    // requirement rather than tested with a contrived input.
    /* v8 ignore next 3 */
    if (ruleIds.length === 0) {
      reasons.push(`the ${actionClass} action class requires an explicit approval`);
      ruleIds.push('policy.approval_required');
    }

    // The hash binds the action to its context: the page origin, the
    // resolved URL and the run. A token approved for one page cannot be
    // spent on another, and cannot cross runs.
    const hash = actionHashFor(input.intent, {
      url: input.currentUrl,
      origin: originOf(input.currentUrl),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
    });

    // A supplied token is consumed only if it matches this exact action
    // in this exact context.
    if (input.approvalToken !== undefined) {
      const consumed = gate.approvals.consume(input.approvalToken, {
        actionId: hash,
        actionHash: hash,
      });
      if (consumed.ok) {
        return {
          allowed: true,
          actionClass,
          reasons,
          ruleIds,
          next: 'proceed',
        };
      }
      reasons.push(consumed.reason);
      ruleIds.push(consumed.ruleId);
    }

    const request = gate.approvals.request({
      actionId: hash,
      actionHash: hash,
      description: describeAction(input.intent, actionClass),
    });

    return {
      allowed: false,
      actionClass,
      reasons,
      ruleIds,
      next: 'needs_approval',
      approval: request,
    };
  }

  return {
    allowed: true,
    actionClass,
    reasons,
    ruleIds,
    next: 'proceed',
  };
}

/**
 * Describe an action for a human who is being asked to approve it.
 *
 * The description must be specific enough that the human knows what they are
 * approving: the action, its target and its value.
 */
export function describeAction(intent: ActionIntent, actionClass: ActionClass): string {
  const target =
    intent.name ?? intent.text ?? intent.ref ?? intent.css ?? intent.label ?? '(unknown target)';
  const parts = [`${intent.kind} on ${target}`];
  if (intent.value !== undefined && intent.value.length > 0) {
    parts.push(
      `value="${intent.value.length > 60 ? `${intent.value.slice(0, 60)}…` : intent.value}"`,
    );
  }
  parts.push(`class=${actionClass}`);
  return parts.join(', ');
}
