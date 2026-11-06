/**
 * Secret redaction (M09).
 *
 * Redaction is applied **at each sink independently**, not only at the source:
 *
 *  1. the audit log,
 *  2. JSON output,
 *  3. human log output,
 *  4. screenshots (via Playwright's `mask` option),
 *  5. the HAR recorder,
 *  6. the trace archive (post-processed).
 *
 * Each is implemented separately; none relies on another. That is what makes
 * the "grep the run directory for the secret and find nothing" test
 * meaningful rather than a coincidence.
 */

/** The marker that replaces a redacted value. */
export const REDACTION_MARKER = '[REDACTED]';

/** A registered secret. */
export interface RegisteredSecret {
  /** The secret's name. */
  name: string;
  /** The literal value to mask. */
  value: string;
}

/**
 * The redaction registry.
 *
 * Holds the secret values that must never appear in an artifact.
 */
export class Redactor {
  private secrets: RegisteredSecret[] = [];

  /** Register a secret value to mask. */
  add(name: string, value: string): void {
    // Very short values would mask too much of ordinary text, so they are
    // not registered. A secret shorter than four characters is not a secret
    // worth protecting with substring matching.
    if (value.length < 4) return;
    if (this.secrets.some((s) => s.value === value)) return;
    this.secrets.push({ name, value });
  }

  /** Remove a secret from the registry. */
  remove(name: string): boolean {
    const before = this.secrets.length;
    this.secrets = this.secrets.filter((s) => s.name !== name);
    return this.secrets.length < before;
  }

  /** How many secrets are registered. */
  get size(): number {
    return this.secrets.length;
  }

  /** The registered secret names. */
  names(): string[] {
    return this.secrets.map((s) => s.name);
  }

  /**
   * Mask every registered secret in a string.
   *
   * Longer secrets are masked first, so a secret that contains another is
   * masked as a whole rather than in pieces.
   */
  redact(text: string): string {
    if (this.secrets.length === 0) return text;
    const ordered = [...this.secrets].sort((a, b) => b.value.length - a.value.length);
    let result = text;
    for (const secret of ordered) {
      result = result.replaceAll(secret.value, `${REDACTION_MARKER}:${secret.name}`);
    }
    return result;
  }

  /**
   * Mask a value that may itself be a secret.
   *
   * Used for a single field, where the whole value is replaced rather than
   * a substring of it.
   */
  redactValue(value: string): string {
    const match = this.secrets.find((s) => s.value === value);
    if (match === undefined) return this.redact(value);
    return `${REDACTION_MARKER}:${match.name}`;
  }

  /**
   * Mask the headers of a network request or response.
   *
   * Sensitive headers are removed entirely; the rest keep their names so
   * the artifact stays useful.
   */
  redactHeaders(headers: Record<string, string>): Record<string, string> {
    const sensitive = new Set([
      'authorization',
      'cookie',
      'set-cookie',
      'proxy-authorization',
      'x-api-key',
      'x-auth-token',
      'x-csrf-token',
    ]);
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (sensitive.has(name.toLowerCase())) {
        result[name] = `${REDACTION_MARKER}:header`;
        continue;
      }
      result[name] = this.redact(value);
    }
    return result;
  }

  /**
   * Mask a URL's query string.
   *
   * The path is kept (it is useful) but the query is replaced, because query
   * strings routinely carry tokens.
   */
  redactUrl(url: string): string {
    const queryStart = url.indexOf('?');
    if (queryStart === -1) return this.redact(url);
    const base = url.slice(0, queryStart);
    const query = url.slice(queryStart + 1);
    const redactedQuery = query
      .split('&')
      .map((part) => {
        const eq = part.indexOf('=');
        if (eq === -1) return part;
        const key = part.slice(0, eq);
        const value = part.slice(eq + 1);
        return `${key}=${this.redactValue(decodeURIComponent(value))}`;
      })
      .join('&');
    return `${this.redact(base)}?${redactedQuery}`;
  }

  /**
   * Mask a body preview.
   *
   * The body is truncated and every registered secret is masked.
   */
  redactBody(body: string, maxLength = 500): string {
    const masked = this.redact(body);
    return masked.length <= maxLength ? masked : `${masked.slice(0, maxLength)}…`;
  }
}

/**
 * Mask a secret that appears in an error message.
 *
 * Playwright's error strings echo the value it tried to fill, so every error
 * that crosses the CLI boundary is masked.
 */
export function redactError(error: unknown, redactor: Redactor): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactor.redact(message);
}

/**
 * Mask secrets in a JSON-serialisable value.
 *
 * Used for the `--json` output path.
 */
export function redactJson(value: unknown, redactor: Redactor): unknown {
  if (typeof value === 'string') return redactor.redact(value);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, redactor));
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = redactJson(item, redactor);
    }
    return result;
  }
  return value;
}
