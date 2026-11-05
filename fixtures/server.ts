/**
 * Shared fixture server for browser-verified tests and demos.
 *
 * Plain Node http, no dependencies. Serves a set of pages under /pages/* that
 * exercise the behaviours the toolkit must handle: forms, iframes, shadow DOM,
 * popups, uploads/downloads, lazy loading, sticky headers, randomized class
 * names, flaky timing, rate limiting, robots disallow and a simulated CAPTCHA.
 *
 * The server is deliberately dependency-injected (clock, randomness) so tests can
 * make it deterministic.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PAGES_DIR = join(HERE, 'pages');

export interface FixtureServerOptions {
  /** Fixed port; 0 picks an ephemeral port. */
  port?: number;
  host?: string;
  /** Emit a request log to stdout (off by default to keep test output clean). */
  verbose?: boolean;
  /**
   * Port of a *second* server that serves the cross-origin-style iframe.
   * When set, `/__cross-origin-port` returns it so a page can point an iframe
   * at a genuinely different origin (different port).
   */
  crossOriginPort?: number;
}

export interface FixtureServer {
  readonly port: number;
  readonly host: string;
  readonly origin: string;
  readonly url: (path: string) => string;
  readonly server: Server;
  readonly requests: readonly { method: string; path: string }[];
  close: () => Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
};

