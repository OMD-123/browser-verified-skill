import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));

/** Run the CLI via tsx and capture stdout, stderr and the exit code. */
async function runCli(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [TSX, CLI, ...args], {
      cwd: cwd ?? process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

describe('bv CLI', () => {
  it('prints the version', async () => {
    const { stdout, code } = await runCli(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('prints help listing the commands', async () => {
    const { stdout, code } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('doctor');
    expect(stdout).toContain('init');
  });

  it('exits 2 (usage) when no subcommand is given', async () => {
    const { code } = await runCli([]);
    expect(code).toBe(2);
  });

  it('exits 2 (usage) for an unknown command', async () => {
    const { code } = await runCli(['not-a-command']);
    expect(code).toBe(2);
  });

  it('init creates .bv/ and writes a policy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bv-init-'));
    try {
      const { code, stdout } = await runCli(['init'], dir);
      expect(code).toBe(0);
      expect(stdout).toContain('policy written');

      const policy = join(dir, '.bv', 'policy.yaml');
      const info = await stat(policy);
      expect(info.isFile()).toBe(true);
      const content = await readFile(policy, 'utf8');
      expect(content).toContain('version: 1');
      expect(content).toContain('actionClasses:');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('init does not overwrite an existing policy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bv-init2-'));
    try {
      await runCli(['init'], dir);
      const policy = join(dir, '.bv', 'policy.yaml');
      await writeFile(policy, 'version: 1\n# edited\n');

      const { stdout } = await runCli(['init'], dir);
      expect(stdout).toContain('policy kept');
      const content = await readFile(policy, 'utf8');
      expect(content).toContain('# edited');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--json puts machine-readable output on stdout and nothing else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bv-json-'));
    try {
      const { stdout, code } = await runCli(['--json', 'init'], dir);
      expect(code).toBe(0);
      // stdout must be exactly one JSON document.
      const parsed = JSON.parse(stdout) as { policyCreated: boolean };
      expect(parsed.policyCreated).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('doctor reports the environment', async () => {
    const { stdout, code } = await runCli(['--json', 'doctor']);
    const parsed = JSON.parse(stdout) as { checks: { name: string; status: string }[] };
    expect(parsed.checks.length).toBeGreaterThan(0);
    expect(parsed.checks.map((c) => c.name)).toContain('node');
    // The check for Chromium may fail on a machine without browsers installed,
    // but the command itself must not crash.
    expect([0, 1]).toContain(code);
  });
});
