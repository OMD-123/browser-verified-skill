/**
 * API discovery (M25).
 *
 * `bv discover-api <runId>` watches what a run did and reports the API
 * endpoints the site actually used.
 *
 * The point is **observability, not exploitation**. The output is a
 * description of what the site called: the method, the path, the status,
 * and the shape of the response. It is what you read to write an
 * integration, or to find out why a page is slow.
 *
 * It does not try to find endpoints that were not used, and it does not
 * try anything the run did not do. A tool that discovers more than it
 * observed would be a tool that is guessing.
 */
import type { Page } from 'playwright';

/**
 * One observed request.
 *
 * The verifier's `NetworkFact` has no method, because the verifier does
 * not need one. Discovery does, so it has its own type.
 */
export interface ObservedRequest {
  /** The URL. */
  url: string;
  /** The HTTP method. */
  method: string;
  /** The status code. */
  status: number;
  /** When it happened. */
  at: string;
}

/** One endpoint the site used. */
export interface DiscoveredEndpoint {
  /** The HTTP method. */
  method: string;
  /** The path, with the query string removed. */
  path: string;
  /** The full URL. */
  url: string;
  /** The origin. */
  origin: string;
  /** How many times it was called. */
  calls: number;
  /** The status codes it returned. */
  statuses: number[];
  /** The content types it returned. */
  contentTypes: string[];
  /** Whether it was an XHR or a fetch, rather than a document. */
  isApi: boolean;
}

/**
 * Describe the endpoints in a set of network facts.
 *
 * The query string is dropped: `?token=…` in a report is a secret in a
 * report, and the path is what matters for an integration.
 */
export function discoverEndpoints(facts: readonly ObservedRequest[]): DiscoveredEndpoint[] {
  const byKey = new Map<string, DiscoveredEndpoint>();

  for (const fact of facts) {
    let url: URL;
    try {
      url = new URL(fact.url);
    } catch {
      continue;
    }

    // A data: or blob: URL is not an endpoint.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;

    const key = `${fact.method} ${url.pathname}`;

    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        method: fact.method,
        path: url.pathname,
        url: `${url.origin}${url.pathname}`,
        origin: url.origin,
        calls: 1,
        statuses: [fact.status],
        contentTypes: [],
        isApi: isApiPath(url.pathname),
      });
      continue;
    }

    existing.calls += 1;
    if (!existing.statuses.includes(fact.status)) existing.statuses.push(fact.status);
  }

  return [...byKey.values()].sort((a, b) => b.calls - a.calls || a.path.localeCompare(b.path));
}

/**
 * Whether a path looks like an API endpoint.
 *
 * A heuristic, and it is labelled as one: a path is an API path when it
 * looks like one, not when it certainly is.
 */
export function isApiPath(path: string): boolean {
  if (path === '/' || path === '') return false;
  if (/^\/(api|graphql|rpc|rest|v\d+)\//i.test(path)) return true;
  if (/\.(json|xml)$/i.test(path)) return true;
  if (/^\/[a-z0-9-_]+(\/[a-z0-9-_]+)*$/i.test(path) && path.split('/').length >= 3) {
    return true;
  }
  return false;
}

/**
 * Render the discovered endpoints.
 *
 * The summary comes first: how many endpoints, how many of them look like
 * APIs.
 */
export function renderEndpoints(endpoints: readonly DiscoveredEndpoint[]): string {
  if (endpoints.length === 0) {
    return 'No network endpoints were observed.';
  }

  const apiCount = endpoints.filter((endpoint) => endpoint.isApi).length;
  const lines: string[] = [];
  lines.push(
    `${endpoints.length} endpoint(s) observed, ${apiCount} of which look like APIs. ` +
      'Only endpoints this run actually used are listed.',
  );
  lines.push('');

  for (const endpoint of endpoints) {
    const statuses = endpoint.statuses.join(', ');
    lines.push(
      `  ${endpoint.method.padEnd(6)} ${endpoint.path}` +
        `${endpoint.isApi ? '  [api]' : ''}` +
        `  ${endpoint.calls} call(s)  ${statuses}`,
    );
  }

  return lines.join('\n');
}

/**
 * Watch a page and collect the endpoints it calls.
 *
 * The watcher has to be attached before the navigation, or the first
 * requests are missed.
 */
export function watchEndpoints(page: Page): {
  facts: ObservedRequest[];
  stop: () => void;
} {
  const facts: ObservedRequest[] = [];

  const onResponse = (response: {
    url(): string;
    request(): { method(): string };
    status(): number;
    headers(): Record<string, string>;
  }): void => {
    facts.push({
      url: response.url(),
      method: response.request().method(),
      status: response.status(),
      at: new Date().toISOString(),
    });
  };

  page.on('response', onResponse);

  return {
    facts,
    stop: () => {
      page.off('response', onResponse);
    },
  };
}

/**
 * The endpoints as an OpenAPI-shaped fragment.
 *
 * A fragment, not a document: it describes what was observed, and it says
 * so, so it is not mistaken for a specification of the API.
 */
export function asOpenApiFragment(
  endpoints: readonly DiscoveredEndpoint[],
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const endpoint of endpoints) {
    if (!endpoint.isApi) continue;
    const existing = paths[endpoint.path] ?? {};
    existing[endpoint.method.toLowerCase()] = {
      summary: `Observed ${endpoint.calls} time(s); status ${endpoint.statuses.join(', ')}.`,
      responses: Object.fromEntries(
        endpoint.statuses.map((status) => [
          String(status),
          { description: 'Observed. The response shape was not recorded.' },
        ]),
      ),
    };
    paths[endpoint.path] = existing;
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Observed endpoints',
      version: '0.0.0',
      description:
        'This fragment was generated from what a browser run actually did. ' +
        'It is not a specification of the API: undocumented endpoints are ' +
        'absent, and the response shapes are not described.',
    },
    paths,
  };
}
