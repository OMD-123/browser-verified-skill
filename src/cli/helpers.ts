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

/** Read the global options from a command's parent program. */
export function globalOptions(cmd: Command): GlobalOptions {
  const opts = cmd.parent?.opts<Partial<GlobalOptions>>() ?? {};
  return {
    json: opts.json === true,
    cwd: opts.cwd ?? process.cwd(),
  };
}

/** Print a command result honouring the global `--json` flag. */
export function emit(cmd: Command, result: CommandResult): void {
  const global = globalOptions(cmd);
  printResult(result, {
    json: global.json,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
