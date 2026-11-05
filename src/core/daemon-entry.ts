/**
 * The daemon process entry point.
 *
 * This file is spawned detached by `bv session start`. When running from
 * source it is executed through `tsx`; when running from the bundle, the
 * bundle re-spawns itself with `--daemon` and the CLI's `main` handles it.
 *
 * Both paths converge on `runDaemonProcess`.
 */
import { runDaemonProcess } from './daemon-process.js';

/** Parse `--flag value` style arguments. */
function parseArgs(argv: readonly string[]): {
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
    switch (arg) {
      case '--cwd': {
        const value = argv[i + 1];
        if (value !== undefined) {
          cwd = value;
          i++;
        }
        break;
      }
      case '--session': {
        const value = argv[i + 1];
        if (value !== undefined) {
          session = value;
          i++;
        }
        break;
      }
      case '--headed':
        headed = true;
        break;
      case '--contact': {
        const value = argv[i + 1];
        if (value !== undefined) {
          contact = value;
          i++;
        }
        break;
      }
      case '--run-id': {
        const value = argv[i + 1];
        if (value !== undefined) {
          runId = value;
          i++;
        }
        break;
      }
      default:
        break;
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

const options = parseArgs(process.argv.slice(2));

runDaemonProcess(options).catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
