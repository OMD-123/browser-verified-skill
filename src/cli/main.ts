/**
 * CLI entry point.
 *
 * This module is *wiring only*: it parses arguments with commander, calls into
 * the core, and prints the result. No business logic lives here.
 */
import { Command, CommanderError } from 'commander';
import { EXIT, type ExitCode } from '../core/exit.js';
import { toBvError } from '../core/errors.js';
import { printResult, type CommandResult } from '../core/output.js';
import { DESCRIPTION, VERSION } from '../version.js';
import { registerDoctor } from './commands/doctor.js';
import { registerInit } from './commands/init.js';
import { registerSession } from './commands/session.js';
import { registerPerception } from './commands/perception.js';
import { registerSafety } from './commands/safety.js';
import { registerProof } from './commands/proof.js';
import { registerQa } from './commands/qa.js';
import { globalOptions, emittedCode, setRootProgram } from './helpers.js';

/** Global options every command inherits from the root program. */
export interface GlobalOptions {
  json: boolean;
  cwd: string;
}

/**
 * Build the commander program.
 *
 * Exported separately from the `main` side effect so tests can drive the CLI
 * in-process without spawning a child process.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('bv')
    .description(DESCRIPTION)
    .version(VERSION, '-V, --version', 'print the version and exit')
    .option('--json', 'emit machine-readable JSON on stdout', false)
    .option('--cwd <dir>', 'working directory that holds .bv/', process.cwd())
    .showHelpAfterError('(run with --help for usage)')
    .enablePositionalOptions();

  registerDoctor(program);
  registerInit(program);
  registerSession(program);
  registerPerception(program);
  registerSafety(program);
  registerProof(program);
  registerQa(program);

  // The global options live on the root program. Recording it here means
  // every command can read them without relying on the shape of the
  // arguments commander passes to an action handler.
  setRootProgram(program);

  return program;
}

/**
 * Map a commander error to a `bv` exit code.
 *
 * Commander's own codes:
 *   `commander.helpDisplayed` / `commander.version` → success (0)
 *   `commander.help`                                  → usage (2): no subcommand
 *   everything else (unknown command, missing argument,
 *   unknown option, excess arguments)                  → usage (2)
 */
export function mapCommanderError(err: CommanderError): ExitCode {
  switch (err.code) {
    case 'commander.helpDisplayed':
    case 'commander.version':
      return EXIT.OK;
    default:
      return EXIT.USAGE;
  }
}

/**
 * Run the CLI.
 *
 * Returns the process exit code rather than calling `process.exit`, so tests
 * can assert on it.
 */
export async function run(argv: readonly string[]): Promise<number> {
  // The daemon is re-spawned from the bundle with `--daemon`; in that mode
  // this process runs the daemon instead of the CLI.
  if (argv.includes('--daemon')) {
    await runDaemonFromArgv(argv);
    return EXIT.OK;
  }

  const program = buildProgram();
  program.exitOverride();

  // Commands print their own results via the `emit` helper. The root program
  // only handles the case where no subcommand was given.
  let handled = false;
  program.hook('preAction', (_thisCommand, actionCommand) => {
    handled = actionCommand !== program;
  });

  let result: CommandResult = { data: null, lines: [], code: EXIT.OK };
  try {
    await program.parseAsync(argv, { from: 'user' });
    if (!handled) {
      // No subcommand: print help and signal a usage error.
      program.outputHelp();
      result = { data: null, lines: [], code: EXIT.USAGE };
    }
  } catch (err) {
    if (err instanceof CommanderError) {
      const code = mapCommanderError(err);
      // `commander.help` (no subcommand) prints the help text itself.
      if (err.code === 'commander.help') program.outputHelp();
      result = {
        data: { error: 'UsageError', message: err.message, reasons: [] },
        lines: err.code === 'commander.help' ? [] : [err.message],
        code,
      };
    } else {
      const bvErr = toBvError(err);
      result = {
        data: {
          error: bvErr.name,
          message: bvErr.message,
          reasons: bvErr.reasons,
          ...bvErr.detail,
        },
        lines: [bvErr.message],
        code: bvErr.exitCode,
      };
    }
  }

  // If a command already printed its own output, do not print it again.
  // Its exit code was recorded by `emit`.
  if (handled) return emittedCode ?? result.code;

  const opts = globalOptions(program);
  printResult(result, {
    json: opts.json,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  return result.code;
}

/** Entry point used by the bundled `scripts/bv.mjs`. */
export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const code = await run(argv.slice(2));
  process.exitCode = code;
}

/**
 * Run the daemon, from the `--daemon` flag.
 *
 * The daemon never returns: it serves until it is stopped.
 */
async function runDaemonFromArgv(argv: readonly string[]): Promise<void> {
  const { runDaemonProcess } = await import('../core/daemon-process.js');
  const options = parseDaemonArgs(argv);
  await runDaemonProcess(options);
}

/** Parse the daemon's command-line arguments. */
function parseDaemonArgs(argv: readonly string[]): {
  cwd: string;
  session: string;
  headed: boolean;
  contact?: string;
  runId?: string;
} {
  let cwd = process.cwd();
  let session = 'default';
  let headed = false;
  let contact: string | undefined;
  let runId: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd') {
      const value = argv[i + 1];
      if (value !== undefined) {
        cwd = value;
        i++;
      }
    } else if (arg === '--session') {
      const value = argv[i + 1];
      if (value !== undefined) {
        session = value;
        i++;
      }
    } else if (arg === '--headed') {
      headed = true;
    } else if (arg === '--contact') {
      const value = argv[i + 1];
      if (value !== undefined) {
        contact = value;
        i++;
      }
    } else if (arg === '--run-id') {
      const value = argv[i + 1];
      if (value !== undefined) {
        runId = value;
        i++;
      }
    }
  }

  return {
    cwd,
    session,
    headed,
    ...(contact !== undefined ? { contact } : {}),
    ...(runId !== undefined ? { runId } : {}),
  };
}
