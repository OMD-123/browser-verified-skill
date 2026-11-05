/**
 * The daemon descriptor: how a CLI client finds and authenticates to the
 * running daemon.
 *
 * `daemon.json` holds the port, the pid and the **hash** of the bearer token.
 * The token itself lives in `daemon.token` (mode 0600) because the client
 * needs the plaintext to authenticate. See DECISIONS D-0004.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { daemonInfoPath, daemonTokenPath, writePrivateFile } from './paths.js';

/** The on-disk descriptor of a running daemon. */
export interface DaemonInfo {
  /** The version of the descriptor format. */
  version: 1;
  /** The loopback port the daemon listens on. */
  port: number;
  /** The pid of the daemon process. */
  pid: number;
  /** SHA-256 of the bearer token, hex encoded. */
  tokenHash: string;
  /** The session name. */
  session: string;
  /** When the daemon started, ISO-8601. */
  startedAt: string;
  /** Whether the browser is headed. */
  headed: boolean;
  /** The browser name, e.g. `chromium`. */
  browser: string;
}

/** Hash a token for storage and comparison. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Generate a fresh bearer token. */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Compare a presented token with a stored hash, in constant time.
 *
 * The lengths are compared first (which is not secret — the hash length is
 * fixed), then the bytes with `timingSafeEqual`.
 */
export function tokenMatches(presented: string, storedHash: string): boolean {
  const presentedHash = hashToken(presented);
  const a = Buffer.from(presentedHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Write the descriptor and the token. */
export async function writeDaemonInfo(
  info: DaemonInfo,
  token: string,
  cwd?: string,
): Promise<void> {
  await writePrivateFile(daemonTokenPath(cwd), token);
  await writePrivateFile(daemonInfoPath(cwd), `${JSON.stringify(info, null, 2)}\n`);
}

/** Read the descriptor. Returns undefined when there is no running daemon. */
export async function readDaemonInfo(cwd?: string): Promise<DaemonInfo | undefined> {
  try {
    const raw = await readFile(daemonInfoPath(cwd), 'utf8');
    const parsed = JSON.parse(raw) as DaemonInfo;
    if (typeof parsed.port !== 'number' || typeof parsed.tokenHash !== 'string') {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/** Read the bearer token. */
export async function readDaemonToken(cwd?: string): Promise<string | undefined> {
  try {
    return (await readFile(daemonTokenPath(cwd), 'utf8')).trim();
  } catch {
    return undefined;
  }
}

/** Remove the descriptor and token files. */
export async function clearDaemonInfo(cwd?: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await rm(daemonInfoPath(cwd), { force: true });
  await rm(daemonTokenPath(cwd), { force: true });
}

/** True when a process with this pid is alive. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 checks for existence without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The base URL of a daemon. */
export function daemonBaseUrl(info: DaemonInfo): string {
  return `http://127.0.0.1:${info.port}`;
}

/** Write the descriptor to a plain path (used by tests). */
export async function writeInfoTo(path: string, info: DaemonInfo): Promise<void> {
  await writeFile(path, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
}
