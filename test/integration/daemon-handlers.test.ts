/**
 * In-process tests for the daemon's handlers.
 *
 * These call `createHandlers` directly, so they exercise the real daemon
 * logic without a listening socket. That is also why they count towards
 * coverage: the subprocess-based tests never did.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { createHandlers, type DaemonContext } from '../../src/core/daemon-process.js';
import { RunStore } from '../../src/core/runstore/store.js';
import { BrowserSession } from '../../src/core/session.js';
import { validatePolicy, type Policy } from '../../src/safety/policy.js';
import { PlanLock } from '../../src/safety/planlock.js';
import { ApprovalStore } from '../../src/safety/approvals.js';
import { InjectionScanner } from '../../src/safety/injection/detectors.js';
import { Recorder } from '../../src/compile/recorder.js';
import { launchChromium } from '../../src/core/browser.js';

/** The fixture server's base URL. */
const FIXTURE = process.env['BV_FIXTURE_ORIGIN'] ?? 'http://127.0.0.1:3000';

/** A permissive policy. */
function policy(): Policy {
  return validatePolicy({
    version: 1,
    domains: { allow: [], deny: [] },
    ownedOrigins: [],
    actionClasses: { approvalRequired: ['submit', 'destructive'], deny: [] },
  });
}

/** The handlers, and everything they need. */
interface Harness {
  handlers: Record<
    string,
    (request: { params?: Record<string, unknown> }) => Promise<{
      data?: unknown;
      exitCode?: number;
    }>
  >;
  store: RunStore;
  planLock: PlanLock;
  approvals: ApprovalStore;
  recorder: Recorder;
  session: BrowserSession;
  close: () => Promise<void>;
}

