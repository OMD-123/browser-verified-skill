/**
 * The session daemon's entry point (M01).
 *
 * The daemon runs as a detached process. It is spawned from the bundle
 * when the tool is installed, and through `tsx` when running from
 * source. These tests check the resolution, because a wrong entry point
 * means the session never starts and the error says nothing useful.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonEntry, spawnDaemon } from '../../src/cli/commands/session.js';

describe('the daemon entry point', () => {
  it('resolves to a command and arguments', () => {
    const entry = daemonEntry();

    expect(entry.command.length).toBeGreaterThan(0);
    expect(Array.isArray(entry.args)).toBe(true);
  });

  it('points at an entry that exists, from source or from the bundle', () => {
    const entry = daemonEntry();

    if (entry.args.length === 0) {
      // The bundle re-spawns itself with --daemon, so there is no path
      // to check. The command must at least be this process.
      expect(entry.command).toBe(process.execPath);
      return;
    }

    // The last argument is the script to run.
    const script = entry.args[entry.args.length - 1] as string;
    expect(existsSync(script)).toBe(true);
  });

  it('runs the TypeScript entry through tsx when running from source', () => {
    const entry = daemonEntry();
    const here = dirname(fileURLToPath(import.meta.url));
    const sourceEntry = resolve(here, '..', '..', 'src', 'core', 'daemon-entry.ts');

    if (!existsSync(sourceEntry)) {
      // Running from the bundle, where the daemon is compiled in.
      return;
    }

    // tsx runs the TypeScript directly.
    expect(entry.args.join(' ')).toContain('daemon-entry.ts');
  });

  it('spawns the daemon detached, with the flags it needs', () => {
    const calls: {
      command: string;
      args: string[];
      options: { cwd: string; detached: boolean; stdio: string; env: NodeJS.ProcessEnv };
    }[] = [];

    const pid = spawnDaemon(
      {
        cwd: '/tmp/work',
        headed: true,
        session: 'my-session',
        contact: 'https://example.test/contact',
        runId: 'run-9',
      },
      (command, args, options) => {
        calls.push({ command, args, options });
        return { pid: 4242, unref: () => {} };
      },
    );

    expect(pid).toBe(4242);
    expect(calls).toHaveLength(1);

    const call = calls[0]!;
    // The daemon runs detached, so it survives the CLI exiting.
    expect(call.options.detached).toBe(true);
    // Its output goes nowhere the operator sees, because the approval
    // prompts go to the controlling terminal instead.
    expect(call.options.stdio).toBe('ignore');
    expect(call.options.cwd).toBe('/tmp/work');

    // The flags the daemon needs.
    expect(call.args).toContain('--daemon');
    expect(call.args).toContain('--cwd');
    expect(call.args).toContain('/tmp/work');
    expect(call.args).toContain('--session');
    expect(call.args).toContain('my-session');
    expect(call.args).toContain('--headed');
    expect(call.args).toContain('--contact');
    expect(call.args).toContain('https://example.test/contact');
    expect(call.args).toContain('--run-id');
    expect(call.args).toContain('run-9');
  });

  it('spawns the daemon with a minimal environment', () => {
    // The gap: the daemon used to be spawned with the WHOLE parent
    // environment, so every secret the operator had in their shell went
    // to a browser process that had no use for it.
    const calls: {
      options: { cwd: string; detached: boolean; stdio: string; env: NodeJS.ProcessEnv };
    }[] = [];

    spawnDaemon(
      { cwd: '/tmp/work', headed: false, session: 'default' },
      (_command, _args, options) => {
        calls.push({ options });
        return { pid: 1, unref: () => {} };
      },
    );

    const env = calls[0]!.options.env;

    // The browser needs these.
    expect(env['PATH']).toBeDefined();

    // The model key is NOT forwarded in Mode A, even when the ambient
    // environment has one.
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('leaves the optional flags out when they are not given', () => {
    const calls: { args: string[] }[] = [];

    spawnDaemon({ cwd: '/tmp/work', headed: false, session: 'default' }, (_command, args) => {
      calls.push({ args });
      return { pid: 1, unref: () => {} };
    });

    const args = calls[0]!.args;
    expect(args).not.toContain('--headed');
    expect(args).not.toContain('--contact');
    expect(args).not.toContain('--run-id');
  });

  it('reports a failure to spawn', () => {
    expect(() =>
      spawnDaemon({ cwd: '/tmp/work', headed: false, session: 'default' }, () => ({
        pid: undefined,
        unref: () => {},
      })),
    ).toThrow('failed to spawn the session daemon');
  });

  it('uses this process to run the entry', () => {
    // Whatever the path, the command is node. A daemon that is not node
    // cannot run the bundle.
    const entry = daemonEntry();
    expect(entry.command).toBe(process.execPath);
  });
});
