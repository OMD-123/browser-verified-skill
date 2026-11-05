/**
 * `bv init` — create the `.bv/` runtime directory and a default policy.
 *
 * The default policy is copied from the packaged `policies/default.yaml` so
 * the user's copy is editable and the packaged one stays pristine.
 */
import type { Command } from 'commander';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, fail } from '../../core/output.js';
import { EXIT } from '../../core/exit.js';
import { bvRoot, policyPath, runsRoot } from '../../core/paths.js';
import { emit, globalOptions } from '../helpers.js';

/**
 * Locate the packaged default policy, whether running from `src/` or the bundle.
 *
 * The bundled CLI lives in `scripts/bv.mjs`, so the relative depth differs
 * between the source tree and the bundle; both are tried.
 */
export function packagedPolicyPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', '..', 'policies', 'default.yaml'),
    resolve(here, '..', '..', '..', '..', 'policies', 'default.yaml'),
    resolve(here, '..', 'policies', 'default.yaml'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0] ?? '';
}

/** The result of `bv init`. */
export interface InitResult {
  root: string;
  policyCreated: boolean;
  policyPath: string;
}

/**
 * Create the runtime directory and a default policy.
 *
 * Never overwrites an existing policy: the operator's edits are precious.
 */
export async function runInit(cwd: string): Promise<InitResult> {
  const root = bvRoot(cwd);
  await mkdir(runsRoot(cwd), { recursive: true });

  const policy = policyPath(cwd);
  let policyCreated = false;

  const existing = await readFile(policy, 'utf8').catch(() => undefined);
  if (existing === undefined) {
    const packaged = packagedPolicyPath();
    const content = await readFile(packaged, 'utf8').catch(() => undefined);
    if (content === undefined) {
      // The packaged policy is unavailable (running from a bundle without the
      // policies directory): write a minimal, valid policy inline.
      await writeFile(
        policy,
        [
          'version: 1',
          'domains:',
          '  allow: [localhost, 127.0.0.1]',
          '  deny: []',
          'ownedOrigins: []',
          'actionClasses:',
          '  approvalRequired: [submit, destructive, financial, messaging, upload]',
          '  deny: []',
          'budgets:',
          '  maxSteps: 80',
          '  maxRetriesPerStep: 2',
          '  maxSeconds: 600',
          '  maxTokens: 200000',
          'rate:',
          '  maxRpsPerDomain: 1',
          '  jitterMs: [300, 1200]',
          'compliance:',
          '  respectRobots: true',
          '  captcha: human_handoff',
          'secrets:',
          '  maskInLogs: true',
          '',
        ].join('\n'),
        'utf8',
      );
    } else {
      await copyFile(packaged, policy);
    }
    policyCreated = true;
  }

  return { root, policyCreated, policyPath: policy };
}

/** Register the `init` command. */
export function registerInit(program: Command): void {
  program
    .command('init')
    .description('create .bv/ and write a default policy')
    .action(async (_options: unknown, cmd: Command) => {
      const global = globalOptions(cmd);
      try {
        const result = await runInit(global.cwd);
        const lines = [
          `runtime directory: ${result.root}`,
          result.policyCreated
            ? `policy written: ${result.policyPath}`
            : `policy kept (already exists): ${result.policyPath}`,
          'next: bv session start --headed',
        ];
        emit(cmd, ok(result, lines));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit(
          cmd,
          fail({ error: 'init_failed', message }, [`Could not initialise: ${message}`], EXIT.FAILURE),
        );
      }
    });
}
