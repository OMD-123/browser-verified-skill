/* eslint-disable @typescript-eslint/require-await -- some handlers are
 * genuinely synchronous but must return a Promise to match the handler
 * type. */

/**
 * The daemon's browser-facing entry point.
 *
 * This module is what actually runs as the detached process. It starts the
 * HTTP daemon, wires the handlers to a `BrowserSession`, and writes the
 * descriptor to disk.
 */
import { readFile } from 'node:fs/promises';
import { startDaemon, type DaemonHandler, type DaemonRequest } from './daemon.js';
import { writeDaemonInfo, clearDaemonInfo, type DaemonInfo } from './daemon-info.js';
import { BrowserSession, buildUserAgent } from './session.js';
import { RunStore, newRunId } from './runstore/store.js';
import { ensureBvDir } from './paths.js';
import { renderDiff, renderTree } from '../perception/render.js';
import { parseTarget, type ActionKind, type TargetDescriptor } from '../actions/locate.js';
import { EXIT } from './exit.js';
import type { Page } from 'playwright';
import { ACTION_CLASSES, loadPolicy, type Policy } from '../safety/policy.js';
import { PlanLock, PlanSchema, type Plan } from '../safety/planlock.js';
import { ApprovalStore, hashAction } from '../safety/approvals.js';
import { evaluateAction } from '../safety/gate.js';
import { inspectTarget } from '../safety/inspect.js';
import { sinkForField } from '../safety/taint.js';
import { isTainted } from '../safety/taint.js';
import {
  InjectionScanner,
  type DomScanInput,
  type Finding,
} from '../safety/injection/detectors.js';
import { verify } from '../verify/verifier.js';
import { summarizeVerification } from '../verify/evidence.js';
import { extract } from '../verify/extract.js';
import { replay, renderReplay } from '../compile/replay.js';
import { Recorder, candidatesFor, diffText, readPageText } from '../compile/recorder.js';
import type { StepKind as RecorderStepKind } from '../compile/ir.js';
import { readRun } from './runstore/store.js';
import { findSnapshot, planRewind } from '../compile/snapshots.js';
import type { Condition } from '../safety/planlock.js';

/** Options for the daemon process. */
export interface DaemonProcessOptions {
  /** The working directory holding `.bv/`. */
  cwd: string;
  /** The session name. */
  session: string;
  /** Whether the browser is headed. */
  headed: boolean;
  /** The contact URL for the honest user agent. */
  contactUrl?: string;
  /** The run id. Generated when not supplied. */
  runId?: string;
}

/**
 * The type of a condition, for the run result.
 */
function describeType(condition: Condition): string {
  if ('all' in condition) return 'all';
  if ('any' in condition) return 'any';
  if ('not' in condition) return 'not';
  return condition.type;
}

/**
 * The action classes a plan may allow.
 *
 * Used to reject an unknown class in an amendment rather than widening the
 * plan with a value that means nothing.
 */
const ACTION_CLASS_SET = new Set<string>(ACTION_CLASSES);

/**
 * Collect the injection findings for the current page.
 *
 * Two sources are used: the text of the visible tree, and the DOM signals
 * that the tree does not carry (hidden text, comments, attributes, CSS
 * `content:`).
 */
async function scanForFindings(
  session: BrowserSession,
  scanner: InjectionScanner,
): Promise<Finding[]> {
  const page = await session.page();

  const visible = await page
    .locator('body')
    .innerText({ timeout: 2_000 })
    .catch(() => '');

  const dom = await collectDomSignals(page);

  const result = scanner.scanDom(dom);
  const textResult = scanner.scan([{ text: visible }]);

  return [...result.findings, ...textResult.findings];
}

/**
 * The DOM-level signals the injection guard looks for.
 *
 * Every value is read with `evaluate`, which returns data only. Nothing here
 * can run code in the page beyond what Playwright's own `evaluate` does.
 */
