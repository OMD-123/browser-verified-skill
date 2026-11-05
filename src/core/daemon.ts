/**
 * The session daemon.
 *
 * A detached Node process that owns the Playwright `Browser` and serves a
 * small JSON-over-HTTP API on `127.0.0.1`. Every other `bv` command is a thin
 * client of this API.
 *
 * Security properties:
 *  - binds to loopback only,
 *  - requires a bearer token on every request, compared in constant time,
 *  - the token hash (not the token) is stored in `daemon.json`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Browser, BrowserContext, Page } from 'playwright';
import { hashToken, tokenMatches, type DaemonInfo } from './daemon-info.js';
import { VERSION } from '../version.js';

/** The request body of a daemon API call. */
export interface DaemonRequest {
  /** The method name, e.g. `snapshot`, `act`, `goto`. */
  method: string;
  /** Method-specific parameters. */
  params?: Record<string, unknown>;
  /** The session the call targets. */
  session?: string;
}

/** The response body of a daemon API call. */
export interface DaemonResponse {
  ok: boolean;
  /** The method result. */
  data?: unknown;
  /** A human-readable error message. */
  error?: string;
  /** Machine-readable reason codes. */
  reasons?: string[];
  /** The exit code the CLI should use. */
  exitCode?: number;
}

/** A handler registered for a daemon method. */
export type DaemonHandler = (
  request: DaemonRequest,
) => Promise<{ data?: unknown; exitCode?: number; reasons?: string[] }>;

/** Options for starting the daemon. */
export interface DaemonOptions {
  /** The handlers, keyed by method name. */
  handlers: Record<string, DaemonHandler>;
  /** The bearer token. Generated when not supplied. */
  token?: string;
  /** The session name. */
  session?: string;
  /** Whether the browser is headed. */
  headed?: boolean;
  /** The browser name. */
  browser?: string;
  /** The pid recorded in the descriptor. */
  pid?: number;
  /** Maximum request body size in bytes. Default 32 MiB (screenshots, HAR). */
  maxBodyBytes?: number;
}

/** The running daemon. */
export interface Daemon {
  /** The port the daemon listens on. */
  readonly port: number;
  /** The bearer token. */
  readonly token: string;
  /** The descriptor to write to disk. */
  readonly info: DaemonInfo;
  /** The underlying HTTP server. */
  readonly server: Server;
  /** Stop the daemon and release the port. */
  close: () => Promise<void>;
}

/** Read a request body, enforcing a size limit. */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) {
      throw new Error(`request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Start the daemon HTTP server.
 *
 * The browser is *not* started here: the caller owns the `Browser` and passes
 * it in through the handlers. That keeps this module free of Playwright
 * imports and makes it testable with a stub.
 */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const token = options.token ?? randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const maxBodyBytes = options.maxBodyBytes ?? 32 * 1024 * 1024;

  const server = createServer((req, res) => {
    void handleRequest(req, res, options, tokenHash, maxBodyBytes);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('daemon failed to bind a port');
  }

  const info: DaemonInfo = {
    version: 1,
    port: address.port,
    pid: options.pid ?? process.pid,
    tokenHash,
    session: options.session ?? 'default',
    startedAt: new Date().toISOString(),
    headed: options.headed ?? false,
    browser: options.browser ?? 'chromium',
  };

  return {
    port: address.port,
    token,
    info,
    server,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

/** Handle one HTTP request. */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: DaemonOptions,
  tokenHash: string,
  maxBodyBytes: number,
): Promise<void> {
  const send = (status: number, body: DaemonResponse): void => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    });
    res.end(payload);
  };

  try {
    // --- Auth ---------------------------------------------------------------
    const header = req.headers['authorization'];
    const presented =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!tokenMatches(presented, tokenHash)) {
      send(401, { ok: false, error: 'unauthorized: invalid or missing bearer token' });
      return;
    }

    // --- Route --------------------------------------------------------------
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      send(200, { ok: true, data: { version: VERSION, status: 'ok' } });
      return;
    }

    if (req.method !== 'POST') {
      send(405, { ok: false, error: `method not allowed: ${req.method ?? 'unknown'}` });
      return;
    }

    const raw = await readBody(req, maxBodyBytes);
    let parsed: DaemonRequest;
    try {
      parsed = JSON.parse(raw) as DaemonRequest;
    } catch {
      send(400, { ok: false, error: 'invalid JSON body' });
      return;
    }

    if (typeof parsed.method !== 'string' || parsed.method.length === 0) {
      send(400, { ok: false, error: 'missing "method" in request body' });
      return;
    }

    const handler = options.handlers[parsed.method];
    if (handler === undefined) {
      send(404, { ok: false, error: `unknown method: ${parsed.method}` });
      return;
    }

    const result = await handler(parsed);
    send(200, {
      ok: true,
      ...(result.data !== undefined ? { data: result.data } : {}),
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(result.reasons !== undefined ? { reasons: result.reasons } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send(500, { ok: false, error: message });
  }
}

/** Wait for the server to be listening. */
export async function waitForListening(server: Server): Promise<void> {
  if (server.listening) return;
  await once(server, 'listening');
}

/**
 * The browser-facing state the daemon owns.
 *
 * Kept separate from the HTTP layer so the same state can be driven in
 *-process by tests.
 */
export interface DaemonBrowserState {
  browser: Browser;
  context?: BrowserContext;
  page?: Page;
}
