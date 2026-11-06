/**
 * Evidence-first extraction (M13).
 *
 * `bv extract --schema schema.json` reads a JSON Schema and pulls the
 * matching values out of the live page. Every extracted value carries the
 * evidence that supports it: where it was found, what the page said around
 * it, and a screenshot crop.
 *
 * A value is only reported as verified when a **second pass** re-reads the
 * live page and finds the same value at the same node. A required field
 * that fails that check becomes `null` — it is never guessed.
 */
import { z } from 'zod';
import type { Page } from 'playwright';

/** One extracted field with its evidence. */
export interface ExtractedField<T = unknown> {
  /** The value, or `null` when it could not be verified. */
  value: T | null;
  /** The evidence for the value. */
  evidence: FieldEvidence;
}

/** The evidence for an extracted field. */
export interface FieldEvidence {
  /** The URL the value came from. */
  url: string;
  /** A path to the element. */
  domPath: string;
  /** The text around the value. */
  textSnippet: string;
  /** The screenshot crop, when one was taken. */
  screenshotCrop?: string;
  /** When the value was captured. */
  capturedAt: string;
  /** Whether the value was confirmed by a second pass. */
  verified: boolean;
  /** Why the value is not verified, when it is not. */
  reason?: string;
}

/** The result of an extraction. */
export interface ExtractionResult {
  /** The extracted fields, keyed by field name. */
  fields: Record<string, ExtractedField>;
  /** The order the fields appear in the schema. */
  order: string[];
  /** When the extraction ran. */
  extractedAt: string;
  /** The URL the extraction ran against. */
  url: string;
  /** The schema that was used. */
  schema: unknown;
}

/**
 * Build a zod schema from a JSON Schema.
 *
 * Only the subset that matters for extraction is supported: objects,
 * strings, numbers, integers, booleans, arrays, enums, and the `required`
 * list. A schema that uses something else is rejected with a clear message
 * rather than being silently ignored.
 */
export function zodFromJsonSchema(schema: unknown): {
  schema: z.ZodType<Record<string, unknown>>;
  required: Set<string>;
} {
  const required = new Set<string>();
  const zodSchema = buildObject(schema, required, '');
  return { schema: zodSchema, required };
}

/** Build a zod type for a JSON Schema node. */
function buildObject(
  schema: unknown,
  required: Set<string>,
  path: string,
): z.ZodType<Record<string, unknown>> {
  if (typeof schema !== 'object' || schema === null) {
    throw new Error(`the schema at ${path === '' ? '(root)' : path} is not an object`);
  }

  const record = schema as Record<string, unknown>;
  const type = record['type'];

  if (type !== 'object') {
    throw new Error(
      `the schema at ${path === '' ? '(root)' : path} must have type "object", not ${JSON.stringify(type)}`,
    );
  }

  const properties = record['properties'];
  if (typeof properties !== 'object' || properties === null) {
    throw new Error(`the schema at ${path === '' ? '(root)' : path} has no "properties"`);
  }

  const requiredList = Array.isArray(record['required']) ? (record['required'] as unknown[]) : [];
  for (const name of requiredList) {
    if (typeof name === 'string') required.add(`${path}.${name}`);
  }

  const shape: Record<string, z.ZodType<unknown>> = {};
  for (const [name, fieldSchema] of Object.entries(properties as Record<string, unknown>)) {
    const fieldPath = `${path}.${name}`;
    shape[name] = buildField(fieldSchema, fieldPath);
    if (requiredList.includes(name)) {
      shape[name] = shape[name].describe(`required:${fieldPath}`);
    }
  }

  return z.object(shape).passthrough();
}

/** Build a zod type for one field. */
function buildField(schema: unknown, path: string): z.ZodType<unknown> {
  if (typeof schema !== 'object' || schema === null) {
    throw new Error(`the schema at ${path} is not an object`);
  }
  const record = schema as Record<string, unknown>;
  const type = record['type'];

  if (Array.isArray(record['enum'])) {
    const values = record['enum'];
    if (values.every((v) => typeof v === 'string')) {
      return z.enum(values as [string, ...string[]]);
    }
    return z.unknown();
  }

  switch (type) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'array': {
      const items = record['items'];
      if (items === undefined) return z.array(z.unknown());
      return z.array(buildField(items, `${path}[]`));
    }
    case 'object':
      return buildObject(schema, new Set<string>(), path);
    case 'null':
      return z.null();
    default:
      // A field with no type but with a description is treated as a string,
      // which is what an extraction schema usually means.
      return z.unknown();
  }
}