async function collectDomSignals(page: Page): Promise<DomScanInput> {
  const raw = await page
    .evaluate(() => {
      const out: Record<string, unknown> = {
        hiddenText: [],
        ariaHiddenText: [],
        comments: [],
        attributes: [],
        cssContent: [],
        noscript: [],
        hiddenFields: [],
      };

      const push = (bucket: string, value: unknown): void => {
        const list = out[bucket];
        if (Array.isArray(list)) list.push(value);
      };

      // Hidden text: elements that are not visible but still carry text.
      const all = Array.from(document.querySelectorAll('*'));
      for (const el of all) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const text = (el.textContent ?? '').trim();
        if (text.length === 0) continue;

        const hidden =
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.opacity === '0' ||
          style.fontSize === '0px' ||
          (rect.width === 0 && rect.height === 0) ||
          rect.top < -1000 ||
          rect.left < -1000;

        if (hidden) {
          push('hiddenText', { text: text.slice(0, 2000) });
        }

        if (el.getAttribute('aria-hidden') === 'true') {
          push('ariaHiddenText', { text: text.slice(0, 2000) });
        }
      }

      // HTML comments.
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
      let comment = walker.nextNode();
      while (comment !== null) {
        const text = (comment.textContent ?? '').trim();
        if (text.length > 0) push('comments', text.slice(0, 2000));
        comment = walker.nextNode();
      }

      // Attributes that may carry instructions.
      const attributeNames = ['alt', 'title', 'aria-label', 'placeholder', 'content', 'value'];
      for (const el of all) {
        for (const name of attributeNames) {
          const value = el.getAttribute(name);
          if (value !== null && value.trim().length > 0) {
            push('attributes', { attribute: name, value: value.slice(0, 1000) });
          }
        }
      }

      // Meta tags.
      for (const meta of Array.from(document.querySelectorAll('meta'))) {
        const content = meta.getAttribute('content');
        if (content !== null && content.trim().length > 0) {
          push('attributes', { attribute: 'meta', value: content.slice(0, 1000) });
        }
      }

      // CSS `content:` values.
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList | undefined;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        if (rules === undefined) continue;
        for (const rule of Array.from(rules)) {
          const text = rule.cssText;
          const match = /content:\s*("[^"]*"|'[^']*')/.exec(text);
          if (match?.[1] !== undefined) {
            push('cssContent', match[1].slice(1, -1));
          }
        }
      }

      // Noscript blocks.
      for (const el of Array.from(document.querySelectorAll('noscript'))) {
        const text = (el.textContent ?? '').trim();
        if (text.length > 0) push('noscript', text.slice(0, 2000));
      }

      // Hidden form fields with suspicious names.
      for (const el of Array.from(document.querySelectorAll('input[type="hidden"]'))) {
        const name = el.getAttribute('name') ?? '';
        if (/token|secret|key|password|pass|auth|credit|ssn|card/i.test(name)) {
          push('hiddenFields', { name, value: (el.getAttribute('value') ?? '').slice(0, 200) });
        }
      }

      return out;
    })
    .catch(() => undefined);

  if (raw === undefined) {
    return {
      hiddenText: [],
      ariaHiddenText: [],
      comments: [],
      attributes: [],
      cssContent: [],
      noscript: [],
      hiddenFields: [],
    };
  }

  return raw as unknown as DomScanInput;
}

/** The action kinds the daemon accepts. */
const ACTION_KINDS: readonly ActionKind[] = [
  'click',
  'dblclick',
  'hover',
  'type',
  'fill',
  'select',
  'check',
  'uncheck',
  'press',
  'scroll',
  'upload',
  'focus',
];

/** Start the daemon process and serve until it is stopped. */
/** The context the handler factory needs. */
export interface DaemonContext {
  /** The run id. */
  runId: string;
  /** The run store. */
  store: RunStore;
  /** The working directory. */
  cwd: string;
  /** Whether the browser is headed. */
  headed?: boolean;
  /** The policy. */
  policy: Policy;
  /** The plan lock. */
  planLock: PlanLock;
  /** The approval store. */
  approvals: ApprovalStore;
  /** The injection scanner. */
  scanner: InjectionScanner;
  /** The recorder. */
  recorder: Recorder;
  /** Get the browser session, launching it if needed. */
  getSession: () => Promise<BrowserSession>;
}

