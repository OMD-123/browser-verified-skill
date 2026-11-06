/**
 * The browser session.
 *
 * This is the daemon's browser-facing core: it owns the Playwright browser,
 * captures snapshots, performs actions, and records everything in the run
 * store.
 *
 * It is deliberately separate from the HTTP layer so it can be driven
 * in-process by tests.
 */
import type { Browser, BrowserContextOptions, ConsoleMessage, Page } from 'playwright';
import { launchChromium } from './browser.js';
import { SessionState, type TabInfo } from './contexts.js';
import type { RunStore, StepRecord } from './runstore/store.js';
import { normalizeSnapshot, type AxNode, type Snapshot } from '../perception/snapshot.js';
import type { NetworkFact } from '../verify/verifier.js';
import { diffSnapshots, type SnapshotDiff } from '../perception/diff.js';
import { pruneSnapshot, estimateTreeTokens } from '../perception/prune.js';
import { renderDiff, renderTree } from '../perception/render.js';
import { performAction, type ActionOutcome } from '../actions/act.js';
import type { ActionRequest } from '../actions/locate.js';
import { VERSION } from '../version.js';

/** Options for creating a session. */
export interface SessionOptions {
  /** The run store that records the session's steps. */
  store: RunStore;
  /** The user agent to use. Must be honest. */
  userAgent: string;
  /** Whether the browser is headed. */
  headed: boolean;
  /** The browser to launch. */
  browserName?: string;
  /** The action timeout in milliseconds. */
  actionTimeoutMs?: number;
  /** Called when the session closes. */
  onClose?: () => void;
}

/** The result of capturing a snapshot. */
export interface CaptureResult {
  /** The full, unpruned tree. */
  tree: AxNode[];
  /** The pruned tree. */
  pruned: AxNode[];
  /** The snapshot metadata. */
  snapshot: Snapshot;
  /** Where the full snapshot was written. */
  path: string;
  /** The estimated token cost of the pruned tree. */
  estimatedTokens: number;
  /** The diff against the previous snapshot. */
  diff: SnapshotDiff;
  /** The URL of the previous snapshot, when there was one. */
  previousUrl?: string;
}

/** A console message captured during the session. */
interface CapturedConsole {
  type: string;
  text: string;
  timestamp: number;
}

/**
 * A live browser session.
 */
export class BrowserSession {
  readonly store: RunStore;
  readonly userAgent: string;
  readonly headed: boolean;
  private browser: Browser | undefined;
  private state: SessionState | undefined;
  private lastSnapshot: { roots: AxNode[]; documentToken: string; url: string } | undefined;
  private stepCounter = 0;
  private consoleMessages: CapturedConsole[] = [];
  private pageErrors: string[] = [];
  private failedRequests: string[] = [];
  private readonly actionTimeoutMs: number;
  private readonly onClose: (() => void) | undefined;

  constructor(options: SessionOptions) {
    this.store = options.store;
    this.userAgent = options.userAgent;
    this.headed = options.headed;
    this.actionTimeoutMs = options.actionTimeoutMs ?? 10_000;
    this.onClose = options.onClose;
    this.browser = undefined;
    this.state = undefined;
  }

  /**
   * The network responses seen in this session.
   *
   * The verifier uses these for the `network_response` condition.
   */
  networkFacts: NetworkFact[] = [];

  /** The current URL, when the browser is running. */
  get currentUrl(): string | undefined {
    return this.state?.currentUrl();
  }

  /**
   * Replace the browser context's storage state.
   *
   * Playwright applies a storage state when a context is created, so the
   * context is replaced. The active page is re-opened in the new context.
   */
  async replaceStorageState(storageState: unknown): Promise<void> {
    await this.sessionState.replaceContext({
      storageState: storageState as BrowserContextOptions['storageState'],
      userAgent: this.userAgent,
    });
  }

