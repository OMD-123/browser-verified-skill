/**
 * Filesystem layout for browser-verified-skill.
 *
 * Everything runtime lives under `.bv/` in the current working directory:
 *
 *   .bv/
 *   ├── policy.yaml
 *   ├── vault.enc
 *   ├── playbooks.sqlite
 *   ├── daemon.json      (port, token hash, pid)
 *   ├── daemon.token     (bearer token, mode 0600)
 *   └── runs/<runId>/
 *       ├── audit.jsonl
 *       ├── trace.zip
 *       ├── network.har
 *       ├── result.json
 *       ├── report.html
 *       └── steps/NNN/ { aria.txt  screenshot.png  state.json  net.json }
 */
import { mkdir, chmod, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Directory name for all runtime state. */
export const BV_DIR = '.bv';

/** Resolve the `.bv` root for a given working directory. */
export function bvRoot(cwd: string = process.cwd()): string {
  return join(resolve(cwd), BV_DIR);
}

/** Path of the policy file. */
export function policyPath(cwd: string = process.cwd()): string {
  return join(bvRoot(cwd), 'policy.yaml');
}

/** Path of the encrypted vault. */
export function vaultPath(cwd: string = process.cwd()): string {
  return join(bvRoot(cwd), 'vault.enc');
}

/** Path of the playbook database. */
export function playbooksPath(cwd: string = process.cwd()): string {
  return join(bvRoot(cwd), 'playbooks.sqlite');
}

/** Path of the daemon descriptor. */
export function daemonInfoPath(cwd: string = process.cwd()): string {
  return join(bvRoot(cwd), 'daemon.json');
}

/** Path of the daemon bearer token. */
export function daemonTokenPath(cwd: string = process.cwd()): string {
  return join(bvRoot(cwd), 'daemon.token');
}

/** Root directory for run artifacts. */
export function runsRoot(cwd: string = process.cwd()): string {
  return join(bvRoot(cwd), 'runs');
}

/** Directory holding one run's artifacts. */
export function runDir(runId: string, cwd: string = process.cwd()): string {
  return join(runsRoot(cwd), runId);
}

/** Directory holding one step's artifacts inside a run. */
export function stepDir(runId: string, step: number, cwd: string = process.cwd()): string {
  return join(runDir(runId, cwd), 'steps', String(step).padStart(3, '0'));
}

/** Path of the append-only audit log for a run. */
export function auditPath(runId: string, cwd: string = process.cwd()): string {
  return join(runDir(runId, cwd), 'audit.jsonl');
}

/**
 * Write a file with owner-only permissions where the platform supports it.
 * Windows has no POSIX mode bits, so the chmod is best-effort there; the file
 * is still created inside the user's private profile directory.
 */
export async function writePrivateFile(path: string, contents: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents, { encoding: 'utf8', mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    /* Windows: no POSIX mode bits. */
  }
}

/** Create the `.bv` directory tree and return its root. */
export async function ensureBvDir(cwd: string = process.cwd()): Promise<string> {
  const root = bvRoot(cwd);
  await mkdir(join(root, 'runs'), { recursive: true });
  return root;
}

/**
 * Absolute path to a file that may be either absolute or relative to the
 * working directory.
 */
export function absPath(p: string, cwd: string = process.cwd()): string {
  return isAbsolute(p) ? p : join(resolve(cwd), p);
}

/** The user's home directory, used to locate default config locations. */
export function userHome(): string {
  return homedir();
}