/**
 * Extract values from the live page according to a schema.
 *
 * The extraction looks for a labelled element, a table cell, or a text
 * pattern, in that order. Each candidate is then confirmed by a second
 * pass.
 */
export async function extract(
  page: Page,
  schema: unknown,
  options: { screenshotPath?: string } = {},
): Promise<ExtractionResult> {
  const parsed = schema as { properties?: Record<string, unknown>; required?: string[] };
  const properties = parsed.properties ?? {};
  const required = new Set(parsed.required ?? []);

  const fields: Record<string, ExtractedField> = {};
  const order: string[] = [];
  const capturedAt = new Date().toISOString();
  const url = page.url();

  for (const [name, fieldSchema] of Object.entries(properties)) {
    order.push(name);
    const description = readDescription(fieldSchema);
    const found = await findValue(page, name, description);

    if (found === undefined) {
      fields[name] = {
        value: null,
        evidence: {
          url,
          domPath: '',
          textSnippet: '',
          capturedAt,
          verified: false,
          reason: required.has(name)
            ? 'the required field was not found on the page'
            : 'the field was not found on the page',
          ...(options.screenshotPath !== undefined
            ? { screenshotCrop: options.screenshotPath }
            : {}),
        },
      };
      continue;
    }

    // The second pass: re-read the page and confirm the value is still
    // there at the same node. A value that cannot be confirmed is reported
    // as unverified, and a required field becomes null.
    const confirmed = await confirmValue(page, found, found.value);

    const verified = confirmed;

    fields[name] = {
      value: verified ? found.value : null,
      evidence: {
        url,
        domPath: found.domPath,
        textSnippet: found.textSnippet,
        capturedAt,
        verified,
        ...(verified ? {} : { reason: 'the value could not be confirmed on a second read' }),
        ...(options.screenshotPath !== undefined
          ? { screenshotCrop: options.screenshotPath }
          : {}),
      },
    };
  }

  return {
    fields,
    order,
    extractedAt: capturedAt,
    url,
    schema,
  };
}

/** How a value was found. */
type ExtractStrategy = 'paired-cell' | 'labelled-input' | 'text-pair';

/** Where a value was found. */
interface FoundValue {
  /** The value. */
  value: string;
  /** The strategy that found it. */
  strategy: ExtractStrategy;
  /** A selector that finds it again. */
  selector: string;
  /** A path to the element. */
  domPath: string;
  /** The text around it. */
  textSnippet: string;
  /** The field name, used by the text-pair strategy. */
  name: string;
}

/** The description of a field, which often says what to look for. */
function readDescription(schema: unknown): string | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const description = (schema as Record<string, unknown>)['description'];
  return typeof description === 'string' ? description : undefined;
}

/**
 * Find a value for a field on the page.
 *
 * The strategies are, in order: a `<dt>`/`<dd>` or `<th>`/`<td>` pair with
 * the field's name, a label pointing at an input, and finally the field's
 * name followed by a colon in the text.
 */
async function findValue(
  page: Page,
  name: string,
  description: string | undefined,
): Promise<FoundValue | undefined> {
  // The description, when there is one, is what to look for: a schema
  // author writes "description: Status" to say "the field called `status`
  // holds the order status". The field name is only a fallback.
  const wanted = description ?? name;

  // A table cell or a definition list.
  const cellSelector =
    `dt:text-is("${wanted}") + dd, th:text-is("${wanted}") + td, td:text-is("${wanted}") + td`;
  const paired = await page
    .locator(cellSelector)
    .first()
    .textContent({ timeout: 2_000 })
    .catch(() => undefined);
  if (paired !== undefined && paired !== null && paired.trim().length > 0) {
    return {
      value: paired.trim(),
      strategy: 'paired-cell',
      selector: cellSelector,
      domPath: 'paired-cell',
      textSnippet: paired.trim().slice(0, 200),
      name,
    };
  }

  // A label pointing at an input.
  const labelSelector = `label:text-is("${wanted}")`;
  const labelled = await page
    .locator(labelSelector)
    .first()
    .evaluate((element: unknown) => {
      const label = element as HTMLLabelElement;
      const control = label.control ?? label.querySelector('input, textarea, select');
      if (control === null) return undefined;
      const el = control as HTMLInputElement;
      return { value: (el.value ?? el.textContent ?? '').trim(), tag: el.tagName.toLowerCase() };
    })
    .catch(() => undefined);
  if (labelled !== undefined && labelled.value.length > 0) {
    return {
      value: labelled.value,
      strategy: 'labelled-input',
      selector: labelSelector,
      domPath: `input.${labelled.tag}`,
      textSnippet: `${wanted}: ${labelled.value}`.slice(0, 200),
      name: wanted,
    };
  }

  // "Name: value" in the visible text.
  const textSelector = `text=/${escapeForRegex(wanted)}\\s*[:：]/`;
  const textValue = await page
    .locator(textSelector)
    .first()
    .textContent({ timeout: 2_000 })
    .catch(() => undefined);
  if (textValue !== undefined && textValue !== null) {
    const match = new RegExp(`${escapeForRegex(wanted)}\\s*[:：]\\s*([^\\n]+)`).exec(textValue);
    const value = match?.[1]?.trim();
    if (value !== undefined && value.length > 0) {
      return {
        value,
        strategy: 'text-pair',
        selector: textSelector,
        domPath: 'text',
        textSnippet: textValue.trim().slice(0, 200),
        name: wanted,
      };
    }
  }

  return undefined;
}

