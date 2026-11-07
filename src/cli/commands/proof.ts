/**
 * `bv verify`, `bv extract`, `bv compile`, `bv replay`, `bv drift` and
 * `bv memory` — the proof-and-reuse commands.
 */
import type { Command } from 'commander';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ok, fail } from '../../core/output.js';
import { EXIT } from '../../core/exit.js';
import { connectDaemon } from '../../core/client.js';
import { emit, globalOptions } from '../helpers.js';
import { UsageError } from '../../core/errors.js';
import { absPath } from '../../core/paths.js';
import { ConditionSchema, type Condition } from '../../safety/planlock.js';
import { Playbooks, originOf, renderPlaybooks } from '../../memory/playbooks.js';
import { compileFlow, renderScript } from '../../compile/compiler.js';
import { parseVariables } from '../../compile/replay.js';
import { DriftLog } from '../../compile/heal.js';
import type { RecordedRun } from '../../compile/ir.js';
import { readRun } from '../../core/runstore/store.js';

/** The result of a daemon `verify` call. */
interface VerifyPayload {
  passed: boolean;
  results: { condition: Condition; passed: boolean; reason: string }[];
  evidence: unknown[];
  verifiedAt: string;
  url: string;
  summary: string;
}

/** The result of a daemon `extract` call. */
interface ExtractPayload {
  fields: Record<string, { value: unknown; evidence: { url: string; verified: boolean } }>;
  order: string[];
  extractedAt: string;
  url: string;
}

