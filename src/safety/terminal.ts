/**
 * The controlling terminal (Phase 0, gap 1).
 *
 * ## Why a terminal and not stdout
 *
 * The daemon runs detached with `stdio: 'ignore'`, so it has no stdout
 * of its own. If it wrote to stdout, the output would go nowhere the
 * operator sees. If it wrote to a file, the agent's process could read
 * that file, and a code read by the agent is a code the agent can use.
 *
 * So the daemon writes to the **controlling terminal's device file**:
 * `/dev/tty` on POSIX, `CONOUT$` on Windows. That is a separate
 * descriptor, opened by the daemon, which the agent's process has no
 * handle on. The agent can read the daemon's audit log; it cannot read
 * the terminal.
 *
 * The point is not that the agent is prevented from reading a string. It
 * is that the string never travels anywhere the agent can reach.
 *
 * ## When there is no terminal
 *
 * Headless, in CI, or over SSH with no tty: there is no controlling
 * terminal to write to. The daemon says so once, and then the code
 * channel still works — the operator can read the code from wherever
 * the daemon's output goes, or use `bv approvals` on a local web page.
 */
import { open, type FileHandle } from 'node:fs/promises';
import { platform } from 'node:os';

/**
 * The device path of the controlling terminal.
 *
 * The platform is a parameter so the mapping can be tested for every
 * platform, not just the one the test happens to run on.
 */
export function terminalPathFor(platformName: NodeJS.Platform): string {
  if (platformName === 'win32') {
    return '\\\\.\\CONOUT$';
  }
  // On POSIX, /dev/tty exists only when there is a controlling terminal.
  return '/dev/tty';
}

/** The device path of the controlling terminal on this platform. */
export function controllingTerminalPath(): string {
  return terminalPathFor(platform());
}

/** A handle on the controlling terminal. */
export class ControllingTerminal {
  private handle: FileHandle | undefined;
  private failed = false;

  private constructor(
    handle: FileHandle | undefined,
    private readonly failedReason?: string,
  ) {
    this.handle = handle;
    this.failed = handle === undefined;
  }

  /**
   * Open the controlling terminal.
   *
   * Returns a handle even when there is no terminal, so the caller can
   * ask `available` rather than handling an exception.
   */
  static async open(): Promise<ControllingTerminal> {
    return ControllingTerminal.openPath(controllingTerminalPath());
  }

  /**
   * Open a specific terminal path.
   *
   * The path is a parameter so a test can point it at a path that does
   * not exist, which is what happens on a machine with no controlling
   * terminal.
   */
  static async openPath(path: string): Promise<ControllingTerminal> {
    return ControllingTerminal.openWith(path, (target) => open(target, 'w'));
  }

  /**
   * Open a terminal with an explicit opener.
   *
   * The opener is a parameter so the failure path can be tested: a real
   * `open` only ever fails one way, and the other way -- a rejection
   * that is not an Error -- would otherwise be untested.
   */
  static async openWith(
    path: string,
    opener: (target: string) => Promise<FileHandle>,
  ): Promise<ControllingTerminal> {
    try {
      const handle = await opener(path);
      return new ControllingTerminal(handle);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new ControllingTerminal(undefined, message);
    }
  }

  /** Whether there is a terminal to write to. */
  get available(): boolean {
    return !this.failed && this.handle !== undefined;
  }

  /** Why the terminal is unavailable, if it is. */
  get reason(): string | undefined {
    return this.failedReason;
  }

  /**
   * Write a line to the controlling terminal.
   *
   * Returns whether it was written. A failure here is never fatal: the
   * approval still works through the code channel, and a daemon that
   * cannot reach the terminal should still serve requests.
   */
  async write(line: string): Promise<boolean> {
    if (this.handle === undefined) return false;
    try {
      await this.handle.write(`${line}\n`);
      return true;
    } catch {
      // A write that fails is not fatal: the approval still works
      // through the code channel.
      return false;
    }
  }

  /** Close the terminal handle. */
  async close(): Promise<void> {
    if (this.handle === undefined) return;
    try {
      await this.handle.close();
    } catch {
      // Closing a terminal that is already gone is not an error.
    }
    this.handle = undefined;
  }
}

/**
 * The text shown to a human when an action needs approval.
 *
 * It says exactly what is being approved, and how to approve it. A human
 * who cannot tell what they are approving will approve the wrong thing.
 */
export function approvalPrompt(options: {
  actionId: string;
  code: string;
  description: string;
  url?: string;
}): string {
  const lines = [
    '',
    '  bv: this action needs your approval',
    '',
    `    action:  ${options.description}`,
    `    id:      ${options.actionId}`,
    `    code:   ${options.code}`,
  ];

  if (options.url !== undefined) {
    lines.push(`    approve: bv approve ${options.actionId} --code ${options.code}`);
    lines.push(`    or:     ${options.url}`);
  } else {
    lines.push(`    approve: bv approve ${options.actionId} --code ${options.code}`);
  }

  lines.push('');
  lines.push('  The code expires in five minutes and is good for this action only.');
  lines.push('');

  return lines.join('\n');
}