/**
 * Build the daemon's handlers.
 *
 * This is separate from the HTTP server so the handlers can be exercised
 * directly, in-process. The daemon's behaviour is then testable without a
 * listening socket, and the coverage report shows what is really exercised.
 */
export function createHandlers(context: DaemonContext): Record<string, DaemonHandler> {
  const { store, policy, planLock, approvals, scanner, recorder, getSession } = context;
  const runId = context.runId;
  const options = { cwd: context.cwd, headed: context.headed === true };

  const handlers: Record<string, DaemonHandler> = {
    snapshot: async (request: DaemonRequest) => {
      const s = await getSession();
      const params = request.params ?? {};
      const maxTokens = typeof params['maxTokens'] === 'number' ? params['maxTokens'] : undefined;
      const full = params['full'] === true;
      const capture = await s.capture({
        full,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      });
      return {
        data: {
          header: capture.diff.header,
          diff: renderDiff(capture.diff, {
            ...(capture.previousUrl !== undefined ? { previousUrl: capture.previousUrl } : {}),
          }),
          tree: full ? renderTree(capture.pruned) : undefined,
          snapshotPath: capture.path,
          estimatedTokens: capture.estimatedTokens,
          nodeCount: capture.snapshot.nodeCount,
          prunedCount: capture.snapshot.prunedCount,
          navigated: capture.diff.navigated,
        },
      };
    },

    // --- The plan-lock ----------------------------------------------------
    'plan.set': async (request: DaemonRequest) => {
      const params = request.params ?? {};
      const raw = params['plan'];
      const parsed = PlanSchema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
        return {
          data: { ok: false, error: `the plan is not valid: ${issues}` },
          exitCode: EXIT.USAGE,
        };
      }
      planLock.set(parsed.data);
      return {
        data: {
          ok: true,
          plan: parsed.data,
          message: `plan set: ${parsed.data.goal}`,
        },
      };
    },

    'plan.show': async () => ({
      data: { plan: planLock.current },
    }),

    'plan.amend': async (request: DaemonRequest) => {
      const params = request.params ?? {};
      const patch = params['patch'];
      const current = planLock.current;
      if (current === undefined) {
        return {
          data: { ok: false, error: 'no plan is set' },
          exitCode: EXIT.FAILURE,
        };
      }

      const p = (patch ?? {}) as {
        goal?: string;
        maxSteps?: number;
        addOrigins?: string[];
        addClasses?: string[];
      };

      const amended: Plan = {
        ...current,
        ...(p.goal !== undefined ? { goal: p.goal } : {}),
        ...(p.maxSteps !== undefined ? { maxSteps: p.maxSteps } : {}),
        allowedOrigins: [
          ...current.allowedOrigins,
          ...(p.addOrigins ?? []).filter((o) => !current.allowedOrigins.includes(o)),
        ],
        allowedActionClasses: [
          ...current.allowedActionClasses,
          ...(p.addClasses ?? []).filter(
            (c): c is Plan['allowedActionClasses'][number] =>
              ACTION_CLASS_SET.has(c) &&
              !current.allowedActionClasses.includes(c as Plan['allowedActionClasses'][number]),
          ),
        ],
      };

      // An amendment widens what the agent may do, so it needs an approval
      // that was issued for exactly this amendment. The approval is bound to
      // the hash of the amendment, so a token issued for one amendment
      // cannot be used for another.
      const hash = hashAction({
        kind: 'plan.amend',
        target: JSON.stringify(amended),
      });

      const token = params['approvalToken'];
      if (typeof token !== 'string') {
        // No token: record the request so a human can approve it.
        const request = approvals.request({
          actionId: hash,
          actionHash: hash,
          description: `amend the plan to: ${amended.goal}`,
        });
        return {
          data: {
            ok: false,
            error: 'amending a plan requires an approval',
            approvalId: request.actionId,
            approvalDescription: request.description,
          },
          exitCode: EXIT.NEEDS_APPROVAL,
        };
      }

      const consumed = approvals.consume(token, { actionId: hash, actionHash: hash });
      if (!consumed.ok) {
        return {
          data: { ok: false, error: consumed.reason, ruleId: consumed.ruleId },
          exitCode: EXIT.POLICY_DENIED,
        };
      }

      const result = planLock.amend(amended, { approved: true });
      if (!result.ok) {
        return {
          data: { ok: false, error: result.reason },
          exitCode: EXIT.POLICY_DENIED,
        };
      }
      return {
        data: { ok: true, plan: result.plan, message: `plan amended: ${result.plan.goal}` },
      };
    },

    // --- Approvals --------------------------------------------------------
    'approve.issue': async (request: DaemonRequest) => {
      const params = request.params ?? {};
      const actionId = params['actionId'];
      if (typeof actionId !== 'string') {
        return {
          data: { ok: false, error: 'actionId is required' },
          exitCode: EXIT.USAGE,
        };
      }
      const pending = approvals.getPending(actionId);
      if (pending === undefined) {
        return { data: { ok: false, error: `no pending action with id ${actionId}` } };
      }
      const token = approvals.issue(actionId);
      if (token === undefined) {
        return { data: { ok: false, error: `could not issue a token for ${actionId}` } };
      }
      return {
        data: { ok: true, token: token.token, description: pending.description },
      };
    },

    'approve.list': async () => ({
      data: { pending: approvals.listPending() },
    }),

    // --- Rewind -----------------------------------------------------------
    rewind: async (request: DaemonRequest) => {
      const s = await getSession();
      const params = request.params ?? {};
      const to = params['to'];
      if (typeof to !== 'number' || !Number.isInteger(to) || to < 1) {
        return { data: { error: '--to must be a step number' }, exitCode: EXIT.USAGE };
      }

      const sourceRun = typeof params['runId'] === 'string' ? params['runId'] : runId;
      const snapshot = await findSnapshot(sourceRun, to, options.cwd);
      const branchRunId =
        typeof params['branchRunId'] === 'string' ? params['branchRunId'] : `${runId}-r${to}`;

      const plan = planRewind(snapshot, to);

      const page = await s.page();

      // Restore the storage state, when there is one. The browser context is
      // replaced, because Playwright's storage state is applied at context
      // creation.
      if (snapshot?.statePath !== undefined) {
        try {
          const raw = await readFile(snapshot.statePath, 'utf8');
          const state = JSON.parse(raw) as { storageState?: unknown };
          if (state.storageState !== undefined) {
            await s.replaceStorageState(state.storageState);
          }
        } catch {
          // A missing or unreadable state file is not fatal: the browser
          // simply starts without it.
        }
      }

      if (plan.url.length > 0) {
        await page.goto(plan.url);
      }

      const branchStore = new RunStore(branchRunId, options.cwd);
      await branchStore.init();
      await branchStore.writeResult({
        runId: branchRunId,
        status: 'running',
        steps: 0,
        startedAt: new Date().toISOString(),
        ...(plan.url.length > 0 ? { finalUrl: plan.url } : {}),
      });

      return {
        data: {
          branchRunId,
          toStep: to,
          url: plan.url,
          storageRestored: plan.storageRestored,
          notRestored: plan.notRestored,
          sourceRun,
        },
      };
    },

    // --- Verification ----------------------------------------------------
    verify: async (request: DaemonRequest) => {
      const s = await getSession();
      const params = request.params ?? {};
      const condition = params['condition'] as Condition;

      const page = await s.page();
      const network = s.networkFacts;
      const storage = await s.storageSnapshot();

      const result = await verify(condition, {
        page,
        ...(network !== undefined ? { network } : {}),
        ...(storage !== undefined ? { storage } : {}),
      });

      // A run that did not verify is `unverified`, never "done".
      await store.writeResult({
        runId,
        status: result.passed ? 'verified' : 'unverified',
        steps: store.stepCount,
        startedAt: store.started,
        ...(s.currentUrl !== undefined ? { finalUrl: s.currentUrl } : {}),
        verification: {
          passed: result.passed,
          conditions: result.results.map((item) => ({
            type: describeType(item.condition),
            passed: item.passed,
            detail: item.reason,
          })),
        },
      });

      return {
        data: {
          passed: result.passed,
          results: result.results.map((item) => ({
            condition: item.condition,
            passed: item.passed,
            reason: item.reason,
          })),
          evidence: result.evidence,
          verifiedAt: result.verifiedAt,
          url: result.url,
          summary: summarizeVerification(result),
        },
        ...(result.passed ? {} : { exitCode: EXIT.VERIFICATION_FAILED }),
      };
    },

    // --- Extraction -------------------------------------------------------
    extract: async (request: DaemonRequest) => {
      const s = await getSession();
      const params = request.params ?? {};
      const schema = params['schema'];

      const page = await s.page();
      const result = await extract(page, schema);

      return {
        data: {
          fields: result.fields,
          order: result.order,
          extractedAt: result.extractedAt,
          url: result.url,
        },
      };
    },

    // --- Replay ----------------------------------------------------------
    replay: async (request: DaemonRequest) => {
      const s = await getSession();
      const params = request.params ?? {};
      const runId = params['runId'];
      if (typeof runId !== 'string') {
        return { data: { ok: false, error: 'runId is required' }, exitCode: EXIT.USAGE };
      }

      const run = await readRun(runId, options.cwd);
      const page = await s.page();
      const result = await replay(page, run.steps, {
        heal: params['heal'] === true,
        variables: (params['variables'] ?? {}) as Record<string, string>,
      });

      return {
        data: {
          ok: result.ok,
          steps: result.steps,
          drift: result.drift.all,
          healedCount: result.healedCount,
          durationMs: result.durationMs,
          summary: renderReplay(result),
        },
        ...(result.ok ? {} : { exitCode: EXIT.VERIFICATION_FAILED }),
      };
    },

    act: async (request: DaemonRequest) => {
      const s = await getSession();
      const params = request.params ?? {};
      const kind = params['kind'];
      if (typeof kind !== 'string' || !ACTION_KINDS.includes(kind as ActionKind)) {
        return {
          data: { error: `unknown action kind: ${String(kind)}` },
          exitCode: EXIT.USAGE,
        };
      }
      const targetInput = params['target'];
      const target: TargetDescriptor =
        typeof targetInput === 'object' && targetInput !== null
          ? targetInput
          : parseTarget(typeof targetInput === 'string' ? targetInput : '');

      const value = typeof params['value'] === 'string' ? params['value'] : undefined;

      // --- The safety gate -------------------------------------------------
      // Every action passes through the gate before it happens. The gate is
      // the only place a refusal can come from, so no code path can perform
      // an unchecked action.
      const page = await s.page();
      const facts = await inspectTarget(page, target);
      const currentUrl = page.url();

      // The value is tainted when it came from the page rather than from the
      // operator's own command line.
      const tainted = value !== undefined && isTainted(value);

      // The sink is determined by the field the value would go into.
      const sink = sinkForField({
        ...(facts.role !== undefined ? { role: facts.role } : {}),
        ...(facts.name !== undefined ? { name: facts.name } : {}),
        ...(facts.inputType !== undefined ? { inputType: facts.inputType } : {}),
      });

      // The injection findings for the node the action targets.
      const findings: Finding[] = await scanForFindings(s, scanner);

      const verdict = evaluateAction(
        {
          intent: {
            kind,
            ...(value !== undefined ? { value } : {}),
            ...(facts.role !== undefined ? { role: facts.role } : {}),
            ...(facts.name !== undefined ? { name: facts.name } : {}),
            ...(facts.text !== undefined ? { text: facts.text } : {}),
            ...(facts.inputType !== undefined ? { inputType: facts.inputType } : {}),
            ...(facts.isFileInput !== undefined ? { isFileInput: facts.isFileInput } : {}),
            ...(facts.inForm !== undefined ? { inForm: facts.inForm } : {}),
            ...(facts.formMethod !== undefined ? { formMethod: facts.formMethod } : {}),
            ...(target.ref !== undefined ? { ref: target.ref } : {}),
            ...(target.css !== undefined ? { css: target.css } : {}),
            ...(target.label !== undefined ? { label: target.label } : {}),
            ...(kind === 'goto' ? { url: target.css ?? '' } : {}),
          },
          currentUrl,
          tainted,
          ...(sink !== undefined ? { sink } : {}),
          ...(target.ref !== undefined ? { targetRef: target.ref } : {}),
          findings,
          interactive: options.headed,
          ...(typeof params['approvalToken'] === 'string'
            ? { approvalToken: params['approvalToken'] }
            : {}),
        },
        { policy, planLock, approvals },
      );

      if (!verdict.allowed) {
        const exitCode =
          verdict.next === 'needs_approval' ? EXIT.NEEDS_APPROVAL : EXIT.POLICY_DENIED;
        return {
          data: {
            ok: false,
            denied: true,
            next: verdict.next,
            actionClass: verdict.actionClass,
            reasons: verdict.reasons,
            ruleIds: verdict.ruleIds,
            ...(verdict.approval !== undefined
              ? {
                  approvalId: verdict.approval.actionId,
                  approvalDescription: verdict.approval.description,
                }
              : {}),
          },
          exitCode,
        };
      }

      planLock.recordStep();

      // The text before the action, for the assertions the recorder infers.
      const textBefore = await readPageText(page);

      const outcome = await s.act({
        kind: kind as ActionKind,
        target,
        ...(value !== undefined ? { value } : {}),
        ...(params['force'] === true ? { force: true } : {}),
      });

      // Record the step, so the run can be compiled into a Playwright
      // script later. A failed action is not recorded: the IR describes
      // what worked.
      if (outcome.ok) {
        const textAfter = await readPageText(page);
        const changes = diffText(textBefore, textAfter);
        recorder.record({
          kind: kind as RecorderStepKind,
          locators: candidatesFor(target),
          ...(outcome.strategy !== undefined ? { winningStrategy: outcome.strategy } : {}),
          ...(value !== undefined ? { value } : {}),
          pre: { url: outcome.urlBefore },
          post: {
            url: outcome.urlAfter,
            addedText: changes.added,
            removedText: changes.removed,
          },
          durationMs: outcome.durationMs,
        });
        await store.writeRecorded(recorder.finish());
      }
      return {
        data: {
          ok: outcome.ok,
          kind: outcome.kind,
          strategy: outcome.strategy,
          attempted: outcome.attempted,
          failures: outcome.failures,
          message: outcome.message,
          durationMs: outcome.durationMs,
          urlBefore: outcome.urlBefore,
          urlAfter: outcome.urlAfter,
          diff: outcome.diff,
          step: outcome.step,
        },
        ...(outcome.ok ? {} : { exitCode: EXIT.FAILURE }),
      };
    },

    goto: async (request: DaemonRequest) => {
      const s = await getSession();
      const url = (request.params ?? {})['url'];
      if (typeof url !== 'string') {
        return { data: { error: 'missing url' }, exitCode: EXIT.USAGE };
      }
      const page = await s.page();
      const urlBefore = page.url();
      const result = await s.goto(url);

      // The navigation is recorded as a step, so the compiled script can
      // replay the flow from the start rather than assuming the page is
      // already open.
      if (result.ok) {
        recorder.record({
          kind: 'goto',
          locators: [],
          value: url,
          pre: { url: urlBefore },
          post: { url: result.url },
          durationMs: 0,
        });
        await store.writeRecorded(recorder.finish());
      }

      return {
        data: result,
        ...(result.ok ? {} : { exitCode: EXIT.FAILURE }),
      };
    },

    tabs: async () => {
      const s = await getSession();
      return { data: { tabs: await s.tabs() } };
    },

    'tab.select': async (request: DaemonRequest) => {
      const s = await getSession();
      const index = (request.params ?? {})['index'];
      if (typeof index !== 'number') {
        return { data: { error: 'missing index' }, exitCode: EXIT.USAGE };
      }
      try {
        s.sessionState.selectTab(index);
        return { data: { ok: true, index } };
      } catch (err) {
        return {
          data: { ok: false, error: err instanceof Error ? err.message : String(err) },
          exitCode: EXIT.FAILURE,
        };
      }
    },

    'tab.close': async (request: DaemonRequest) => {
      const s = await getSession();
      const index = (request.params ?? {})['index'];
      if (typeof index !== 'number') {
        return { data: { error: 'missing index' }, exitCode: EXIT.USAGE };
      }
      try {
        await s.sessionState.closeTab(index);
        return { data: { ok: true, index } };
      } catch (err) {
        return {
          data: { ok: false, error: err instanceof Error ? err.message : String(err) },
          exitCode: EXIT.FAILURE,
        };
      }
    },

    'storage.state': async () => {
      const s = await getSession();
      return { data: { state: await s.storageState() } };
    },

    'page.info': async () => {
      const s = await getSession();
      const page: Page = await s.page();
      return {
        data: {
          url: page.url(),
          title: await page.title().catch(() => ''),
          userAgent: s.ua,
          runId: store.runId,
          runDir: store.dir,
        },
      };
    },

    'console.drain': async () => {
      const s = await getSession();
      return {
        data: { errors: s.drainConsoleErrors(), failedRequests: s.drainFailedRequests() },
      };
    },

    stop: async () => {
      const s = await getSession().catch(() => undefined);
      await s?.close();
      return { data: { ok: true } };
    },
  };

  return handlers;
}