  /**
   * The storage state, as a flat map of key to value.
   *
   * Local storage and session storage are read; cookies are not included
   * because their values are secrets and are masked elsewhere.
   */
  async storageSnapshot(): Promise<Record<string, string>> {
    const page = await this.page();
    const storage = await page
      .evaluate(() => {
        const result: Record<string, string> = {};
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          if (key !== null) result[`local:${key}`] = window.localStorage.getItem(key) ?? '';
        }
        for (let i = 0; i < window.sessionStorage.length; i++) {
          const key = window.sessionStorage.key(i);
          if (key !== null) result[`session:${key}`] = window.sessionStorage.getItem(key) ?? '';
        }
        return result;
      })
      .catch(() => ({}));
    return storage;
  }

  /** Launch the browser. */
  async launch(): Promise<void> {
    if (this.browser !== undefined) return;
    this.browser = await launchChromium({ headed: this.headed });
    this.state = new SessionState(this.browser);
  }

  /** The Playwright browser. */
  get browserInstance(): Browser {
    if (this.browser === undefined) throw new Error('the session browser is not running');
    return this.browser;
  }

  /** The session's context and page state. */
  get sessionState(): SessionState {
    if (this.state === undefined) throw new Error('the session browser is not running');
    return this.state;
  }

  /** The active page. */
  async page(): Promise<Page> {
    if (this.state === undefined) await this.launch();
    // The context is created here so the honest user agent is applied.
    await this.sessionState.ensureContext({ userAgent: this.userAgent });
    const page = await this.sessionState.activePage();
    this.attachListeners(page);
    return page;
  }

  /** Attach console/error/request listeners to a page. */
  private attachListeners(page: Page): void {
    const marker = Symbol.for('bv.listeners');
    const marked = page as Page & { [marker]?: boolean };
    if (marked[marker] === true) return;
    marked[marker] = true;

    page.on('console', (message: ConsoleMessage) => {
      this.consoleMessages.push({
        type: message.type(),
        text: message.text(),
        timestamp: Date.now(),
      });
    });
    page.on('pageerror', (error) => {
      this.pageErrors.push(error.message);
    });
    page.on('requestfailed', (request) => {
      this.failedRequests.push(
        `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'failed'}`,
      );
    });
    page.on('popup', (popup) => {
      this.sessionState.registerPopup(popup);
      this.attachListeners(popup);
    });
  }

  /** The next step number. */
  private nextStep(): number {
    this.stepCounter += 1;
    return this.stepCounter;
  }

  /**
   * Capture a snapshot of the active page.
   *
   * The full tree is written to the run store; the returned object carries
   * both the full and pruned trees so the caller can render either.
   */
  async capture(options: { full?: boolean; maxTokens?: number } = {}): Promise<CaptureResult> {
    const page = await this.page();
    const raw: unknown = await page.ariaSnapshotJSON({ mode: 'ai' });
    const tree = normalizeSnapshot(raw);

    const url = page.url();
    const title = await page.title().catch(() => '');
    const documentToken = await this.documentToken(page);

    const snapshot: Snapshot = {
      roots: tree,
      url,
      title,
      nodeCount: countAll(tree),
      prunedCount: 0,
      capturedAt: new Date().toISOString(),
      documentToken,
    };

    const pruned = pruneSnapshot(tree, {
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    });
    snapshot.prunedCount = pruned.after;

    const diff = diffSnapshots(this.lastSnapshot, {
      roots: pruned.roots,
      url,
      title,
      documentToken,
    });

    const step = this.nextStep();
    const path = await this.store.writeSnapshot(step, renderTree(pruned.roots));

    const previousUrl = this.lastSnapshot?.url;
    this.lastSnapshot = { roots: pruned.roots, documentToken, url };

    return {
      tree,
      pruned: pruned.roots,
      snapshot,
      path,
      estimatedTokens: estimateTreeTokens(pruned.roots),
      diff,
      ...(previousUrl !== undefined ? { previousUrl } : {}),
    };
  }

  /**
   * A document token that changes whenever the document is replaced.
   *
   * Playwright's refs are invalidated by a navigation; this token lets the
   * perception layer detect that and report it instead of silently reusing
   * stale refs.
   */
  private async documentToken(page: Page): Promise<string> {
    try {
      const token = await page.evaluate(() => {
        const w = window as unknown as { __bvDocToken?: string };
        if (typeof w.__bvDocToken !== 'string') {
          w.__bvDocToken = Math.random().toString(36).slice(2);
        }
        return w.__bvDocToken;
      });
      return token;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Perform an action and record it.
   */
  async act(request: ActionRequest): Promise<ActionOutcome & { step: StepRecord; diff: string }> {
    const page = await this.page();
    const consoleBefore = this.consoleMessages.length;
    const errorsBefore = this.pageErrors.length;

    const outcome = await performAction(page, request, { timeoutMs: this.actionTimeoutMs });

    const step = this.nextStep();
    const record: StepRecord = {
      step,
      action: request.kind,
      durationMs: outcome.durationMs,
      urlBefore: outcome.urlBefore,
      urlAfter: outcome.urlAfter,
      ok: outcome.ok,
      timestamp: new Date().toISOString(),
      ...(request.target.name !== undefined
        ? { target: request.target.name }
        : request.target.text !== undefined
          ? { target: request.target.text }
          : request.target.ref !== undefined
            ? { target: request.target.ref }
            : request.target.testId !== undefined
              ? { target: request.target.testId }
              : request.target.label !== undefined
                ? { target: request.target.label }
                : request.target.css !== undefined
                  ? { target: request.target.css }
                  : {}),
      ...(outcome.strategy !== undefined ? { strategy: outcome.strategy } : {}),
      ...(outcome.message !== '' ? { message: outcome.message } : {}),
    };

    // Capture the diff after the action.
    const capture = await this.capture();
    record.snapshotPath = capture.path;

    const newConsoleErrors = this.consoleMessages
      .slice(consoleBefore)
      .filter((m) => m.type === 'error')
      .map((m) => m.text);
    const newPageErrors = this.pageErrors.slice(errorsBefore);
    record.consoleErrors = [...newConsoleErrors, ...newPageErrors];

    await this.store.recordStep(record);

    return {
      ...outcome,
      step: record,
      diff: renderDiff(capture.diff, {
        ...(capture.previousUrl !== undefined ? { previousUrl: capture.previousUrl } : {}),
      }),
    };
  }

  /** Navigate the active page. */
  async goto(url: string): Promise<{ ok: boolean; url: string; message: string }> {
    const page = await this.page();
    try {
      await page.goto(url, { timeout: 30_000, waitUntil: 'domcontentloaded' });
      const step = this.nextStep();
      await this.store.recordStep({
        step,
        action: 'goto',
        target: url,
        durationMs: 0,
        urlBefore: page.url(),
        urlAfter: page.url(),
        ok: true,
        timestamp: new Date().toISOString(),
        message: `navigated to ${url}`,
      });
      return { ok: true, url: page.url(), message: `navigated to ${url}` };
    } catch (err) {
      const message =
        err instanceof Error ? (err.message.split('\n')[0] ?? 'navigation failed') : String(err);
      return { ok: false, url: page.url(), message: `navigation failed: ${message}` };
    }
  }

  /** The console errors seen since the last call. */
  drainConsoleErrors(): string[] {
    const errors = this.consoleMessages.filter((m) => m.type === 'error').map((m) => m.text);
    this.consoleMessages = [];
    this.pageErrors = [];
    this.failedRequests = [];
    return errors;
  }

  /** The failed requests seen since the last call. */
  drainFailedRequests(): string[] {
    const failed = [...this.failedRequests];
    this.failedRequests = [];
    return failed;
  }

  /** The list of tabs. */
  async tabs(): Promise<TabInfo[]> {
    return this.sessionState.tabs();
  }

  /** The current storage state. */
  async storageState(): Promise<unknown> {
    return this.sessionState.storageState();
  }

  /** Close the session. */
  async close(): Promise<void> {
    if (this.state !== undefined) {
      await this.state.close().catch(() => undefined);
    }
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
    this.state = undefined;
    this.onClose?.();
  }

  /** The user agent the session applies. */
  get ua(): string {
    return this.userAgent;
  }

  /** The browser name. */
  get browserName(): string {
    return 'chromium';
  }
}

/** Count the nodes in a tree. */
function countAll(nodes: readonly AxNode[]): number {
  let total = 0;
  for (const node of nodes) {
    total += 1;
    if (node.children) total += countAll(node.children);
  }
  return total;
}

/**
 * Build the honest default user agent.
 *
 * The contact URL comes from the policy; it is included so that a site owner
 * can identify and contact whoever is running the automation.
 */
export function buildUserAgent(contact: string | undefined): string {
  const suffix = contact !== undefined && contact.length > 0 ? ` (+${contact})` : '';
  return `BrowserVerified/${VERSION}${suffix}`;
}

/** The context options a session uses. */
export function contextOptions(userAgent: string): { userAgent: string } {
  return { userAgent };
}

/** The browser type used by sessions. */
export type SessionBrowser = Browser;
