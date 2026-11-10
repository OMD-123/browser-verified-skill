/**
 * `bv demo` — run the demo, and show it as an agent can read it.
 *
 * ## Why this command exists
 *
 * There is a video of the demo. A person watches it. An agent cannot:
 * it cannot watch 2.5 minutes of a terminal and quote what it saw.
 *
 * So the same run has two outputs:
 *
 *   - `docs/demo.mp4`, for a person
 *   - this command's output, for an agent
 *
 * The output is the same run, written as a document: every command, every
 * exit code, and every refusal with the reason it gave.
 *
 * ## What an agent should learn from it
 *
 * The refusals are the lesson. Exit 4 means "a human must approve"; exit
 * 5 means "stop"; exit 3 means "the plan does not cover this". An agent
 * that knows the difference drives the tool correctly, and one that does
 * not will try to work around a refusal it should have respected.
 */
import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emit } from '../helpers.js';
import { fail } from '../../core/output.js';
import { EXIT } from '../../core/exit.js';

/** The demo script, in the source tree or in the bundle. */
function demoScript(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  // The bundled CLI lives in `scripts/bv.mjs` and the source lives in
  // `src/cli/commands/`, so the depth differs. Both are tried, plus a
  // walk up from the working directory, which covers an installed
  // package.
  const candidates = [
    resolve(here, '..', '..', 'scripts', 'demo-agent.sh'),
    resolve(here, '..', '..', '..', 'scripts', 'demo-agent.sh'),
    resolve(here, '..', '..', '..', '..', 'scripts', 'demo-agent.sh'),
    resolve(process.cwd(), 'scripts', 'demo-agent.sh'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function registerDemo(program: Command): void {
  program
    .command('demo')
    .description('run the demo and print it as a document an agent can read')
    .option('--script <path>', 'the demo script to run')
    .option('--workspace <dir>', 'the workspace the demo runs in')
    .action(async (options: { script?: string; workspace?: string }, cmd: Command) => {
      // An explicit script that does not exist is an error, not a
      // reason to fall back to the packaged one.
      const script =
        options.script !== undefined
          ? existsSync(options.script)
            ? options.script
            : undefined
          : demoScript();

      if (script === undefined) {
        emit(
          cmd,
          fail(
            { error: 'the demo script was not found' },
            [
              'the demo script was not found. It ships with the source tree;',
              'from a published package, run `bash scripts/demo-agent.sh` yourself.',
            ],
            EXIT.FAILURE,
          ),
        );
        return;
      }

      // The script prints the report. Let it write to stdout directly,
      // because it is a document, not a structured payload.
      // The demo runs in its own workspace: a fresh subdirectory, so a
      // run never inherits the last one's state and never writes into
      // the directory it was pointed at.
      // It is not the repository by default. The demo writes a compiled
      // Playwright file, and that should not land in a source tree.
      const workspace = options.workspace ?? tmpdir();
      const child = spawn('bash', [script], {
        cwd: workspace,
        env: {
          ...process.env,
          DEMO_WORKSPACE: workspace,
        },
        stdio: 'inherit',
      });

      await new Promise<void>((resolvePromise) => {
        child.on('close', (code) => {
          process.exitCode = code ?? 0;
          resolvePromise();
        });
      });
    });
}
