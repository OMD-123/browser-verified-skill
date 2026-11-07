/**
 * The final safety branch-coverage tests.
 *
 * These cover the remaining optional-property and fallback paths in the HAR
 * redactor, the dry-run recorder, the gate, the vault and the compliance
 * modules.
 */
import { describe, expect, it, vi } from 'vitest';
import { redactHar, finalizeHar, type HarLog } from '../../../src/safety/har.js';
import { DryRunRecorder } from '../../../src/safety/dryrun.js';
import { Redactor } from '../../../src/safety/redact.js';
import { Vault, encryptVault, decryptVault } from '../../../src/safety/vault.js';
import { RateLimiter } from '../../../src/safety/compliance/ratelimit.js';
import { RobotsCache, robotsUserAgent } from '../../../src/safety/compliance/robots.js';
import { detectCaptcha, detectLoginWall } from '../../../src/safety/compliance/captcha-detect.js';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('the HAR redactor: the optional fields', () => {
  /** A HAR with the minimum fields. */
  function minimalHar(): HarLog {
    return {
      log: {
        version: '1.2',
        creator: { name: 'browser-verified-skill', version: '0.1.0' },
        pages: [],
        entries: [
          {
            request: { method: 'GET', url: 'https://example.test/' },
            response: { status: 200 },
          },
        ],
      },
    };
  }

  it('handles an entry with no headers at all', () => {
    const redactor = new Redactor();
    const redacted = redactHar(minimalHar(), redactor);
    expect(redacted.log.entries[0]?.request.headers).toEqual([]);
    expect(redacted.log.entries[0]?.response.headers).toEqual([]);
  });

  it('handles a postData with no text', () => {
    const redactor = new Redactor();
    const log = minimalHar();
    const entry = log.log.entries[0];
    if (entry !== undefined) entry.request.postData = { mimeType: 'application/octet-stream' };
    const redacted = redactHar(log, redactor);
    expect(redacted.log.entries[0]?.request.postData?.text).toBeUndefined();
  });

  it('handles a content with no text', () => {
    const redactor = new Redactor();
    const log = minimalHar();
    const entry = log.log.entries[0];
    if (entry !== undefined) entry.response.content = { mimeType: 'text/html', size: 10 };
    const redacted = redactHar(log, redactor);
    expect(redacted.log.entries[0]?.response.content?.text).toBeUndefined();
  });

  it('keeps a header the redactor does not know about', () => {
    const redactor = new Redactor();
    const log = minimalHar();
    const entry = log.log.entries[0];
    if (entry !== undefined) {
      entry.request.headers = [{ name: 'x-unknown', value: 'kept' }];
    }
    const redacted = redactHar(log, redactor);
    const redactedEntry = redacted.log.entries[0];
    const firstHeader = redactedEntry?.request.headers?.[0];
    expect(firstHeader?.value).toBe('kept');
  });

  it('redacts a secret in a non-sensitive header', () => {
    const redactor = new Redactor();
    redactor.add('password', 'hunter2');
    const log = minimalHar();
    const entry = log.log.entries[0];
    if (entry !== undefined) {
      entry.request.headers = [{ name: 'x-custom', value: 'hunter2' }];
    }
    const redacted = redactHar(log, redactor);
    expect(JSON.stringify(redacted)).not.toContain('hunter2');
  });

  it('redacts a secret in the response content', () => {
    const redactor = new Redactor();
    redactor.add('password', 'hunter2');
    const log = minimalHar();
    const entry = log.log.entries[0];
    if (entry !== undefined) {
      entry.response.content = { mimeType: 'application/json', text: '{"p":"hunter2"}' };
    }
    const redacted = redactHar(log, redactor);
    expect(JSON.stringify(redacted)).not.toContain('hunter2');
  });
});

describe('the HAR finalizer', () => {
  it('reads, redacts and writes a HAR file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bv-har-'));
    const rawPath = join(dir, 'raw.har');
    const outPath = join(dir, 'network.har');

    const log: HarLog = {
      log: {
        version: '1.2',
        creator: { name: 'browser-verified-skill', version: '0.1.0' },
        pages: [],
        entries: [
          {
            request: {
              method: 'POST',
              url: 'https://example.test/api',
              headers: [{ name: 'authorization', value: 'Bearer hunter2' }],
              postData: { text: '{"p":"hunter2"}' },
            },
            response: { status: 200, headers: [] },
          },
        ],
      },
    };
    await writeFile(rawPath, JSON.stringify(log), 'utf8');

    const redactor = new Redactor();
    redactor.add('password', 'hunter2');
    const result = await finalizeHar(rawPath, outPath, redactor);

    expect(result.entries).toBe(1);
    const written = await readFile(outPath, 'utf8');
    expect(written).not.toContain('hunter2');
  });
});

