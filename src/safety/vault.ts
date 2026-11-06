/**
 * The secrets vault (M09).
 *
 * Secrets are stored in an AES-256-GCM file (`.bv/vault.enc`). The key is
 * derived with scrypt from a passphrase supplied through
 * `BV_VAULT_PASSPHRASE` or an interactive prompt.
 *
 * Placeholders of the form `{{secret:name}}` are resolved **only inside the
 * daemon, at fill time**. The resolved value is never returned to the CLI,
 * never written to the audit log, and never included in a model prompt.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { vaultPath } from '../core/paths.js';

/**
 * The format marker written at the start of a vault file.
 *
 * It is not secret: it says "this is a browser-verified vault", so a wrong
 * file is reported as such rather than as a decryption failure.
 */
const VAULT_MAGIC = 'BVV1';

/** The salt length in bytes. */
const SALT_LENGTH = 16;

/** The IV length in bytes. */
const IV_LENGTH = 12;

/** The key length in bytes (AES-256). */
const KEY_LENGTH = 32;

/** The scrypt cost parameters. */
const SCRYPT_OPTIONS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

/** The vault file format. */
export interface VaultFile {
  /** The format version. */
  version: 1;
  /** The format marker. */
  magic: typeof VAULT_MAGIC;
  /** The scrypt salt, hex encoded. */
  salt: string;
  /** The GCM IV, hex encoded. */
  iv: string;
  /** The auth tag, hex encoded. */
  tag: string;
  /** The ciphertext, hex encoded. */
  ciphertext: string;
}

/** A secret and when it was stored. */
export interface VaultSecret {
  /** The secret's name. */
  name: string;
  /** The secret's value. */
  value: string;
  /** When it was stored. */
  storedAt: string;
}

/** The on-disk secret store. */
interface VaultContents {
  secrets: Record<string, { value: string; storedAt: string }>;
}

/** Derive the encryption key from a passphrase. */
function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LENGTH, SCRYPT_OPTIONS);
}

/** Encrypt the contents with a passphrase. */
export function encryptVault(contents: VaultContents, passphrase: string): VaultFile {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(contents), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    magic: VAULT_MAGIC,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

/** Decrypt the contents with a passphrase. */
export function decryptVault(file: VaultFile, passphrase: string): VaultContents {
  if (file.version !== 1) {
    throw new Error(`unsupported vault version: ${String(file.version)}`);
  }
  if (file.magic !== VAULT_MAGIC) {
    throw new Error('this file is not a browser-verified vault');
  }
  const salt = Buffer.from(file.salt, 'hex');
  const iv = Buffer.from(file.iv, 'hex');
  const tag = Buffer.from(file.tag, 'hex');
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(file.ciphertext, 'hex')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as VaultContents;
}

/**
 * The vault.
 *
 * Holds the secrets in memory, encrypted on disk.
 */
export class Vault {
  private contents: VaultContents = { secrets: {} };
  private loaded = false;

  /**
   * Load the vault from disk.
   *
   * Returns false when there is no vault file yet.
   */
  async load(passphrase: string, cwd?: string): Promise<boolean> {
    let raw: string;
    try {
      raw = await readFile(vaultPath(cwd), 'utf8');
    } catch {
      this.contents = { secrets: {} };
      this.loaded = true;
      return false;
    }
    const file = JSON.parse(raw) as VaultFile;
    this.contents = decryptVault(file, passphrase);
    this.loaded = true;
    return true;
  }

  /** Write the vault to disk. */
  async save(passphrase: string, cwd?: string): Promise<void> {
    const path = vaultPath(cwd);
    await mkdir(dirname(path), { recursive: true });
    const file = encryptVault(this.contents, passphrase);
    await writeFile(path, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  /** Store a secret. */
  set(name: string, value: string): void {
    this.contents.secrets[name] = { value, storedAt: new Date().toISOString() };
  }

  /** Read a secret. */
  get(name: string): string | undefined {
    return this.contents.secrets[name]?.value;
  }

  /** Remove a secret. */
  remove(name: string): boolean {
    if (this.contents.secrets[name] === undefined) return false;
    delete this.contents.secrets[name];
    return true;
  }

  /** The names of the stored secrets, and when they were stored. */
  list(): { name: string; storedAt: string }[] {
    return Object.entries(this.contents.secrets)
      .map(([name, entry]) => ({ name, storedAt: entry.storedAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** How many secrets are stored. */
  get size(): number {
    return Object.keys(this.contents.secrets).length;
  }

  /** True when the vault has been loaded. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Resolve `{{secret:name}}` placeholders in a string.
   *
   * This is the only place a secret value is produced. The caller must be
   * inside the daemon, filling a field.
   */
  resolve(value: string): { resolved: string; used: string[]; missing: string[] } {
    const used: string[] = [];
    const missing: string[] = [];
    const resolved = value.replace(/\{\{secret:([a-zA-Z0-9_.-]+)\}\}/g, (match, name: string) => {
      const secret = this.get(name);
      if (secret === undefined) {
        missing.push(name);
        return match;
      }
      used.push(name);
      return secret;
    });
    return { resolved, used, missing };
  }

  /** True when the string contains a secret placeholder. */
  static hasPlaceholder(value: string): boolean {
    return /\{\{secret:[a-zA-Z0-9_.-]+\}\}/.test(value);
  }
}

/**
 * Read the vault passphrase.
 *
 * Uses `BV_VAULT_PASSPHRASE` when it is set. Otherwise the caller must
 * prompt the user; this function returns undefined in that case.
 */
export function passphraseFromEnv(): string | undefined {
  const value = process.env['BV_VAULT_PASSPHRASE'];
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Used when checking a placeholder against a stored value.
 */
export function secretEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