/**
 * Run the daemon.
 *
 * This wires the handlers to an HTTP server and keeps the process alive
 * until the server closes.
 */
export async function runDaemonProcess(options: DaemonProcessOptions): Promise<void> {
  await ensureBvDir(options.cwd);

  const runId = options.runId ?? newRunId();
  const store = new RunStore(runId, options.cwd);
  await store.init();

  const userAgent = buildUserAgent(options.contactUrl);
  let session: BrowserSession | undefined;

  // The safety layer. The policy is loaded once at start-up; the plan-lock
  // and the approval store live for the life of the daemon, so an approval
  // issued in one CLI call is usable in the next.
  const policy: Policy = await loadPolicy(options.cwd);
  const planLock = new PlanLock();
  const approvals = new ApprovalStore();
  const scanner = new InjectionScanner();
  // The recorder writes the IR that `bv compile` reads.
  const recorder = new Recorder(runId);

  const getSession = async (): Promise<BrowserSession> => {
    if (session === undefined) {
      session = new BrowserSession({
        store,
        userAgent,
        headed: options.headed,
      });
      await session.launch();
    }
    return session;
  };

  const handlers = createHandlers({
    runId,
    store,
    cwd: options.cwd,
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
    policy,
    planLock,
    approvals,
    scanner,
    recorder,
    getSession,
  });
  const daemon = await startDaemon({
    handlers,
    session: options.session,
    headed: options.headed,
    browser: 'chromium',
  });

  const info: DaemonInfo = daemon.info;
  await writeDaemonInfo(info, daemon.token, options.cwd);

  await store.audit({
    type: 'session_start',
    session: options.session,
    pid: info.pid,
    port: info.port,
    headed: options.headed,
    userAgent,
    runId: store.runId,
  });

  const shutdown = async (): Promise<void> => {
    await daemon.close().catch(() => undefined);
    await session?.close().catch(() => undefined);
    await clearDaemonInfo(options.cwd).catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // Keep the process alive until the HTTP server closes.
  await new Promise<void>((resolve) => {
    daemon.server.once('close', () => resolve());
  });
}