describe('the daemon handlers', () => {
  let dir: string;
  let browser: Browser;
  let harness: Harness;

  beforeAll(async () => {
    browser = await launchChromium();
  });

  afterAll(async () => {
    await browser.close();
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bv-daemon-'));
    const store = new RunStore('test-run', dir);
    await store.init();

    const session = new BrowserSession({
      store,
      userAgent: 'BrowserVerified/1.0 (+@url:`https://example.test/contact`)',
      headed: false,
    });
    await session.launch();

    const planLock = new PlanLock();
    const approvals = new ApprovalStore();
    const recorder = new Recorder('test-run');

    const context: DaemonContext = {
      runId: 'test-run',
      store,
      cwd: dir,
      headed: false,
      policy: policy(),
      planLock,
      approvals,
      scanner: new InjectionScanner(),
      recorder,
      getSession: async () => session,
    };

    harness = {
      handlers: createHandlers(context) as Harness['handlers'],
      store,
      planLock,
      approvals,
      recorder,
      session,
      close: async () => {
        await session.close();
      },
    };
  });

  afterEach(async () => {
    await harness.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('answers a snapshot', async () => {
    await harness.session.page().then((p) => p.goto(`${FIXTURE}/pages/index.html`));
    const result = await harness.handlers['snapshot']?.({});
    expect(result?.data).toBeDefined();
  });

  it('answers tabs', async () => {
    const result = await harness.handlers['tabs']?.({});
    expect(Array.isArray((result?.data as { tabs: unknown[] })?.tabs)).toBe(true);
  });

  it('answers a goto', async () => {
    const result = await harness.handlers['goto']?.({
      params: { url: `${FIXTURE}/pages/login.html` },
    });
    expect((result?.data as { ok: boolean })?.ok).toBe(true);
  });

  it('rejects a goto with no url', async () => {
    const result = await harness.handlers['goto']?.({});
    expect(result?.exitCode).toBe(2);
  });

  it('sets and reads a plan', async () => {
    const plan = {
      goal: 'test',
      successCondition: { type: 'url_matches', pattern: '/x' },
      allowedOrigins: [FIXTURE],
      allowedActionClasses: ['read', 'navigate'],
      maxSteps: 5,
      createdAt: new Date().toISOString(),
    };
    const set = await harness.handlers['plan.set']?.({ params: { plan } });
    expect(set?.exitCode).toBeUndefined();

    const show = await harness.handlers['plan.show']?.({});
    expect((show?.data as { plan: { goal: string } })?.plan.goal).toBe('test');
  });

  it('rejects an invalid plan', async () => {
    const result = await harness.handlers['plan.set']?.({
      params: { plan: { goal: 'x' } },
    });
    expect(result?.exitCode).toBe(2);
  });

  it('reports that no plan is set', async () => {
    const result = await harness.handlers['plan.show']?.({});
    // No plan is a state, not a failure: the plan-lock simply has nothing
    // to check against yet.
    expect((result?.data as { plan: unknown })?.plan).toBeUndefined();
    expect(result?.exitCode).toBeUndefined();
  });

  it('issues an approval for a pending action', async () => {
    // An action has to be pending before a token can be issued for it.
    const pendingId = 'action-under-test';
    harness.approvals.request({
      actionId: pendingId,
      actionHash: 'hash-under-test',
      description: 'a test action',
    });

    const issued = await harness.handlers['approve.issue']?.({
      params: { actionId: pendingId },
    });
    const data = issued?.data as { ok: boolean; token: string };
    expect(data.ok).toBe(true);
    expect(typeof data.token).toBe('string');
  });

  it('rejects an approval with no action id', async () => {
    const result = await harness.handlers['approve.issue']?.({});
    expect(result?.exitCode).toBe(2);
  });

  it('reports an approval for an unknown action', async () => {
    const result = await harness.handlers['approve.issue']?.({
      params: { actionId: 'no-such-action' },
    });
    expect((result?.data as { ok: boolean })?.ok).toBe(false);
  });

  it('lists the pending approvals', async () => {
    harness.approvals.request({
      actionId: 'pending-one',
      actionHash: 'hash-one',
      description: 'a test action',
    });
    const listed = await harness.handlers['approve.list']?.({});
    expect((listed?.data as { pending: unknown[] })?.pending.length).toBeGreaterThan(0);
  });

  it('answers a verify', async () => {
    await harness.session.page().then((p) => p.goto(`${FIXTURE}/pages/index.html`));
    const result = await harness.handlers['verify']?.({
      params: { condition: { type: 'url_matches', pattern: '/pages/index' } },
    });
    expect((result?.data as { passed: boolean })?.passed).toBe(true);
  });

  it('fails a verify whose condition does not hold', async () => {
    await harness.session.page().then((p) => p.goto(`${FIXTURE}/pages/index.html`));
    const result = await harness.handlers['verify']?.({
      params: { condition: { type: 'text_visible', text: 'This text is not on the page' } },
    });
    expect((result?.data as { passed: boolean })?.passed).toBe(false);
    expect(result?.exitCode).toBe(6);
  });

  it('answers an extract', async () => {
    await harness.session.page().then((p) => p.goto(`${FIXTURE}/pages/index.html`));
    const result = await harness.handlers['extract']?.({
      params: {
        schema: { type: 'object', properties: { Title: { type: 'string' } } },
      },
    });
    expect((result?.data as { order: string[] })?.order).toEqual(['Title']);
  });

  it('records a navigation into the recorder', async () => {
    await harness.handlers['goto']?.({ params: { url: `${FIXTURE}/pages/index.html` } });
    expect(harness.recorder.count).toBeGreaterThan(0);
    expect(harness.recorder.recorded[0]?.kind).toBe('goto');
  });

  it('answers a rewind with a usage error for a bad step', async () => {
    const result = await harness.handlers['rewind']?.({ params: { to: 'x' } });
    expect(result?.exitCode).toBe(2);
  });

  it('answers a rewind', async () => {
    const result = await harness.handlers['rewind']?.({ params: { to: 1 } });
    const data = result?.data as { branchRunId: string; notRestored: string[] };
    expect(typeof data.branchRunId).toBe('string');
    // The rewind says what it could not restore.
    expect(data.notRestored.length).toBeGreaterThan(0);
  });
});