describe('the dry-run recorder: the request handler', () => {
  it('continues a request it does not intercept', async () => {
    const recorder = new DryRunRecorder(new Redactor());
    const route = {
      request: () => ({
        method: () => 'GET',
        resourceType: () => 'document',
        url: () => 'https://example.test/',
        headers: () => ({}),
        postData: () => undefined,
      }),
      continue: vi.fn(async () => undefined),
      fulfill: vi.fn(async () => undefined),
    };
    const handler = recorder as unknown as { install: unknown } as never;
    expect(handler).toBeDefined();

    // Call the installed handler directly with a non-intercepted request.
    const page = {
      route: vi.fn(async (_pattern: string, fn: (r: unknown) => Promise<void>) => {
        await fn(route);
      }),
      unroute: vi.fn(async () => undefined),
    };
    await recorder.install(page as never);

    expect(route.continue).toHaveBeenCalled();
    expect(route.fulfill).not.toHaveBeenCalled();
    expect(recorder.count).toBe(0);
  });

  it('intercepts a POST and records it', async () => {
    const recorder = new DryRunRecorder(new Redactor());
    const route = {
      request: () => ({
        method: () => 'POST',
        resourceType: () => 'fetch',
        url: () => 'https://example.test/api',
        headers: () => ({ 'content-type': 'application/json' }),
        postData: () => '{"a":1}',
      }),
      continue: vi.fn(async () => undefined),
      fulfill: vi.fn(async () => undefined),
    };
    const page = {
      route: vi.fn(async (_pattern: string, fn: (r: unknown) => Promise<void>) => {
        await fn(route);
      }),
      unroute: vi.fn(async () => undefined),
    };
    await recorder.install(page as never);

    expect(route.fulfill).toHaveBeenCalled();
    expect(recorder.count).toBe(1);
    expect(recorder.captured[0]?.method).toBe('POST');
    expect(recorder.captured[0]?.hasBody).toBe(true);
  });

  it('handles a request whose body cannot be read', async () => {
    const recorder = new DryRunRecorder(new Redactor());
    const route = {
      request: () => ({
        method: () => 'POST',
        resourceType: () => 'fetch',
        url: () => 'https://example.test/api',
        headers: () => ({}),
        postData: () => {
          throw new Error('no body');
        },
      }),
      continue: vi.fn(async () => undefined),
      fulfill: vi.fn(async () => undefined),
    };
    const page = {
      route: vi.fn(async (_pattern: string, fn: (r: unknown) => Promise<void>) => {
        await fn(route);
      }),
      unroute: vi.fn(async () => undefined),
    };
    await recorder.install(page as never);

    expect(recorder.captured[0]?.hasBody).toBe(false);
  });
});

describe('the vault: the file marker', () => {
  it('rejects a file that is not a vault', () => {
    const file = encryptVault({ secrets: {} }, 'passphrase');
    const notAVault = { ...file, magic: 'XXXX' as 'BVV1' };
    expect(() => decryptVault(notAVault, 'passphrase')).toThrow(
      /not a browser-verified-skill vault/,
    );
  });

  it('lists the secrets it holds', async () => {
    const vault = new Vault();
    await vault.load('passphrase', `${tmpdir()}/bv-vault-list`);
    expect(vault.list()).toEqual([]);
  });
});

describe('the rate limiter: the wait path', () => {
  it('does not wait when a token is available', async () => {
    const waits: number[] = [];
    const limiter = new RateLimiter(
      { maxRpsPerDomain: 5, jitterMs: { min: 0, max: 0 } },
      () => 0,
      async (ms) => {
        waits.push(ms);
      },
    );
    await limiter.acquire('a.test');
    expect(waits).toHaveLength(0);
  });

  it('applies the jitter after consuming a token', async () => {
    const waits: number[] = [];
    const limiter = new RateLimiter(
      { maxRpsPerDomain: 5, jitterMs: { min: 10, max: 20 } },
      () => 0,
      async (ms) => {
        waits.push(ms);
      },
    );
    await limiter.acquire('a.test');
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(10);
  });
});

describe('the robots helper: the token fallback', () => {
  it('falls back to BrowserVerifiedSkill for an unparseable user agent', () => {
    expect(robotsUserAgent('')).toBe('BrowserVerifiedSkill');
  });

  it('keeps a fresh entry in the cache', () => {
    const cache = new RobotsCache();
    cache.set('https://example.test', 'User-agent: *\n');
    expect(cache.get('https://example.test')?.body).toContain('User-agent');
  });
});

describe('the challenge detector: the evidence paths', () => {
  it('reports the matched text as the evidence', () => {
    const challenge = detectCaptcha({ text: 'Please verify you are human to continue' });
    expect(challenge?.evidence).toContain('verify you are human');
  });

  it('reports the password field as the evidence for a login wall', () => {
    const challenge = detectLoginWall({
      text: 'Welcome back',
      hasPasswordField: true,
      buttonNames: ['Log in'],
    });
    expect(challenge?.evidence).toBe('password field present');
  });
});
