/**
 * Output helpers.
 *
 * Contract for every command:
 *   - `--json` puts machine-readable output on **stdout** (and nothing else)
 *   - human-readable logs go to **stderr**
 *   - without `--json`, human-readable output goes to stdout
 */
import { EXIT, type ExitCode } from './exit.js';

/** The result of a command, ready to be printed. */
export interface CommandResult {
  /** Machine-readable payload for `--json`. */
  readonly data: unknown;
  /** Human-readable summary lines. */
  readonly lines: readonly string[];
  /** Process exit code. */
  readonly code: ExitCode;
  /** Extra fields merged into the JSON payload. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** Build a successful result. */
export function ok(data: unknown, lines: readonly string[] = []): CommandResult {
  return { data, lines, code: EXIT.OK };
}

/** Build a failure result. */
export function fail(
  data: unknown,
  lines: readonly string[],
  code: ExitCode = EXIT.FAILURE,
): CommandResult {
  return { data, lines, code };
}

/**
 * Print a command result.
 *
 * In JSON mode, stdout receives exactly one JSON document. Human output is
 * written to stderr so that piping stdout into `jq` always works.
 */
export function printResult(
  result: CommandResult,
  opts: { json: boolean; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
): void {
  if (opts.json) {
    const payload =
      result.extra && typeof result.data === 'object' && result.data !== null
        ? { ...(result.data as Record<string, unknown>), ...result.extra }
        : result.data;
    opts.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (result.lines.length > 0) {
      opts.stderr.write(`${result.lines.join('\n')}\n`);
    }
    return;
  }
  if (result.lines.length > 0) {
    opts.stdout.write(`${result.lines.join('\n')}\n`);
  }
}
