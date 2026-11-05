/**
 * The CLI-side daemon client.
 *
 * Every `bv` command that needs the browser goes through this client. It
 * reads the descriptor from `.bv/daemon.json`, loads the bearer token from
 * `.bv/daemon.token`, and speaks the small JSON-over-HTTP protocol.
 */
import { readDaemonInfo, readDaemonToken, isProcessAlive, daemonBaseUrl } from './daemon-info.js';
import { UsageError } from './errors.js';
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
 * Throws a `UsageError` with an actionable message when there is no daemon,
 * which the CLI turns into exit code 2.
 */
export async function connectDaemon(cwd?: string): Promise<DaemonClient> {
  const info = await readDaemonInfo(cwd);
  if (info === undefined) {
    throw new UsageError('no running session found. Start one with `bv session start`.');
  }
  if (!isProcessAlive(info.pid)) {
    throw new UsageError(
      `the session process (pid ${info.pid}) is no longer running. Start a new one with \`bv session start\`.`,
    );
  }
  const token = await readDaemonToken(cwd);
  if (token === undefined) {
    throw new UsageError(
      'the session token is missing. Stop the stale session with `bv session stop` and start a new one.',
    );
  }

  const baseUrl = daemonBaseUrl(info);
  return createClient(baseUrl, token, info.port);
}

/** Build a client for an explicit base URL and token. */
export function createClient(baseUrl: string, token: string, port: number): DaemonClient {
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
        },
        body: JSON.stringify({ method, params } satisfies DaemonRequest),
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new UsageError(`could not reach the session daemon: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    let body: DaemonResponse;
    try {
      body = (await response.json()) as DaemonResponse;
    } catch {
      throw new UsageError(`the session daemon returned a non-JSON response (${response.status})`);
    }

    if (!body.ok) {
      const err = new Error(body.error ?? 'the session daemon reported an unknown error');
      Object.assign(err, { reasons: body.reasons ?? [], exitCode: body.exitCode });
      throw err;
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