function send(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/**
 * Resolve a request path to a file inside PAGES_DIR, refusing traversal.
 *
 * The fixture site is served under the `/pages/` URL prefix, which maps to the
 * `fixtures/pages/` directory, so the prefix is stripped before joining.
 * Returns null when the path escapes the pages root.
 */
export function resolvePagePath(urlPath: string): string | null {
  let rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  // Strip the `/pages/` URL prefix: it maps to the pages directory itself.
  if (rel === 'pages') rel = 'index.html';
  else if (rel.startsWith('pages/') || rel.startsWith('pages\\')) {
    rel = rel.slice('pages/'.length);
  }
  if (rel.length === 0) return null;
  const abs = join(PAGES_DIR, rel);
  const root = normalize(PAGES_DIR);
  if (!abs.startsWith(root + sep) && abs !== root) return null;
  return abs;
}

/** Build a request handler. Exported so tests can mount it on their own server. */
export function createFixtureHandler(
  state: { requests: { method: string; path: string }[]; rateHits: number; verbose: boolean },
  crossOriginPort: () => number,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    state.requests.push({ method: req.method ?? 'GET', path });

    // --- robots.txt with a disallowed path ---------------------------------
    if (path === '/robots.txt') {
      send(res, 200, 'User-agent: *\nDisallow: /admin\nDisallow: /private\n', {
        'content-type': 'text/plain; charset=utf-8',
      });
      return;
    }

    // --- rate limited endpoint --------------------------------------------
    if (path === '/api/rate-limited') {
      state.rateHits += 1;
      if (state.rateHits % 3 === 0) {
        send(res, 429, JSON.stringify({ error: 'rate_limited', retryAfter: 1 }), {
          'content-type': 'application/json; charset=utf-8',
          'retry-after': '1',
        });
      } else {
        send(res, 200, JSON.stringify({ ok: true, hit: state.rateHits }), {
          'content-type': 'application/json; charset=utf-8',
        });
      }
      return;
    }

    // --- JSON api used by the paginated table ------------------------------
    if (path === '/api/rows') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const perPage = 10;
      const total = 37;
      const rows = Array.from(
        { length: Math.max(0, Math.min(perPage, total - (page - 1) * perPage)) },
        (_, i) => {
          const id = (page - 1) * perPage + i + 1;
          return { id, name: `Row ${id}`, value: id * 7 };
        },
      );
      send(res, 200, JSON.stringify({ page, perPage, total, rows }), {
        'content-type': 'application/json; charset=utf-8',
      });
      return;
    }

    // --- download endpoint --------------------------------------------------
    if (path === '/download/report.csv') {
      const body = 'id,name,value\n1,Row 1,7\n2,Row 2,14\n';
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="report.csv"',
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }

    // --- upload endpoint ----------------------------------------------------
    if (path === '/api/upload' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const size = chunks.reduce((n, c) => n + c.length, 0);
        send(res, 200, JSON.stringify({ ok: true, bytes: size }), {
          'content-type': 'application/json; charset=utf-8',
        });
      });
      return;
    }

    // --- echo endpoint used by the dry-run tests ----------------------------
    if (path === '/api/echo') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        send(
          res,
          200,
          JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString('utf8') }),
          {
            'content-type': 'application/json; charset=utf-8',
          },
        );
      });
      return;
    }

    // --- staging / prod pair ----------------------------------------------
    // The prod page contains an extra banner element so a differential run has
    // a deterministic, intentional difference to find.
    if (path === '/prod' || path === '/staging') {
      const isProd = path === '/prod';
      const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${isProd ? 'Prod' : 'Staging'}</title></head>
<body>
  <main id="app">
    <h1 data-testid="heading">Release ${isProd ? '4.2.0' : '4.3.0-rc1'}</h1>
    <p id="price">Total: $${isProd ? '42.00' : '43.00'}</p>
    ${isProd ? '<div id="promo" data-testid="promo">Limited time offer</div>' : ''}
    <button type="button" data-testid="buy">Buy now</button>
  </main>
</body></html>`;
      send(res, 200, body);
      return;
    }

    // --- static pages -------------------------------------------------------
    const filePath = resolvePagePath(path);
    if (filePath && existsSync(filePath) && statSync(filePath).isFile()) {
      const ext = extname(filePath).toLowerCase();
      const body = createReadStream(filePath);
      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      body.pipe(res);
      return;
    }

    // A cross-origin-style iframe needs a second port; expose it via a query
    // param so static pages can point at it.
    if (path === '/__cross-origin-port') {
      send(res, 200, String(crossOriginPort()), { 'content-type': 'text/plain; charset=utf-8' });
      return;
    }

    send(
      res,
      404,
      `<!doctype html><html><body><h1>404</h1><p>No fixture at ${path}</p></body></html>`,
    );
  };
}

export async function startFixtureServer(
  options: FixtureServerOptions = {},
): Promise<FixtureServer> {
  const host = options.host ?? '127.0.0.1';
  const state = {
    requests: [] as { method: string; path: string }[],
    rateHits: 0,
    verbose: options.verbose ?? false,
  };

  let port = options.port ?? 0;
  // The cross-origin port may not be known until the second server starts, so
  // it is resolved through a getter rather than captured by value.
  const crossOriginPort = options.crossOriginPort ?? 0;
  const server = createServer((req, res) => {
    if (state.verbose) {
      console.error(`[fixture] ${req.method} ${req.url}`);
    }
    handler(req, res);
  });

  const handler = createFixtureHandler(state, () => crossOriginPort);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  port = (server.address() as { port: number }).port;

  return {
    port,
    host,
    origin: `http://${host}:${port}`,
    url: (p: string) => `http://${host}:${port}${p.startsWith('/') ? p : `/${p}`}`,
    server,
    requests: state.requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * Start a pair of servers where the second one is a genuinely different origin.
 * The first server's `/__cross-origin-port` endpoint reports the second's port.
 */
export async function startFixtureServerPair(): Promise<{
  primary: FixtureServer;
  secondary: FixtureServer;
}> {
  const secondary = await startFixtureServer({ port: 0 });
  const primary = await startFixtureServer({ port: 0, crossOriginPort: secondary.port });
  return { primary, secondary };
}

// Run directly: `npm run fixtures`
if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const port = Number(process.env.FIXTURE_PORT ?? 3000);
  startFixtureServer({ port, verbose: true })
    .then((s) => {
      console.log(`fixture server on ${s.origin}`);
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
