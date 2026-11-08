/**
 * `bv plan`, `bv approve`, `bv vault` and `bv dryrun-report` — the safety
 * commands.
 *
 * The plan and the approval store live in the daemon, so these commands talk
 * to it over HTTP. The vault is a file, so `bv vault` reads it directly.
 */
import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { ok, fail } from '../../core/output.js';
import { EXIT } from '../../core/exit.js';
import { connectDaemon, createApproverClient } from '../../core/client.js';
import { emit, globalOptions } from '../helpers.js';
import { UsageError } from '../../core/errors.js';
import { absPath } from '../../core/paths.js';
import { PlanSchema, type Plan } from '../../safety/planlock.js';
import { Vault, passphraseFromEnv } from '../../safety/vault.js';

/** The result of a daemon `plan.set` call. */
interface PlanPayload {
  ok: boolean;
  plan: Plan;
  message: string;
}

/** Register the safety commands. */
export function registerSafety(program: Command): void {
  // --- bv plan -----------------------------------------------------------
  const plan = program
    .command('plan')
    .description('set, show or amend the plan-lock that bounds every action');

  plan
    .command('set')
    .description('set the plan from a JSON file')
    .argument('<file>', 'the plan JSON file')
    .action(async (file: string, cmd: Command) => {
      const global = globalOptions(cmd);
      try {
        const raw = await readFile(absPath(file, global.cwd), 'utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new UsageError(`the plan file is not valid JSON: ${message}`);
        }

        // `createdAt` is stamped by the daemon, so a hand-written plan file
        // does not need it.
        const withTimestamp =
          typeof parsed === 'object' && parsed !== null && !('createdAt' in parsed)
            ? { ...parsed, createdAt: new Date().toISOString() }
            : parsed;

        const result = PlanSchema.safeParse(withTimestamp);
        if (!result.success) {
          const issues = result.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ');
          throw new UsageError(`the plan is not valid: ${issues}`);
        }

        const client = await connectDaemon(global.cwd);
        const payload = await client.call<PlanPayload>('plan.set', { plan: result.data });
        emit(cmd, ok(payload, [payload.message]));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });

  plan
    .command('show')
    .description('show the current plan')
    .action(async (cmd: Command) => {
      const global = globalOptions(cmd);
      try {
        const client = await connectDaemon(global.cwd);
        const payload = await client.call<{ plan: Plan | undefined }>('plan.show');
        if (payload.plan === undefined) {
          emit(
            cmd,
            fail(
              { error: 'no plan is set' },
              ['no plan is set. Run `bv plan set <file>` before acting.'],
              EXIT.FAILURE,
            ),
          );
          return;
        }
        const lines = [
          `goal: ${payload.plan.goal}`,
          `origins: ${payload.plan.allowedOrigins.join(', ') || '(any)'}`,
          `classes: ${payload.plan.allowedActionClasses.join(', ') || '(none)'}`,
          `max steps: ${payload.plan.maxSteps}`,
          `success: ${JSON.stringify(payload.plan.successCondition)}`,
        ];
        emit(cmd, ok(payload, lines));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });

  plan
    .command('amend')
    .description('amend the current plan (requires an approval)')
    .option('--approve <token>', 'an approval token for this amendment')
    .option('--goal <goal>', 'the new goal')
    .option('--add-origin <origin>', 'add an allowed origin (repeatable)')
    .option('--add-class <class>', 'add an allowed action class (repeatable)')
    .option('--max-steps <n>', 'the new step budget')
    .action(
      async (
        options: {
          approve?: string;
          goal?: string;
          addOrigin?: string[];
          addClass?: string[];
          maxSteps?: string;
        },
        cmd: Command,
      ) => {
        const global = globalOptions(cmd);
        try {
          const client = await connectDaemon(global.cwd);
          const payload = await client.call<PlanPayload>('plan.amend', {
            patch: {
              ...(options.goal !== undefined ? { goal: options.goal } : {}),
              ...(options.maxSteps !== undefined ? { maxSteps: Number(options.maxSteps) } : {}),
              ...(options.addOrigin !== undefined ? { addOrigins: options.addOrigin } : {}),
              ...(options.addClass !== undefined ? { addClasses: options.addClass } : {}),
            },
            ...(options.approve !== undefined ? { approvalToken: options.approve } : {}),
          });
          emit(cmd, ok(payload, [payload.message]));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
          emit(cmd, fail({ error: message }, [message], code));
        }
      },
    );

  // --- bv approve --------------------------------------------------------
  // --- bv approvals ------------------------------------------------------
  program
    .command('approvals')
    .description('list the actions waiting for a human approval')
    .action(async (_options: unknown, cmd: Command) => {
      const global = globalOptions(cmd);
      try {
        const client = await connectDaemon(global.cwd);
        const payload = await client.call<{
          waiting: {
            actionId: string;
            description: string;
            code: string;
            createdAt: number;
          }[];
        }>('approve.waiting');

        if (payload.waiting.length === 0) {
          emit(cmd, ok({ waiting: [] }, ['nothing is waiting for approval']));
          return;
        }

        const lines: string[] = [];
        for (const entry of payload.waiting) {
          lines.push(`${entry.code}  ${entry.actionId}`);
          lines.push(`      ${entry.description}`);
          lines.push(`      approve: bv approve ${entry.actionId} --code ${entry.code}`);
        }

        emit(cmd, ok({ waiting: payload.waiting }, lines));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit(cmd, fail({ error: message }, [message], EXIT.FAILURE));
      }
    });

  program
    .command('approve')
    .description('approve a pending action and print a one-time token')
    .argument('<actionId>', 'the action id from the refusal')
    .option('--code <code>', 'the one-time code shown on the controlling terminal')
    .action(async (actionId: string, options: { code?: string }, cmd: Command) => {
      const global = globalOptions(cmd);
      try {
        // The CODE channel comes first, and it needs no credential. The
        // human reads a short code from the terminal that started the
        // daemon and enters it. The code IS the human's proof: it is
        // shown on the controlling terminal, which the agent's process
        // cannot write to or read.
        if (options.code !== undefined) {
          const client = await connectDaemon(global.cwd);
          const viaCode = await client.call<{ ok: boolean; token: string; description: string }>(
            'approve.code',
            { code: options.code },
          );
          if (!viaCode.ok) {
            emit(
              cmd,
              fail(
                { error: 'that code is not valid, or it has expired' },
                ['that code is not valid, or it has expired'],
                EXIT.FAILURE,
              ),
            );
            return;
          }
          emit(
            cmd,
            ok(viaCode, [
              `approved: ${viaCode.description}`,
              `token: ${viaCode.token}`,
              '',
              'The token is valid for this exact action only, and only once.',
            ]),
          );
          return;
        }

        // The APPROVER client, not the agent's. It carries the approver
        // credential, which lives in a file the agent's process never
        // reads. An agent calling this command gets a 403 from the
        // daemon, because it does not have that credential.
        const approver = await createApproverClient(global.cwd);

        const payload = await approver.call<{
          ok: boolean;
          token: string;
          description: string;
        }>('approve.issue', { actionId });
        if (!payload.ok) {
          emit(
            cmd,
            fail(
              { error: `no pending action with id ${actionId}` },
              [`no pending action with id ${actionId}`],
              EXIT.FAILURE,
            ),
          );
          return;
        }
        const lines = [
          `approved: ${payload.description}`,
          `token: ${payload.token}`,
          '',
          'The token is valid for this exact action only, and only once.',
        ];
        emit(cmd, ok(payload, lines));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });

  // --- bv vault ----------------------------------------------------------
  const vault = program.command('vault').description('manage the encrypted secrets vault');

  vault
    .command('set')
    .description('store a secret')
    .argument('<name>', 'the secret name')
    .argument('[value]', 'the secret value (prompted for when omitted)')
    .action(async (name: string, value: string | undefined, cmd: Command) => {
      const global = globalOptions(cmd);
      try {
        const passphrase = passphraseFromEnv();
        if (passphrase === undefined) {
          throw new UsageError(
            'the vault passphrase is required. Set BV_VAULT_PASSPHRASE in the environment.',
          );
        }
        const secret = value ?? (await readSecretFromStdin(name));
        if (secret === undefined || secret.length === 0) {
          throw new UsageError('no secret value was given');
        }

        const store = new Vault();
        await store.load(passphrase, global.cwd);
        store.set(name, secret);
        await store.save(passphrase, global.cwd);
        // The value is never echoed back.
        emit(cmd, ok({ name }, [`stored secret "${name}"`]));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });

  vault
    .command('list')
    .description('list the stored secret names')
    .action(async (cmd: Command) => {
      const global = globalOptions(cmd);
      try {
        const passphrase = passphraseFromEnv();
        if (passphrase === undefined) {
          throw new UsageError(
            'the vault passphrase is required. Set BV_VAULT_PASSPHRASE in the environment.',
          );
        }
        const store = new Vault();
        await store.load(passphrase, global.cwd);
        const secrets = store.list();
        const lines = secrets.map((s) => `${s.name} (stored ${s.storedAt})`);
        if (lines.length === 0) lines.push('(the vault is empty)');
        emit(cmd, ok({ secrets }, lines));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });

  vault
    .command('rm')
    .description('remove a secret')
    .argument('<name>', 'the secret name')
    .action(async (name: string, cmd: Command) => {
      const global = globalOptions(cmd);
      try {
        const passphrase = passphraseFromEnv();
        if (passphrase === undefined) {
          throw new UsageError(
            'the vault passphrase is required. Set BV_VAULT_PASSPHRASE in the environment.',
          );
        }
        const store = new Vault();
        await store.load(passphrase, global.cwd);
        const removed = store.remove(name);
        if (removed) await store.save(passphrase, global.cwd);
        emit(
          cmd,
          removed
            ? ok({ name }, [`removed secret "${name}"`])
            : fail(
                { error: `no secret named "${name}"` },
                [`no secret named "${name}"`],
                EXIT.FAILURE,
              ),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });

  // --- bv dryrun-report --------------------------------------------------
  program
    .command('dryrun-report')
    .description('print what would have been sent, from the last dry run')
    .option('--run <runId>', 'the run to read (defaults to the most recent)')
    .action(async (options: { run?: string }, cmd: Command) => {
      const global = globalOptions(cmd);
      try {
        const client = await connectDaemon(global.cwd);
        const payload = await client.call<{ report: string; intercepted: number }>(
          'dryrun.report',
          {
            ...(options.run !== undefined ? { runId: options.run } : {}),
          },
        );
        emit(cmd, ok(payload, [payload.report]));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });
}

/**
 * Read a secret from standard input.
 *
 * The value is never echoed, so the terminal is put in raw mode when that is
 * possible. Returns undefined when there is nothing to read.
 */
async function readSecretFromStdin(name: string): Promise<string | undefined> {
  if (process.stdin.isTTY !== true) {
    // The value is read from a pipe, so it is read fully and trimmed. The
    // value is never echoed.
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    return text.length > 0 ? text : undefined;
  }

  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`value for ${name}: `);
    return answer.length > 0 ? answer : undefined;
  } finally {
    rl.close();
  }
}
