/**
 * In-process CLI tests.
 *
 * These call `run()` directly, so they cover the wiring and they are fast.
 * The subprocess tests in `test/integration/cli.test.ts` check the same
 * contract from the outside, including the real exit code.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../src/cli/main.js';
import { EXIT } from '../../src/core/exit.js';

/** Capture what a command writes to stdout and stderr. */
function capture(): {
  stdout: string[];
  stderr: string[];
  restore: () => void;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  return {
    stdout,
    stderr,
    restore: () => {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    },
  };
}

describe('the CLI, in process', () => {
  let dir: string;
  let previousCwd: string | undefined;
  let previousExitCode: string | number | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bv-cli-'));
    previousCwd = process.cwd();
    previousExitCode = process.exitCode ?? undefined;
    process.chdir(dir);
  });

  afterEach(async () => {
    process.chdir(previousCwd ?? process.cwd());
    process.exitCode = previousExitCode;
    await rm(dir, { recursive: true, force: true });
  });

  it('reports the version', async () => {
    const cap = capture();
    const code = await run(['--version']);
    cap.restore();
    expect(code).toBe(EXIT.OK);
  });

  it('returns a usage error when no subcommand is given', async () => {
    const cap = capture();
    const code = await run([]);
    cap.restore();
    expect(code).toBe(EXIT.USAGE);
  });

  it('returns a usage error for an unknown command', async () => {
    const cap = capture();
    const code = await run(['not-a-command']);
    cap.restore();
    expect(code).toBe(EXIT.USAGE);
  });

  it('creates the runtime directory and a policy', async () => {
    const cap = capture();
    const code = await run(['init']);
    cap.restore();
    expect(code).toBe(EXIT.OK);
    expect(cap.stdout.join('')).toContain('.bv');
  });

  it('reports that no session is running', async () => {
    const cap = capture();
    const code = await run(['session', 'status']);
    cap.restore();
    // "No session" is a state, not a failure: the command succeeded in
    // reporting it.
    expect(code).toBe(EXIT.OK);
    expect(cap.stdout.join('')).toContain('no session');
  });

  it('emits JSON on stdout with --json', async () => {
    const cap = capture();
    const code = await run(['--json', 'init']);
    cap.restore();
    expect(code).toBe(EXIT.OK);
    // stdout must be exactly one JSON document.
    const parsed = JSON.parse(cap.stdout.join('')) as unknown;
    expect(parsed).toBeDefined();
  });

  it('rejects an unknown action kind with a usage error', async () => {
    const cap = capture();
    const code = await run(['act', 'teleport', 'something']);
    cap.restore();
    expect(code).toBe(EXIT.USAGE);
    expect(cap.stdout.join('')).toContain('unknown action kind');
  });

  it('rejects a malformed plan file', async () => {
    const cap = capture();
    const code = await run(['plan', 'set', 'no-such-file.json']);
    cap.restore();
    expect(code).toBe(EXIT.FAILURE);
  });

  it('reports that no session is available for a plan command', async () => {
    const cap = capture();
    await run(['init']);
    cap.stdout.length = 0;
    const code = await run(['plan', 'show']);
    cap.restore();
    // The plan lives in the daemon, so without a session the command cannot
    // answer. That is a failure, not a usage error.
    expect(code).toBe(EXIT.FAILURE);
    expect(cap.stdout.join('')).toContain('no running session');
  });

  it('lists an empty vault', async () => {
    process.env['BV_VAULT_PASSPHRASE'] = 'test-passphrase';
    const cap = capture();
    await run(['init']);
    cap.stdout.length = 0;
    const code = await run(['vault', 'list']);
    cap.restore();
    delete process.env['BV_VAULT_PASSPHRASE'];
    expect(code).toBe(EXIT.OK);
    expect(cap.stdout.join('')).toContain('empty');
  });

  it('stores and lists a vault secret without echoing it', async () => {
    process.env['BV_VAULT_PASSPHRASE'] = 'test-passphrase';
    const cap = capture();
    await run(['init']);
    cap.stdout.length = 0;
    const setCode = await run(['vault', 'set', 'password', 'hunter2-secret']);
    cap.stdout.length = 0;
    await run(['vault', 'list']);
    cap.restore();
    delete process.env['BV_VAULT_PASSPHRASE'];

    expect(setCode).toBe(EXIT.OK);
    const output = cap.stdout.join('');
    expect(output).toContain('password');
    // The value must never appear in the output.
    expect(output).not.toContain('hunter2-secret');
  });

  it('removes a vault secret', async () => {
    process.env['BV_VAULT_PASSPHRASE'] = 'test-passphrase';
    const cap = capture();
    await run(['init']);
    await run(['vault', 'set', 'password', 'hunter2-secret']);
    cap.stdout.length = 0;
    const code = await run(['vault', 'rm', 'password']);
    cap.restore();
    delete process.env['BV_VAULT_PASSPHRASE'];
    expect(code).toBe(EXIT.OK);
  });

  it('reports removing a secret that is not there', async () => {
    process.env['BV_VAULT_PASSPHRASE'] = 'test-passphrase';
    const cap = capture();
    await run(['init']);
    cap.stdout.length = 0;
    const code = await run(['vault', 'rm', 'nope']);
    cap.restore();
    delete process.env['BV_VAULT_PASSPHRASE'];
    expect(code).toBe(EXIT.FAILURE);
  });

  it('requires a vault passphrase', async () => {
    delete process.env['BV_VAULT_PASSPHRASE'];
    const cap = capture();
    const code = await run(['vault', 'list']);
    cap.restore();
    expect(code).toBe(EXIT.USAGE);
    expect(cap.stdout.join('')).toContain('passphrase');
  });
});
