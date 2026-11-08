/**
 * `bv doctor` — check that the environment can run the toolkit.
 *
 * Checks: Node version, Playwright browser availability, write permissions for
 * `.bv/`, and whether a policy file exists and parses.
 */
import type { Command } from 'commander';
import { access, constants, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ok, fail, type CommandResult } from '../../core/output.js';
import { EXIT } from '../../core/exit.js';
import { bvRoot, policyPath } from '../../core/paths.js';
import { loadPolicy } from '../../safety/policy.js';
import { emit } from '../helpers.js';

/** The outcome of a single doctor check. */
export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  /** An optional command the user can run to fix the problem. */
  fix?: string;
}

/** Minimum supported Node major version. */
const MIN_NODE_MAJOR = 20;

/** Where Playwright keeps its browsers. */
function playwrightBrowserDirs(): string[] {
  const home = homedir();
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA'];
    return local ? [join(local, 'ms-playwright')] : [];
  }
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Caches', 'ms-playwright')];
  }
  return [join(home, '.cache', 'ms-playwright')];
}

/** Locate an installed Chromium build directory. */
async function findChromium(): Promise<string | undefined> {
  for (const dir of playwrightBrowserDirs()) {
    try {
      const entries = await readdir(dir);
      const chromium = entries.filter((e) => e.startsWith('chromium-'));
      if (chromium.length > 0) {
        const full = join(dir, chromium.sort().at(-1) ?? chromium[0] ?? '');
        const info = await stat(full).catch(() => undefined);
        if (info?.isDirectory()) return full;
      }
    } catch {
      // The cache directory does not exist: not installed.
    }
  }
  return undefined;
}

/** Run every doctor check. */
export async function runDoctor(cwd: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // --- Node version --------------------------------------------------------
  const major = Number(process.versions.node.split('.')[0] ?? '0');
  checks.push(
    major >= MIN_NODE_MAJOR
      ? { name: 'node', status: 'ok', detail: `v${process.versions.node}` }
      : {
          name: 'node',
          status: 'fail',
          detail: `v${process.versions.node} is older than the required v${MIN_NODE_MAJOR}`,
          fix: 'install Node 20 or newer',
        },
  );

  // --- Playwright browsers -------------------------------------------------
  const chromium = await findChromium();
  checks.push(
    chromium
      ? { name: 'playwright-chromium', status: 'ok', detail: chromium }
      : {
          name: 'playwright-chromium',
          status: 'fail',
          detail: 'no Chromium build found in the Playwright browser cache',
          fix: 'bv doctor --install',
        },
  );

  // --- Writable runtime directory ------------------------------------------
  const root = bvRoot(cwd);
  try {
    await access(root, constants.W_OK);
    checks.push({ name: 'runtime-dir', status: 'ok', detail: root });
  } catch {
    const exists = await stat(root).then(
      () => true,
      () => false,
    );
    if (exists) {
      checks.push({
        name: 'runtime-dir',
        status: 'fail',
        detail: `${root} exists but is not writable`,
        fix: 'fix the directory permissions, or remove it and run `bv init`',
      });
    } else {
      checks.push({
        name: 'runtime-dir',
        status: 'warn',
        detail: `${root} does not exist yet`,
        fix: 'bv init',
      });
    }
  }

  // --- Policy --------------------------------------------------------------
  const policy = policyPath(cwd);
  const policyExists = await stat(policy).then(
    () => true,
    () => false,
  );

  if (!policyExists) {
    checks.push({
      name: 'policy',
      status: 'warn',
      detail: 'no policy file: the default policy will be used',
      fix: 'bv init',
    });
  } else {
    // The policy is VALIDATED, not just found. A policy with a typo or a
    // forbidden key used to be reported as "ok" here and then fail at
    // runtime with a confusing error, when the doctor is exactly where the
    // user would have been told about it.
    try {
      await loadPolicy(cwd);
      checks.push({ name: 'policy', status: 'ok', detail: policy });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      checks.push({
        name: 'policy',
        status: 'fail',
        detail: `the policy is not valid: ${message}`,
        fix: 'fix the policy, or delete it and run `bv init` to write the default',
      });
    }
  }

  // --- Anthropic key (Mode B only) -----------------------------------------
  const hasKey = Boolean(process.env['ANTHROPIC_API_KEY']);
  checks.push({
    name: 'anthropic-key',
    status: hasKey ? 'ok' : 'warn',
    detail: hasKey
      ? 'ANTHROPIC_API_KEY is set (Mode B available)'
      : 'ANTHROPIC_API_KEY is not set: Mode B is unavailable, Mode A is unaffected',
  });

  return checks;
}

/** Install the Playwright browsers. */
async function installBrowsers(): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const cli = join(process.cwd(), 'node_modules', 'playwright', 'cli.js');
  await execFileAsync(process.execPath, [cli, 'install', 'chromium'], { cwd: process.cwd() });
}

/** Register the `doctor` command. */
export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('check the environment: node, playwright browsers, permissions, policy')
    .option('--install', 'install the Playwright browsers if they are missing', false)
    .action(async (options: { install?: boolean }, cmd: Command) => {
      const global = cmd.parent?.opts<{ cwd?: string }>() ?? {};
      const cwd = global.cwd ?? process.cwd();

      if (options.install === true) {
        try {
          await installBrowsers();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const result = fail(
            { checks: [], error: 'install_failed', message },
            [`Browser installation failed: ${message}`],
            EXIT.FAILURE,
          );
          emit(cmd, result);
          return;
        }
      }

      const checks = await runDoctor(cwd);
      const failed = checks.filter((c) => c.status === 'fail');
      const lines: string[] = [];
      for (const check of checks) {
        const mark = check.status === 'ok' ? '✓' : check.status === 'warn' ? '!' : '✗';
        lines.push(`${mark} ${check.name}: ${check.detail}`);
        if (check.fix !== undefined && check.status !== 'ok') {
          lines.push(`    fix: ${check.fix}`);
        }
      }
      lines.push(
        failed.length === 0
          ? 'All checks passed.'
          : `${failed.length} check(s) failed. Fix the items above before running a session.`,
      );

      const result: CommandResult =
        failed.length === 0
          ? ok({ checks }, lines)
          : fail({ checks, failed: failed.map((c) => c.name) }, lines, EXIT.FAILURE);
      emit(cmd, result);
    });
}

/** Print a result using the global `--json` flag. */
