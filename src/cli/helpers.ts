/**
 * Shared CLI helpers.
 *
 * Commander wiring lives in `src/cli/`; this module holds the small utilities
 * every command needs so they are not re-implemented per command.
 */
import type { Command } from 'commander';
import { printResult, type CommandResult } from '../core/output.js';

/** Global options every command inherits from the root program. */
export interface GlobalOptions {
  json: boolean;
  cwd: string;
}

/**
 * The root program.
 *
 * Set by `buildProgram`. The global options live on the root, and reading
 * them through `cmd.parent` is unreliable: commander passes the options
 * object — not the command — as the second-to-last argument of an action
 * handler, so a handler that takes arguments would otherwise read the
 * wrong thing.
 */
let rootProgram: Command | undefined;

/** Record the root program so the global options can be read from it. */
export function setRootProgram(program: Command): void {
  rootProgram = program;
}

/** Read the global options. */
export function globalOptions(_cmd?: Command): GlobalOptions {
  const opts = rootProgram?.opts<Partial<GlobalOptions>>() ?? {};
  return {
    json: opts.json === true,
    cwd: opts.cwd ?? process.cwd(),
  };
}

/**
 * The exit code of the last `emit` call.
 *
 * `undefined` when no command has emitted yet.
 */
export let emittedCode: number | undefined;

/** Print a command result honouring the global `--json` flag. */
export function emit(_cmd: Command | undefined, result: CommandResult): void {
  const global = globalOptions();
  printResult(result, {
    json: global.json,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  // The exit code is the command's contract with a calling script, so it is
  // recorded here. `run` reads it back, so that the value returned by `run`
  // and the value the process exits with are the same.
  process.exitCode = result.code;
  emittedCode = result.code;
}