/** Register the proof-and-reuse commands. */
export function registerProof(program: Command): void {
  // --- bv verify ---------------------------------------------------------
  program
    .command('verify')
    .description('check the success condition against the live page')
    .option('--condition <file>', 'the condition JSON file')
    .option('--run <runId>', 'the run to write the evidence to')
    .action(async (options: { condition?: string; run?: string }, cmd: Command) => {
      const global = globalOptions(cmd);
      if (options.condition === undefined) {
        const message = 'bv verify needs --condition <file>';
        emit(cmd, fail({ error: message }, [message], EXIT.USAGE));
        return;
      }

      try {
        const raw = await readFile(absPath(options.condition, global.cwd), 'utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new UsageError(`the condition file is not valid JSON: ${message}`);
        }

        const result = ConditionSchema.safeParse(parsed);
        if (!result.success) {
          const issues = result.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ');
          throw new UsageError(`the condition is not valid: ${issues}`);
        }

        const client = await connectDaemon(global.cwd);
        const payload = await client.call<VerifyPayload>('verify', {
          condition: result.data,
          ...(options.run !== undefined ? { runId: options.run } : {}),
        });

        const lines = [
          payload.summary,
          ...payload.results.map((r) => `  ${r.passed ? 'pass' : 'FAIL'}  ${r.reason}`),
        ];
        // A run that did not verify is a failure, not a success.
        emit(
          cmd,
          payload.passed ? ok(payload, lines) : fail(payload, lines, EXIT.VERIFICATION_FAILED),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });

  // --- bv extract --------------------------------------------------------
  program
    .command('extract')
    .description('extract values from the page, each with its evidence')
    .option('--schema <file>', 'the JSON Schema file')
    .option('--out <file>', 'write the result to this file')
    .option('--format <format>', 'json, csv or md', 'json')
    .action(async (options: { schema?: string; out?: string; format?: string }, cmd: Command) => {
      const global = globalOptions(cmd);
      if (options.schema === undefined) {
        const message = 'bv extract needs --schema <file>';
        emit(cmd, fail({ error: message }, [message], EXIT.USAGE));
        return;
      }

      const format = options.format ?? 'json';
      if (!['json', 'csv', 'md'].includes(format)) {
        const message = `--format must be json, csv or md, not "${format}"`;
        emit(cmd, fail({ error: message }, [message], EXIT.USAGE));
        return;
      }

      try {
        const raw = await readFile(absPath(options.schema, global.cwd), 'utf8');
        let schema: unknown;
        try {
          schema = JSON.parse(raw);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new UsageError(`the schema file is not valid JSON: ${message}`);
        }

        const client = await connectDaemon(global.cwd);
        const payload = await client.call<ExtractPayload>('extract', { schema });

        const text = renderExtract(payload, format);
        if (options.out !== undefined) {
          const path = absPath(options.out, global.cwd);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, text, 'utf8');
          emit(cmd, ok(payload, [`written to ${options.out}`]));
          return;
        }
        emit(cmd, ok(payload, [text]));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });

  // --- bv rewind ---------------------------------------------------------
  program
    .command('rewind')
    .description('rewind the browser to an earlier step and continue in a branch run')
    .option('--to <n>', 'the step to rewind to')
    .option('--run <runId>', 'the run the step belongs to')
    .action(async (options: { to?: string; run?: string }, cmd: Command) => {
      const global = globalOptions(cmd);
      if (options.to === undefined) {
        const message = 'bv rewind needs --to <n>';
        emit(cmd, fail({ error: message }, [message], EXIT.USAGE));
        return;
      }

      const to = Number(options.to);
      if (!Number.isInteger(to) || to < 1) {
        const message = `--to must be a step number, not "${options.to}"`;
        emit(cmd, fail({ error: message }, [message], EXIT.USAGE));
        return;
      }

      try {
        const client = await connectDaemon(global.cwd);
        const payload = await client.call<{
          branchRunId: string;
          toStep: number;
          url: string;
          storageRestored: boolean;
          notRestored: string[];
        }>('rewind', {
          to,
          ...(options.run !== undefined ? { runId: options.run } : {}),
        });

        const lines = [
          `rewound to step ${payload.toStep} in branch run ${payload.branchRunId}`,
          `url: ${payload.url}`,
          `storage state restored: ${payload.storageRestored ? 'yes' : 'no'}`,
          '',
          "A rewind restores the browser's place, not the moment. Not restored:",
          ...payload.notRestored.map((item) => `  - ${item}`),
        ];
        emit(cmd, ok(payload, lines));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });

  // --- bv compile --------------------------------------------------------
  program
    .command('compile')
    .description('compile a recorded run into a plain Playwright script')
    .argument('<runId>', 'the run to compile')
    .option('--out <file>', 'the file to write (default flows/<runId>.spec.ts)')
    .action(async (runId: string, options: { out?: string }, cmd: Command) => {
      const global = globalOptions(cmd);
      try {
        const run = await readRun(runId, global.cwd);
        const flow = compileFlow(run, runId);
        const script = renderScript(flow);

        const out = options.out ?? `flows/${runId}.spec.ts`;
        const path = absPath(out, global.cwd);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, script, 'utf8');

        const lines = [
          `compiled ${run.steps.length} step(s) into ${out}`,
          ...(flow.variables.length > 0
            ? [`variables: ${flow.variables.map((v) => v.name).join(', ')}`]
            : []),
        ];
        emit(cmd, ok({ runId, out, steps: run.steps.length }, lines));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });

  // --- bv replay ---------------------------------------------------------
  program
    .command('replay')
    .description('replay a recorded run deterministically, with no LLM cost')
    .argument('<runId>', 'the run to replay')
    .option('--var <k=v>', 'a variable value (repeatable)', collect)
    .option('--heal', 'repair a step whose locator broke', false)
    .action(async (runId: string, options: { var?: string[]; heal?: boolean }, cmd: Command) => {
      const global = globalOptions(cmd);
      try {
        await readRun(runId, global.cwd);
        const client = await connectDaemon(global.cwd);
        const payload = await client.call<{
          ok: boolean;
          summary: string;
          healedCount: number;
          drift: { stepIndex: number; from: string; to: string; unchanged: string }[];
        }>('replay', {
          runId,
          variables: parseVariables(options.var ?? []),
          heal: options.heal === true,
        });

        const lines = [payload.summary];
        for (const entry of payload.drift) {
          lines.push(`  Step ${entry.stepIndex}: ${entry.from} → ${entry.to} (${entry.unchanged})`);
        }
        emit(cmd, payload.ok ? ok(payload, lines) : fail(payload, lines, EXIT.VERIFICATION_FAILED));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });

  // --- bv drift ----------------------------------------------------------
  program
    .command('drift')
    .description('list the locator changes recorded for a flow')
    .argument('<runId>', 'the run to inspect')
    .action(async (runId: string, cmd: Command) => {
      const global = globalOptions(cmd);
      try {
        const drift = await readDrift(runId, global.cwd);
        const log = new DriftLog();
        for (const entry of drift) log.add(entry);
        emit(cmd, ok({ entries: drift }, [log.render()]));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });

  // --- bv mcp -------------------------------------------------------------
  program
    .command('mcp')
    .description('serve the browser tools over the Model Context Protocol (stdio)')
    .action(async (cmd: Command) => {
      const global = globalOptions(cmd);
      try {
        const { createMcpServer } = await import('../../mcp/wiring.js');
        const server = await createMcpServer({ cwd: global.cwd });
        // The MCP server speaks JSON-RPC over stdio. The banner goes to
        // stderr, because stdout carries the protocol.
        process.stderr.write('browser-verified MCP server ready on stdio\n');
        await server.serve(process.stdin, process.stdout);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });

  // --- bv memory ---------------------------------------------------------
  const memory = program.command('memory').description('manage the site memory');

  memory
    .command('ls')
    .description('list the remembered facts')
    .option('--origin <origin>', 'only this origin')
    .action((options: { origin?: string }, cmd: Command) => {
      const global = globalOptions(cmd);
      try {
        const playbooks = new Playbooks(global.cwd);
        const entries = playbooks.list(options.origin);
        playbooks.close();
        emit(cmd, ok({ entries }, [renderPlaybooks(entries)]));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });

  memory
    .command('rm')
    .description('forget a fact')
    .argument('<origin>', 'the origin')
    .argument('<key>', 'the key')
    .action((origin: string, key: string, cmd: Command) => {
      const global = globalOptions(cmd);
      try {
        const playbooks = new Playbooks(global.cwd);
        const removed = playbooks.forget(origin, key);
        playbooks.close();
        emit(
          cmd,
          removed
            ? ok({ origin, key }, [`forgot ${origin} ${key}`])
            : fail({ error: 'not found' }, [`no entry for ${origin} ${key}`], EXIT.FAILURE),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });

  memory
    .command('prune')
    .description('remove the expired facts')
    .action((cmd: Command) => {
      const global = globalOptions(cmd);
      try {
        const playbooks = new Playbooks(global.cwd);
        const pruned = playbooks.prune();
        playbooks.close();
        emit(cmd, ok({ pruned }, [`removed ${pruned} expired entr${pruned === 1 ? 'y' : 'ies'}`]));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });
}

/** Collect a repeatable option into an array. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Render an extraction in the requested format. */
function renderExtract(payload: ExtractPayload, format: string): string {
  if (format === 'json') return JSON.stringify(payload, null, 2);

  if (format === 'csv') {
    const lines = ['field,value,source,verified'];
    for (const name of payload.order) {
      const field = payload.fields[name];
      if (field === undefined) continue;
      lines.push(
        [
          csvEscape(name),
          csvEscape(field.value === null ? '' : asText(field.value)),
          csvEscape(field.evidence.url),
          field.evidence.verified ? 'yes' : 'no',
        ].join(','),
      );
    }
    return lines.join('\n');
  }

  const lines = ['| Field | Value | Source | Verified |', '| --- | --- | --- | --- |'];
  for (const name of payload.order) {
    const field = payload.fields[name];
    if (field === undefined) continue;
    lines.push(
      `| ${name} | ${field.value === null ? '—' : asText(field.value)} | ${field.evidence.url} | ${field.evidence.verified ? 'yes' : 'no'} |`,
    );
  }
  return lines.join('\n');
}

/**
 * Render an unknown value as text.
 *
 * A plain string is used as-is; anything else is JSON, so an object never
 * becomes `[object Object]`.
 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return '(unserialisable)';
  }
}

/** Escape a value for a CSV cell. */
function csvEscape(value: string): string {
  if (!/[",\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** Read the drift recorded for a run. */
async function readDrift(
  runId: string,
  cwd: string,
): Promise<
  { stepIndex: number; from: string; to: string; unchanged: string; at: string; reason: string }[]
> {
  const run = await readRun(runId, cwd);
  const recorded = (run as RecordedRun & { drift?: unknown }).drift;
  if (Array.isArray(recorded)) {
    return recorded as {
      stepIndex: number;
      from: string;
      to: string;
      unchanged: string;
      at: string;
      reason: string;
    }[];
  }
  return [];
}

/** The origin helper is re-exported so the CLI can use it. */
export { originOf };
