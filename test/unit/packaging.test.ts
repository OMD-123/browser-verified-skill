/**
 * The packaging tests (M31).
 *
 * These check that the **published artifact** works, not just the source
 * tree. The bug this file exists for: the installed package could not
 * start the daemon, because the bundle path was resolved against the
 * source layout rather than the installed one. The source tree passed
 * every other test; only an actual install caught it.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

/** The repository root. */
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

describe('the published artifact', () => {
  it('has a bundle', () => {
    expect(existsSync(join(ROOT, 'scripts', 'bv.mjs'))).toBe(true);
  });

  it('runs and prints its version', async () => {
    const { stdout } = await exec(process.execPath, [join(ROOT, 'scripts', 'bv.mjs'), '--version']);
    expect(stdout.trim()).toContain('0.1.0');
  });

  it('lists every command', async () => {
    const { stdout } = await exec(process.execPath, [join(ROOT, 'scripts', 'bv.mjs'), '--help']);
    for (const command of [
      'doctor',
      'init',
      'session',
      'snapshot',
      'act',
      'plan',
      'approve',
      'verify',
      'extract',
      'compile',
      'replay',
      'mcp',
      'memory',
      'diff',
      'report',
    ]) {
      expect(stdout, `the help does not mention "${command}"`).toContain(command);
    }
  });

  it('has a shebang, so it can be run as a command', async () => {
    const source = await readFile(join(ROOT, 'scripts', 'bv.mjs'), 'utf8');
    expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('names every file it ships', async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      files: string[];
      bin: Record<string, string>;
    };

    for (const path of manifest.files) {
      expect(existsSync(join(ROOT, path)), `${path} is listed but does not exist`).toBe(true);
    }

    for (const bin of Object.values(manifest.bin)) {
      expect(existsSync(join(ROOT, bin)), `${bin} is listed but does not exist`).toBe(true);
    }
  });

  it('does not list a file that does not exist', async () => {
    // The check above already covers this; this makes the intent explicit
    // and catches a glob that matches nothing.
    const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      files: string[];
    };
    for (const path of manifest.files) {
      if (path.endsWith('/')) continue;
      expect(existsSync(join(ROOT, path))).toBe(true);
    }
  });

  it('ships the security model and the known limitations', async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      files: string[];
    };
    expect(manifest.files).toContain('docs/SECURITY.md');
    expect(manifest.files).toContain('docs/KNOWN_LIMITATIONS.md');
    expect(existsSync(join(ROOT, 'docs', 'SECURITY.md'))).toBe(true);
    expect(existsSync(join(ROOT, 'docs', 'KNOWN_LIMITATIONS.md'))).toBe(true);
  });

  it('ships a skill that an agent can read', async () => {
    expect(existsSync(join(ROOT, 'SKILL.md'))).toBe(true);
    const skill = await readFile(join(ROOT, 'SKILL.md'), 'utf8');
    expect(skill).toContain('name: browser-verified');
    expect(skill).toContain('description:');
  });

  it('does not depend on a package it does not use', async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    // Every runtime dependency has to be one the code actually imports.
    // The check is deliberately loose about the exact import style; the
    // point is that a dependency nobody imports is dead weight in every
    // install.
    for (const name of Object.keys(manifest.dependencies)) {
      // Every dependency is either imported somewhere in src/ or is a
      // peer of one that is.
      const imported = await importer.grep(join(ROOT, 'src'), name);
      expect(imported, `the dependency "${name}" is never imported`).toBe(true);
    }
  });
});

/**
 * Whether a module is imported anywhere under a directory.
 *
 * It is a method on an object rather than a bare function, so the
 * `unbound-method` rule does not complain about calling it detached.
 */
const importer = {
  grep: async (directory: string, name: string): Promise<boolean> => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return false;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (await importer.grep(entryPath, name)) return true;
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;

      const source = await readFile(entryPath, 'utf8');
      if (source.includes(`'${name}`) || source.includes(`"${name}`)) return true;
    }

    return false;
  },
};
