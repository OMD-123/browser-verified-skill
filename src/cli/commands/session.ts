/**
 * `bv session` — start, stop and inspect browser sessions.
 */
import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ok, fail } from '../../core/output.js';
import { EXIT } from '../../core/exit.js';
import { connectDaemon } from '../../core/client.js';
import { readDaemonInfo, isProcessAlive, clearDaemonInfo } from '../../core/daemon-info.js';
import { ensureBvDir } from '../../core/paths.js';
import { emit, globalOptions } from '../helpers.js';
import { UsageError } from '../../core/errors.js';

/** Options for `bv session start`. */
export interface StartOptions {
  headed?: boolean;
  session?: string;
  contact?: string;
  runId?: string;
}

/**
 * Locate the module that runs the daemon, and the runtime needed to run it.
 *
 * In the source tree the daemon is TypeScript (`src/core/daemon-entry.ts`),
 * so it must be run through `tsx`. In the bundled CLI the daemon is compiled
 * into the bundle, and the bundle is re-spawned with a `--daemon` flag.
 */
function daemonEntry(): { command: string; args: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  const sourceEntry = resolve(here, '..', '..', 'core', 'daemon-entry.ts');
  const tsxCli = resolve(here, '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

  // When running from source, use tsx to execute the TypeScript entry point.
  if (existsSync(sourceEntry)) {
    if (existsSync(tsxCli)) {
      return { command: process.execPath, args: [tsxCli, sourceEntry] };
    }
    // Fall back to a tsx binary on PATH.
    return { command: 'tsx', args: [sourceEntry] };
  }

  // When running from the bundle, re-spawn this bundle with --daemon.
  //
  // The bundle's own location is the reliable answer: `import.meta.url`
  // points at the running file, whatever directory it was installed into.
  // The package root is one level up from `scripts/`, and the file that is
  // running is the bundle itself.
  const self = fileURLToPath(import.meta.url);
  if (existsSync(self) && self.endsWith('.mjs')) {
    return { command: process.execPath, args: [self] };
  }

  // A bundle that was loaded from somewhere else: look for it next to the
  // package root.
  for (const candidate of [
    resolve(here, '..', '..', '..', 'scripts', 'bv.mjs'),
    resolve(here, '..', '..', 'scripts', 'bv.mjs'),
    resolve(here, '..', 'scripts', 'bv.mjs'),
  ]) {
    if (existsSync(candidate)) {
      return { command: process.execPath, args: [candidate] };
    }
  }

  throw new UsageError(
    'could not locate the session daemon entry point. Reinstall browser-verified-skill or run from the repository.',
  );
}

/** Spawn the detached daemon process. */
export function spawnDaemon(options: {
  cwd: string;
  headed: boolean;
  session: string;
  contact?: string;
  runId?: string;
}): number {
  const entry = daemonEntry();
  const args = [
    ...entry.args,
    '--daemon',
    '--cwd',
    options.cwd,
    '--session',
    options.session,
    ...(options.headed ? ['--headed'] : []),
    ...(options.contact !== undefined ? ['--contact', options.contact] : []),
    ...(options.runId !== undefined ? ['--run-id', options.runId] : []),
  ];

  const child = spawn(entry.command, args, {
    cwd: options.cwd,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });

  child.unref();
  if (child.pid === undefined) {
    throw new Error('failed to spawn the session daemon');
  }
  return child.pid;
}

/** Wait until the daemon descriptor appears, or time out. */
async function waitForDaemon(cwd: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await readDaemonInfo(cwd);
    if (info !== undefined && isProcessAlive(info.pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new UsageError('the session daemon did not start within 30s');
}

/** Register the `session` command group. */
export function registerSession(program: Command): void {
  const session = program
    .command('session')
    .description('start, stop and inspect browser sessions');

  session
    .command('start')
    .description('start a browser session (a detached daemon)')
    .option('--headed', 'run the browser headed (required for human handoff)', false)
    .option('--session <name>', 'the session name', 'default')
    .option('--contact <url>', 'the contact URL included in the honest user agent')
    .option('--run-id <id>', 'use a specific run id')
    .action(async (options: StartOptions, cmd: Command) => {
      const global = globalOptions(cmd);
      try {
        await ensureBvDir(global.cwd);

        const existing = await readDaemonInfo(global.cwd);
        if (existing !== undefined && isProcessAlive(existing.pid)) {
          emit(
            cmd,
            fail(
              { error: 'session_exists', pid: existing.pid, port: existing.port },
              [
                `a session is already running (pid ${existing.pid}). Stop it first with \`bv session stop\`.`,
              ],
              EXIT.FAILURE,
            ),
          );
          return;
        }
        // A stale descriptor from a crashed daemon is cleared.
        if (existing !== undefined) {
          await clearDaemonInfo(global.cwd);
        }

        const pid = spawnDaemon({
          cwd: global.cwd,
          headed: options.headed === true,
          session: options.session ?? 'default',
          ...(options.contact !== undefined ? { contact: options.contact } : {}),
          ...(options.runId !== undefined ? { runId: options.runId } : {}),
        });

        await waitForDaemon(global.cwd);
        const info = await readDaemonInfo(global.cwd);

        const lines = [
          `session "${info?.session ?? 'default'}" started (pid ${pid})`,
          `port: ${info?.port ?? '?'}`,
          `headed: ${(options.headed ?? false) ? 'yes' : 'no'}`,
          info?.headed === false && (options.headed ?? false) ? '' : '',
          `run dir: ${info === undefined ? '?' : '.bv/runs'}`,
        ].filter((line) => line !== '');

        emit(
          cmd,
          ok(
            {
              pid,
              port: info?.port,
              session: info?.session,
              headed: info?.headed,
              startedAt: info?.startedAt,
            },
            lines,
          ),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit(
          cmd,
          fail(
            { error: 'session_start_failed', message },
            [`Could not start the session: ${message}`],
            EXIT.FAILURE,
          ),
        );
      }
    });

  session
    .command('stop')
    .description('stop the running session')
    .action(async (_options: unknown, cmd: Command) => {
      const global = globalOptions(cmd);
      const info = await readDaemonInfo(global.cwd);
      if (info === undefined) {
        emit(cmd, ok({ stopped: false }, ['no session is running']));
        return;
      }
      if (!isProcessAlive(info.pid)) {
        await clearDaemonInfo(global.cwd);
        emit(
          cmd,
          ok({ stopped: false }, ['the session was no longer running (stale state cleared)']),
        );
        return;
      }

      // Ask the daemon to shut down cleanly so it can close the browser.
      try {
        const client = await connectDaemon(global.cwd);
        await client.call('stop');
      } catch {
        // The daemon may be unresponsive; fall back to a signal.
      }

      await new Promise((r) => setTimeout(r, 300));
      if (isProcessAlive(info.pid)) {
        try {
          process.kill(info.pid, 'SIGTERM');
        } catch {
          // Already gone.
        }
      }
      await clearDaemonInfo(global.cwd);
      emit(cmd, ok({ stopped: true, pid: info.pid }, [`session stopped (pid ${info.pid})`]));
    });

  session
    .command('status')
    .description('show the status of the running session')
    .action(async (_options: unknown, cmd: Command) => {
      const global = globalOptions(cmd);
      const info = await readDaemonInfo(global.cwd);
      if (info === undefined) {
        emit(cmd, ok({ running: false }, ['no session is running']));
        return;
      }
      const alive = isProcessAlive(info.pid);
      let page: unknown;
      if (alive) {
        try {
          const client = await connectDaemon(global.cwd);
          page = await client.call('page.info');
        } catch {
          page = undefined;
        }
      }
      const lines = [
        `running: ${alive ? 'yes' : 'no (stale)'}`,
        `pid: ${info.pid}`,
        `port: ${info.port}`,
        `session: ${info.session}`,
        `headed: ${info.headed ? 'yes' : 'no'}`,
        `started: ${info.startedAt}`,
      ];
      if (page !== undefined) {
        const p = page as { url?: string; title?: string; userAgent?: string };
        lines.push(`url: ${p.url ?? ''}`);
        lines.push(`title: ${p.title ?? ''}`);
        lines.push(`user agent: ${p.userAgent ?? ''}`);
      }
      emit(cmd, ok({ running: alive, ...info, page }, lines));
    });
}
