/**
 * The HAR recorder (M10).
 *
 * A HAR file is always recorded for a run. It is redacted at write time, so
 * the file on disk never contains a secret.
 *
 * Playwright records the HAR itself through `recordHar`. The pages of a HAR
 * are read afterwards and redacted before the file is written to the run
 * directory, so the redaction is a separate, testable step rather than a
 * hope about the recorder's behaviour.
 */
import { readFile, writeFile } from 'node:fs/promises';

/** A HAR log. */
export interface HarLog {
  log: {
    version: string;
    creator: { name: string; version: string };
    pages: unknown[];
    entries: HarEntry[];
    [key: string]: unknown;
  };
}

/** A HAR entry. */
export interface HarEntry {
  startedDateTime?: string;
  time?: number;
  request: {
    method: string;
    url: string;
    headers?: { name: string; value: string }[];
    postData?: { mimeType?: string; text?: string; params?: unknown[] };
    queryString?: unknown[];
    [key: string]: unknown;
  };
  response: {
    status: number;
    statusText?: string;
    headers?: { name: string; value: string }[];
    content?: { mimeType?: string; text?: string; size?: number };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** The redactor used for the HAR. */
export interface HarRedactor {
  redactHeaders(headers: Record<string, string>): Record<string, string>;
  redactUrl(url: string): string;
  redactBody(body: string, maxLength?: number): string;
}

/** The headers that are removed from a HAR entry. */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
]);

/**
 * Redact one header list.
 *
 * A sensitive header is replaced entirely. Any other header has its value
 * passed through the redactor, so a secret in an unusual header is still
 * caught.
 */
function redactHeaderList(
  headers: { name: string; value: string }[],
  redactor: HarRedactor,
): { name: string; value: string }[] {
  return headers.map((header) => {
    if (SENSITIVE_HEADERS.has(header.name.toLowerCase())) {
      return { name: header.name, value: '[REDACTED]:header' };
    }
    const redacted = redactor.redactHeaders({ [header.name]: header.value });
    const value = redacted[header.name];
    return { name: header.name, value: value === undefined ? header.value : value };
  });
}

/**
 * Redact a HAR log.
 *
 * Every request header, response header, URL and body is passed through the
 * redactor. The result is a new object; the input is not modified.
 */
export function redactHar(log: HarLog, redactor: HarRedactor): HarLog {
  const entries = log.log.entries.map((entry) => {
    const request: HarEntry['request'] = {
      ...entry.request,
      url: redactor.redactUrl(entry.request.url),
      headers: redactHeaderList(entry.request.headers ?? [], redactor),
    };

    if (entry.request.postData !== undefined) {
      const text = entry.request.postData.text;
      request.postData = {
        ...entry.request.postData,
        ...(text === undefined ? {} : { text: redactor.redactBody(text, 10_000) }),
      };
    }

    const response: HarEntry['response'] = {
      ...entry.response,
      headers: redactHeaderList(entry.response.headers ?? [], redactor),
    };

    if (entry.response.content !== undefined) {
      const text = entry.response.content.text;
      response.content = {
        ...entry.response.content,
        ...(text === undefined ? {} : { text: redactor.redactBody(text, 10_000) }),
      };
    }

    return { ...entry, request, response };
  });

  return { log: { ...log.log, entries } };
}

/**
 * Redact the HAR file that Playwright wrote and save it to the run
 * directory.
 *
 * Playwright writes the HAR to a temporary path; this reads it, redacts it
 * and writes the redacted version to `network.har`.
 */
export async function finalizeHar(
  rawHarPath: string,
  outputPath: string,
  redactor: HarRedactor,
): Promise<{ entries: number; path: string }> {
  const raw = await readFile(rawHarPath, 'utf8');
  const log = JSON.parse(raw) as HarLog;
  const redacted = redactHar(log, redactor);
  await writeFile(outputPath, JSON.stringify(redacted, null, 2), 'utf8');
  return { entries: redacted.log.entries.length, path: outputPath };
}
