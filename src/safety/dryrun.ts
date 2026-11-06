/**
 * The network dry-run (M10).
 *
 * With `--dry-run`, every state-changing request is intercepted with
 * `page.route()`, fulfilled with a synthetic 200, and recorded. Nothing is
 * sent to the server.
 *
 * The record shows exactly what **would** have been sent, with the headers
 * and body redacted.
 */
import type { Page, Route } from 'playwright';

/** A recorded request that was intercepted. */
export interface DryRunRecord {
  /** The HTTP method. */
  method: string;
  /** The URL. */
  url: string;
  /** The request headers, redacted. */
  headers: Record<string, string>;
  /** A preview of the request body. */
  bodyPreview: string;
  /** Whether the body was present at all. */
  hasBody: boolean;
  /** When the request was intercepted. */
  capturedAt: string;
  /** The resource type. */
  resourceType: string;
}

/** The methods that are intercepted in dry-run mode. */
export const INTERCEPTED_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * Decide whether a request should be intercepted.
 *
 * A request is intercepted when its method is state-changing, or when it is
 * a `fetch`/`xhr` that carries a body.
 */
export function shouldIntercept(method: string, hasBody: boolean, resourceType: string): boolean {
  const upper = method.toUpperCase();
  if (INTERCEPTED_METHODS.includes(upper)) return true;
  if (hasBody && (resourceType === 'fetch' || resourceType === 'xhr')) return true;
  return false;
}

/** The redactor used for the dry-run records. */
export interface DryRunRedactor {
  redactHeaders(headers: Record<string, string>): Record<string, string>;
  redactBody(body: string, maxLength?: number): string;
}

/** The dry-run recorder. */
export class DryRunRecorder {
  private records: DryRunRecord[] = [];

  constructor(private readonly redactor: DryRunRedactor) {}

  /** The recorded requests. */
  get captured(): readonly DryRunRecord[] {
    return this.records;
  }

  /** How many requests were recorded. */
  get count(): number {
    return this.records.length;
  }

  /** Forget every record. */
  clear(): void {
    this.records = [];
  }

  /**
   * Install the interception on a page.
   *
   * Returns a function that removes it.
   */
  async install(page: Page): Promise<() => Promise<void>> {
    const handler = async (route: Route): Promise<void> => {
      const request = route.request();
      const method = request.method();
      const resourceType = request.resourceType();
      let body: string | undefined;
      try {
        body = request.postData() ?? undefined;
      } catch {
        // Some request types have no accessible body.
        body = undefined;
      }

      if (!shouldIntercept(method, body !== undefined && body.length > 0, resourceType)) {
        await route.continue();
        return;
      }

      const headers = this.redactor.redactHeaders(request.headers());
      this.records.push({
        method: method.toUpperCase(),
        url: request.url(),
        headers,
        bodyPreview: body === undefined ? '' : this.redactor.redactBody(body),
        hasBody: body !== undefined && body.length > 0,
        capturedAt: new Date().toISOString(),
        resourceType,
      });

      // Fulfil with a synthetic response so the page continues as if the
      // request had succeeded, without anything reaching the server.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ intercepted: true, method: method.toUpperCase() }),
      });
    };

    await page.route('**/*', handler);
    return async () => {
      await page.unroute('**/*', handler);
    };
  }

  /** The records, ready to be written to `dryrun.json`. */
  toJSON(): { intercepted: number; requests: DryRunRecord[] } {
    return { intercepted: this.records.length, requests: [...this.records] };
  }
}

/**
 * Render the dry-run report for a human.
 *
 * This is what `bv dryrun-report` prints.
 */
export function renderDryRunReport(records: readonly DryRunRecord[]): string {
  if (records.length === 0) {
    return 'No state-changing requests were intercepted.\nNothing would have been sent.';
  }

  const lines: string[] = [`Would have sent ${records.length} request(s):`, ''];

  for (const record of records) {
    lines.push(`  ${record.method} ${record.url}`);
    const bodyKeys = Object.keys(record.headers).filter(
      (key) => !['accept', 'accept-language', 'user-agent', 'accept-encoding'].includes(key),
    );
    for (const key of bodyKeys) {
      // The key comes from `Object.keys`, so the value is always present.
      lines.push(`      ${key}: ${record.headers[key]}`);
    }
    if (record.hasBody) {
      lines.push(`      body: ${record.bodyPreview}`);
    }
    lines.push('');
  }

  lines.push('Nothing was sent to the server.');
  return lines.join('\n');
}
