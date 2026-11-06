/**
 * Tests for the secrets vault (M09) and the redaction sinks.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Vault,
  encryptVault,
  decryptVault,
  passphraseFromEnv,
  secretEquals,
} from '../../../src/safety/vault.js';
import { Redactor, redactError, redactJson, REDACTION_MARKER } from '../../../src/safety/redact.js';

describe('the vault', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bv-vault-'));
  });

  it('round-trips through encryption', () => {
    const contents = { secrets: { password: { value: 'hunter2', storedAt: 'now' } } };
    const file = encryptVault(contents, 'passphrase');
    const decrypted = decryptVault(file, 'passphrase');
    expect(decrypted.secrets['password']?.value).toBe('hunter2');
  });

  it('fails to decrypt with the wrong passphrase', () => {
    const file = encryptVault({ secrets: {} }, 'right');
    expect(() => decryptVault(file, 'wrong')).toThrow();
  });

  it('rejects an unsupported version', () => {
    expect(() =>
      decryptVault(
        {
          version: 2 as unknown as 1,
          magic: 'BVV1',
          salt: '',
          iv: '',
          tag: '',
          ciphertext: '',
        },
        'x',
      ),
    ).toThrow(/unsupported vault version/);
  });

  it('stores and reads a secret', async () => {
    const vault = new Vault();
    await vault.load('passphrase', dir);
    vault.set('password', 'hunter2');
    expect(vault.get('password')).toBe('hunter2');
  });

  it('returns undefined for an unknown secret', async () => {
    const vault = new Vault();
    await vault.load('passphrase', dir);
    expect(vault.get('nope')).toBeUndefined();
  });

  it('removes a secret', async () => {
    const vault = new Vault();
    await vault.load('passphrase', dir);
    vault.set('password', 'hunter2');
    expect(vault.remove('password')).toBe(true);
    expect(vault.remove('password')).toBe(false);
    expect(vault.get('password')).toBeUndefined();
  });

  it('lists the secret names', async () => {
    const vault = new Vault();
    await vault.load('passphrase', dir);
    vault.set('b', 'value-b');
    vault.set('a', 'value-a');
    expect(vault.list().map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('reports whether it is loaded', async () => {
    const vault = new Vault();
    expect(vault.isLoaded).toBe(false);
    await vault.load('passphrase', dir);
    expect(vault.isLoaded).toBe(true);
  });

  it('saves and loads across processes', async () => {
    const first = new Vault();
    await first.load('passphrase', dir);
    first.set('token', 'abc123');
    await first.save('passphrase', dir);

    const second = new Vault();
    const existed = await second.load('passphrase', dir);
    expect(existed).toBe(true);
    expect(second.get('token')).toBe('abc123');
  });

  it('writes a file that does not contain the plaintext secret', async () => {
    const vault = new Vault();
    await vault.load('passphrase', dir);
    vault.set('password', 'super-secret-value');
    await vault.save('passphrase', dir);

    const raw = await readFile(join(dir, '.bv', 'vault.enc'), 'utf8');
    expect(raw).not.toContain('super-secret-value');
    expect(raw).toContain('BVV1'.slice(0, 0) + 'ciphertext');
  });

  it('loads an empty vault when there is no file', async () => {
    const vault = new Vault();
    const existed = await vault.load('passphrase', dir);
    expect(existed).toBe(false);
    expect(vault.size).toBe(0);
  });

  it('resolves a secret placeholder', async () => {
    const vault = new Vault();
    await vault.load('passphrase', dir);
    vault.set('password', 'hunter2');
    const result = vault.resolve('user={{secret:password}}!');
    expect(result.resolved).toBe('user=hunter2!');
    expect(result.used).toEqual(['password']);
    expect(result.missing).toEqual([]);
  });

  it('leaves an unknown placeholder in place and reports it', async () => {
    const vault = new Vault();
    await vault.load('passphrase', dir);
    const result = vault.resolve('{{secret:nope}}');
    expect(result.resolved).toBe('{{secret:nope}}');
    expect(result.missing).toEqual(['nope']);
  });

  it('detects a placeholder', () => {
    expect(Vault.hasPlaceholder('{{secret:password}}')).toBe(true);
    expect(Vault.hasPlaceholder('no placeholder')).toBe(false);
  });

  it('reads the passphrase from the environment', () => {
    const previous = process.env['BV_VAULT_PASSPHRASE'];
    process.env['BV_VAULT_PASSPHRASE'] = 'from-env';
    expect(passphraseFromEnv()).toBe('from-env');
    delete process.env['BV_VAULT_PASSPHRASE'];
    expect(passphraseFromEnv()).toBeUndefined();
    if (previous !== undefined) process.env['BV_VAULT_PASSPHRASE'] = previous;
  });

  it('compares secrets without a timing leak', () => {
    expect(secretEquals('abc', 'abc')).toBe(true);
    expect(secretEquals('abc', 'abd')).toBe(false);
    expect(secretEquals('abc', 'abcd')).toBe(false);
  });
});

describe('the redactor', () => {
  it('masks a registered secret', () => {
    const redactor = new Redactor();
    redactor.add('password', 'hunter2');
    expect(redactor.redact('the password is hunter2 here')).toContain(
      `${REDACTION_MARKER}:password`,
    );
  });

  it('leaves text alone when nothing is registered', () => {
    expect(new Redactor().redact('nothing to hide')).toBe('nothing to hide');
  });

  it('does not register a very short value', () => {
    const redactor = new Redactor();
    redactor.add('tiny', 'ab');
    expect(redactor.size).toBe(0);
  });

  it('does not register the same value twice', () => {
    const redactor = new Redactor();
    redactor.add('a', 'shared-value');
    redactor.add('b', 'shared-value');
    expect(redactor.size).toBe(1);
  });

  it('removes a secret', () => {
    const redactor = new Redactor();
    redactor.add('password', 'hunter2');
    expect(redactor.remove('password')).toBe(true);
    expect(redactor.remove('password')).toBe(false);
    expect(redactor.size).toBe(0);
  });

  it('lists the secret names', () => {
    const redactor = new Redactor();
    redactor.add('a', 'value-a');
    redactor.add('b', 'value-b');
    expect(redactor.names().sort()).toEqual(['a', 'b']);
  });

  it('masks the longer secret first when one contains another', () => {
    const redactor = new Redactor();
    redactor.add('short', 'secret');
    redactor.add('long', 'secret-value');
    const masked = redactor.redact('the secret-value here');
    expect(masked).toContain(`${REDACTION_MARKER}:long`);
    expect(masked).not.toContain('secret-value');
  });

  it('masks a whole value', () => {
    const redactor = new Redactor();
    redactor.add('password', 'hunter2');
    expect(redactor.redactValue('hunter2')).toBe(`${REDACTION_MARKER}:password`);
  });

  it('masks a value that contains a secret', () => {
    const redactor = new Redactor();
    redactor.add('password', 'hunter2');
    expect(redactor.redactValue('prefix hunter2 suffix')).toContain(REDACTION_MARKER);
  });

  it('removes sensitive headers entirely', () => {
    const redactor = new Redactor();
    const headers = redactor.redactHeaders({
      authorization: 'Bearer abc123',
      cookie: 'session=xyz',
      'content-type': 'application/json',
    });
    expect(headers['authorization']).toBe(`${REDACTION_MARKER}:header`);
    expect(headers['cookie']).toBe(`${REDACTION_MARKER}:header`);
    expect(headers['content-type']).toBe('application/json');
  });

  it('masks a secret in a header value', () => {
    const redactor = new Redactor();
    redactor.add('token', 'abc123');
    const headers = redactor.redactHeaders({ 'x-custom': 'value abc123' });
    expect(headers['x-custom']).toContain(REDACTION_MARKER);
  });

  it('masks the query string of a URL', () => {
    const redactor = new Redactor();
    redactor.add('token', 'abc123');
    const masked = redactor.redactUrl('https://example.test/path?token=abc123&page=2');
    expect(masked).not.toContain('abc123');
    expect(masked).toContain('token=');
    expect(masked).toContain('page=2');
  });

  it('leaves a URL with no query alone', () => {
    const redactor = new Redactor();
    expect(redactor.redactUrl('https://example.test/path')).toBe('https://example.test/path');
  });

  it('masks a query part with no equals sign', () => {
    const redactor = new Redactor();
    expect(redactor.redactUrl('https://example.test/path?flag')).toContain('?flag');
  });

  it('truncates a long body', () => {
    const redactor = new Redactor();
    const masked = redactor.redactBody('x'.repeat(1000), 100);
    expect(masked.length).toBeLessThanOrEqual(101);
    expect(masked.endsWith('…')).toBe(true);
  });

  it('keeps a short body whole', () => {
    const redactor = new Redactor();
    expect(redactor.redactBody('short', 100)).toBe('short');
  });

  it('masks secrets in an error message', () => {
    const redactor = new Redactor();
    redactor.add('password', 'hunter2');
    const masked = redactError(new Error('failed to fill hunter2'), redactor);
    expect(masked).not.toContain('hunter2');
  });

  it('masks secrets in a JSON payload', () => {
    const redactor = new Redactor();
    redactor.add('password', 'hunter2');
    const masked = redactJson({ a: 'hunter2', b: { c: ['hunter2'] } }, redactor);
    expect(JSON.stringify(masked)).not.toContain('hunter2');
  });

  it('leaves non-string JSON values alone', () => {
    const redactor = new Redactor();
    const masked = redactJson({ a: 1, b: true, c: null }, redactor);
    expect(masked).toEqual({ a: 1, b: true, c: null });
  });
});