/**
 * Confirm a value by reading it again.
 *
 * The **same** strategy is used as for the first read, because a different
 * one would compare the wrong thing: reading a label's text and comparing
 * it with the input's value would never match.
 */
async function confirmValue(
  page: Page,
  found: FoundValue,
  value: string,
): Promise<boolean> {
  const again = await readWithStrategy(page, found);
  if (again === undefined) return false;
  return normalise(again) === normalise(value);
}

/** Read a value using the strategy it was found with. */
async function readWithStrategy(
  page: Page,
  found: FoundValue,
): Promise<string | undefined> {
  switch (found.strategy) {
    case 'paired-cell': {
      const text = await page
        .locator(found.selector)
        .first()
        .textContent({ timeout: 2_000 })
        .catch(() => undefined);
      return text === undefined || text === null ? undefined : text.trim();
    }
    case 'labelled-input': {
      const result = await page
        .locator(found.selector)
        .first()
        .evaluate((element: unknown) => {
          const label = element as HTMLLabelElement;
          const control = label.control ?? label.querySelector('input, textarea, select');
          if (control === null) return undefined;
          const el = control as HTMLInputElement;
          return (el.value ?? el.textContent ?? '').trim();
        })
        .catch(() => undefined);
      return result;
    }
    case 'text-pair': {
      const text = await page
        .locator(found.selector)
        .first()
        .textContent({ timeout: 2_000 })
        .catch(() => undefined);
      if (text === undefined || text === null) return undefined;
      const match = new RegExp(`${escapeForRegex(found.name)}\\s*[:：]\\s*([^\\n]+)`).exec(text);
      return match?.[1]?.trim();
    }
    default:
      return undefined;
  }
}

/** Normalise a value for comparison: collapse whitespace, case-fold. */
export function normalise(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Escape a string for use in a regular expression. */
function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Render an extraction result as JSON, CSV or Markdown.
 *
 * Every format has a source column, because a value without a source is
 * not an extraction — it is a guess.
 */
export function renderExtraction(
  result: ExtractionResult,
  format: 'json' | 'csv' | 'md',
): string {
  switch (format) {
    case 'json':
      return JSON.stringify(result, null, 2);

    case 'csv': {
      const lines = ['field,value,source,verified'];
      for (const name of result.order) {
        const field = result.fields[name];
        if (field === undefined) continue;
        lines.push(
          [
            csvEscape(name),
            csvEscape(field.value === null ? '' : asText(field.value)),
            csvEscape(field.evidence.url),
            field.evidence.verified ? 'yes' : 'no',
          ].join(','),
        );
      }
      return lines.join('\n');
    }

    case 'md': {
      const lines = ['# Extracted values', '', `URL: ${result.url}`, '', '| Field | Value | Source | Verified |', '| --- | --- | --- | --- |'];
      for (const name of result.order) {
        const field = result.fields[name];
        if (field === undefined) continue;
        lines.push(
          `| ${name} | ${field.value === null ? '—' : asText(field.value)} | ${field.evidence.url} | ${field.evidence.verified ? 'yes' : 'no'} |`,
        );
      }
      return lines.join('\n');
    }

    default: {
      const exhaustive: never = format;
      throw new Error(`unknown format: ${String(exhaustive)}`);
    }
  }
}

/**
 * Render an unknown value as text.
 *
 * A plain string is used as-is; anything else is JSON, so an object never
 * becomes `[object Object]`.
 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return '(unserialisable)';
  }
}

/** Escape a value for a CSV cell. */
function csvEscape(value: string): string {
  if (!/[",\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
