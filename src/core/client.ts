/**
 * The CLI-side daemon client.
 *
 * Every `bv` command that needs the browser goes through this client. It
 * reads the descriptor from `.bv/daemon.json`, loads the bearer token from
 * `.bv/daemon.token`, and speaks the small JSON-over-HTTP protocol.
 */
import { readDaemonInfo, readDaemonToken, daemonBaseUrl, isProcessAlive } from './daemon-info.js';
import { APPROVER_TOKEN_HEADER } from '../safety/approver.js';
import { SessionError, InjectionBlockedError } from './errors.js';
import { EXIT } from './exit.js';
import type { DaemonRequest, DaemonResponse } from './daemon.js';

/** A connection to a running daemon. */
export interface DaemonClient {
  /** The port the daemon listens on. */
  readonly port: number;
  /** Call a daemon method. */
  call: <T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ) => Promise<T>;
  /** Check that the daemon is alive. */
  health: () => Promise<boolean>;
}

/** How long to wait for a daemon response by default. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Connect to the daemon described by `.bv/daemon.json`.
 *
 * Throws a `SessionError` with an actionable message when there is no
 * daemon. That is a failure (exit 1), not a usage error (exit 2): the
 * command line was fine, there was simply no browser to talk to.
 */
export async function connectDaemon(cwd?: string): Promise<DaemonClient> {
  const info = await readDaemonInfo(cwd);
  if (info === undefined) {
    throw new SessionError('no running session found. Start one with `bv session start`.');
  }
  if (!isProcessAlive(info.pid)) {
    throw new SessionError(
      `the session process (pid ${info.pid}) is no longer running. Start a new one with \`bv session start\`.`,
    );
  }
  const token = await readDaemonToken(cwd);
  if (token === undefined) {
    throw new SessionError(
      'the session token is missing. Stop the stale session with `bv session stop` and start a new one.',
    );
  }

  const baseUrl = daemonBaseUrl(info);
  return createClient(baseUrl, token, info.port);
}

/**
 * Build a client that can also approve.
 *
 * This is the **operator's** client, not the agent's. It reads the
 * approver credential from `approver.token`, a file the agent's process
 * never reads, and sends it on the approval methods.
 *
 * The agent's own client does not have one, so an agent calling
 * `approve.issue` is refused by the daemon.
 */
export async function createApproverClient(cwd?: string): Promise<DaemonClient> {
  const info = await readDaemonInfo(cwd);
  if (info === undefined) {
    throw new SessionError('no running session found. Start one with `bv session start`.');
  }
  const token = await readDaemonToken(cwd);
  if (token === undefined) {
    throw new SessionError(
      'the session token is missing. Stop the stale session with `bv session stop` and start a new one.',
    );
  }

  const { ApproverCredential } = await import('../safety/approver.js');
  const credential = await ApproverCredential.load(cwd ?? process.cwd());

  const baseUrl = daemonBaseUrl(info);
  return createClient(baseUrl, token, info.port, credential.revealSecret());
}

/** Build a client for an explicit base URL and token. */
export function createClient(
  baseUrl: string,
  token: string,
  port: number,
  approverSecret?: string,
): DaemonClient {
  const call = async <T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<T> => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          // The approver credential, when this client has one. The agent's
          // client does not, so the daemon refuses its approval requests.
          ...(approverSecret !== undefined ? { [APPROVER_TOKEN_HEADER]: approverSecret } : {}),
        },
        body: JSON.stringify({ method, params } satisfies DaemonRequest),
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SessionError(`could not reach the session daemon: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    let body: DaemonResponse;
    try {
      body = (await response.json()) as DaemonResponse;
    } catch {
      throw new SessionError(
        `the session daemon returned a non-JSON response (${response.status})`,
      );
    }

    if (!body.ok) {
      const err = new Error(body.error ?? 'the session daemon reported an unknown error');
      Object.assign(err, { reasons: body.reasons ?? [], exitCode: body.exitCode });
      throw err;
    }

    // An injection block gets its own error class, so a caller can tell
    // "the page tried to take over the agent" apart from "the policy
    // said no" without parsing the message.
    //
    // The daemon reports the refusal in the DATA, with the exit code
    // beside it, so the check is on both.
    if (body.exitCode === EXIT.INJECTION_BLOCK) {
      const data = body.data as { reasons?: string[] } | undefined;
      throw new InjectionBlockedError(
        'a prompt-injection payload was found and the action was refused',
        data?.reasons ?? body.reasons ?? [],
      );
    }

    return body.data as T;
  };

  const health = async (): Promise<boolean> => {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  };

  return { port, call, health };
}
