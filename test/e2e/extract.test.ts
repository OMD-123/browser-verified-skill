/**
 * Tests for the evidence-first extraction (M13).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchChromium } from '../../src/core/browser.js';
import {
  extract,
  renderExtraction,
  normalise,
  zodFromJsonSchema,
} from '../../src/verify/extract.js';

describe('the JSON Schema to zod conversion', () => {
  it('builds a schema from an object', () => {
    const { schema, required } = zodFromJsonSchema({
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'integer' } },
      required: ['name'],
    });
    expect(required.has('.name')).toBe(true);
    expect(schema.safeParse({ name: 'a', age: 1 }).success).toBe(true);
  });

  it('rejects a schema that is not an object', () => {
    expect(() => zodFromJsonSchema({ type: 'array' })).toThrow(/must have type "object"/);
  });

  it('rejects a schema with no properties', () => {
    expect(() => zodFromJsonSchema({ type: 'object' })).toThrow(/has no "properties"/);
  });

  it('rejects a schema that is not an object at all', () => {
    expect(() => zodFromJsonSchema('nope')).toThrow(/is not an object/);
  });

  it('builds an enum', () => {
    const { schema } = zodFromJsonSchema({
      type: 'object',
      properties: { status: { type: 'string', enum: ['open', 'closed'] } },
    });
    expect(schema.safeParse({ status: 'open' }).success).toBe(true);
    expect(schema.safeParse({ status: 'other' }).success).toBe(false);
  });

  it('builds a number, a boolean and an array', () => {
    const { schema } = zodFromJsonSchema({
      type: 'object',
      properties: {
        n: { type: 'number' },
        b: { type: 'boolean' },
        a: { type: 'array', items: { type: 'string' } },
      },
    });
    expect(schema.safeParse({ n: 1.5, b: true, a: ['x'] }).success).toBe(true);
    expect(schema.safeParse({ n: 'x' }).success).toBe(false);
  });

  it('builds a nested object', () => {
    const { schema } = zodFromJsonSchema({
      type: 'object',
      properties: {
        address: { type: 'object', properties: { city: { type: 'string' } } },
      },
    });
    expect(schema.safeParse({ address: { city: 'Nashik' } }).success).toBe(true);
  });

  it('treats a field with no type as unknown', () => {
    const { schema } = zodFromJsonSchema({
      type: 'object',
      properties: { anything: {} },
    });
    expect(schema.safeParse({ anything: 42 }).success).toBe(true);
  });

  it('treats a null type as null', () => {
    const { schema } = zodFromJsonSchema({
      type: 'object',
      properties: { nothing: { type: 'null' } },
    });
    expect(schema.safeParse({ nothing: null }).success).toBe(true);
  });
});

describe('the normaliser', () => {
  it('collapses whitespace', () => {
    expect(normalise('  a   b  ')).toBe('a b');
  });

  it('folds case', () => {
    expect(normalise('ABC')).toBe('abc');
  });
});

describe('the extractor', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchChromium();
    page = await browser.newPage();
    await page.setContent(`
      <html><body>
        <h1>Order #1234</h1>
        <dl>
          <dt>Status</dt><dd>Shipped</dd>
          <dt>Total</dt><dd>€42.50</dd>
        </dl>
        <label for="email">Email</label>
        <input id="email" value="buyer@example.test" readonly />
        <p>Reference: REF-98765</p>
      </body></html>
    `);
  });

  afterAll(async () => {
    await browser.close();
  });

  it('extracts a definition-list value', async () => {
    const result = await extract(page, {
      type: 'object',
      properties: { Status: { type: 'string' } },
      required: ['Status'],
    });
    expect(result.fields['Status']?.value).toBe('Shipped');
    expect(result.fields['Status']?.evidence.verified).toBe(true);
  });

  it('extracts a labelled input value', async () => {
    const result = await extract(page, {
      type: 'object',
      properties: { Email: { type: 'string' } },
    });
    expect(result.fields['Email']?.value).toBe('buyer@example.test');
  });

  it('extracts a "Name: value" pair from the text', async () => {
    const result = await extract(page, {
      type: 'object',
      properties: { Reference: { type: 'string' } },
    });
    expect(result.fields['Reference']?.value).toBe('REF-98765');
  });

  it('reports a field that is not there as null and unverified', async () => {
    const result = await extract(page, {
      type: 'object',
      properties: { Missing: { type: 'string' } },
      required: ['Missing'],
    });
    expect(result.fields['Missing']?.value).toBeNull();
    expect(result.fields['Missing']?.evidence.verified).toBe(false);
    expect(result.fields['Missing']?.evidence.reason).toContain('not found');
  });

  it('records the URL for every field', async () => {
    const result = await extract(page, {
      type: 'object',
      properties: { Status: { type: 'string' } },
    });
    expect(result.fields['Status']?.evidence.url).toBe(page.url());
  });

  it('records the field order', async () => {
    const result = await extract(page, {
      type: 'object',
      properties: { Status: { type: 'string' }, Total: { type: 'string' } },
    });
    expect(result.order).toEqual(['Status', 'Total']);
  });

  it('records the text snippet around the value', async () => {
    const result = await extract(page, {
      type: 'object',
      properties: { Status: { type: 'string' } },
    });
    expect(result.fields['Status']?.evidence.textSnippet).toContain('Shipped');
  });

  it('includes a screenshot crop when one is given', async () => {
    const result = await extract(
      page,
      { type: 'object', properties: { Status: { type: 'string' } } },
      { screenshotPath: '/tmp/shot.png' },
    );
    expect(result.fields['Status']?.evidence.screenshotCrop).toBe('/tmp/shot.png');
  });

  it('uses the description to look for the value', async () => {
    const result = await extract(page, {
      type: 'object',
      properties: {
        anything: { type: 'string', description: 'Status' },
      },
    });
    expect(result.fields['anything']?.value).toBe('Shipped');
  });

  it('records the schema it used', async () => {
    const schema = { type: 'object', properties: { Status: { type: 'string' } } };
    const result = await extract(page, schema);
    expect(result.schema).toBe(schema);
  });
});

describe('the extraction output formats', () => {
  /** A result to render. */
  function result() {
    return {
      fields: {
        Status: {
          value: 'Shipped',
          evidence: {
            url: 'http://x/',
            domPath: 'dd',
            textSnippet: 'Shipped',
            capturedAt: 'now',
            verified: true,
          },
        },
        Missing: {
          value: null,
          evidence: {
            url: 'http://x/',
            domPath: '',
            textSnippet: '',
            capturedAt: 'now',
            verified: false,
            reason: 'not found',
          },
        },
      },
      order: ['Status', 'Missing'],
      extractedAt: 'now',
      url: 'http://x/',
      schema: {},
    };
  }

  it('renders JSON', () => {
    const json = renderExtraction(result(), 'json');
    const parsed = JSON.parse(json) as { fields: Record<string, { value: unknown }> };
    expect(parsed.fields['Status']?.value).toBe('Shipped');
  });

  it('renders CSV with a source column', () => {
    const csv = renderExtraction(result(), 'csv');
    const lines = csv.split('\n');
    expect(lines[0]).toBe('field,value,source,verified');
    expect(lines[1]).toContain('http://x/');
    expect(lines[1]).toContain('yes');
  });

  it('renders an empty CSV cell for a null value', () => {
    const csv = renderExtraction(result(), 'csv');
    expect(csv).toContain('Missing,,http://x/,no');
  });

  it('renders Markdown with a source column', () => {
    const md = renderExtraction(result(), 'md');
    expect(md).toContain('| Field | Value | Source | Verified |');
    expect(md).toContain('http://x/');
  });

  it('shows an em dash for a null value in Markdown', () => {
    const md = renderExtraction(result(), 'md');
    expect(md).toContain('Missing | — |');
  });

  it('escapes a value that contains a comma', () => {
    const withComma = result();
    const status = withComma.fields['Status'];
    if (status === undefined) throw new Error('the fixture is missing the Status field');
    withComma.fields['Status'] = { ...status, value: 'a,b' };
    const csv = renderExtraction(withComma, 'csv');
    expect(csv).toContain('"a,b"');
  });
});
