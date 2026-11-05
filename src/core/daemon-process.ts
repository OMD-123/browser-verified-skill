/**
 * The daemon's browser-facing entry point.
 *
 * This module is what actually runs as the detached process. It starts the
 * HTTP daemon, wires the handlers to a `BrowserSession`, and writes the
 * descriptor to disk.
 */
import { startDaemon, type DaemonHandler, type DaemonRequest } from './daemon.js';
import { writeDaemonInfo, clearDaemonInfo, type DaemonInfo } from './daemon-info.js';
import { BrowserSession, buildUserAgent } from './session.js';
import { RunStore, newRunId } from './runstore/store.js';
import { ensureBvDir } from './paths.js';
import { renderDiff, renderTree } from '../perception/render.js';
import { parseTarget, type ActionKind, type TargetDescriptor } from '../actions/locate.js';
import { EXIT } from './exit.js';
import type { Page } from 'playwright';

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
export async function runDaemonProcess(options: DaemonProcessOptions): Promise<void> {
  await ensureBvDir(options.cwd);

  const runId = options.runId ?? newRunId();
  const store = new RunStore(runId, options.cwd);
  await store.init();

  const userAgent = buildUserAgent(options.contactUrl);
  let session: BrowserSession | undefined;

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
      const outcome = await s.act({
        kind: kind as ActionKind,
        target,
        ...(value !== undefined ? { value } : {}),
        ...(params['force'] === true ? { force: true } : {}),
      });
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
      const result = await s.goto(url);
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
