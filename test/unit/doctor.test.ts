/**
 * Tests for the `bv doctor` command (M01).
 *
 * The doctor is the first thing a new user runs, and it is the command
 * that tells them what is wrong. Its branches matter: a check that says
 * "ok" when something is missing sends the user down the wrong path.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor, type DoctorCheck } from '../../src/cli/commands/doctor.js';

/** A check by name. */
function check(checks: readonly DoctorCheck[], name: string): DoctorCheck | undefined {
  return checks.find((entry) => entry.name === name);
}

describe('the doctor', () => {
  it('checks the node version', async () => {
    const checks = await runDoctor(process.cwd());
    const node = check(checks, 'node');

    expect(node).toBeDefined();
    // The test suite runs on a supported Node, so this is always ok.
    expect(node?.status).toBe('ok');
    expect(node?.detail).toContain('v');
  });

  it('checks for the Playwright browser', async () => {
    const checks = await runDoctor(process.cwd());
    expect(check(checks, 'playwright-chromium')).toBeDefined();
  });

  it('checks the runtime directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bv-doctor-'));
    try {
      const checks = await runDoctor(dir);
      const runtime = check(checks, 'runtime-dir');

      expect(runtime).toBeDefined();
      // The directory does not exist yet, so it is a warning with a fix.
      expect(runtime?.status).not.toBe('ok');
      expect(runtime?.fix).toContain('bv init');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports the runtime directory as present once it exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bv-doctor-'));
    try {
      await mkdir(join(dir, '.bv'), { recursive: true });
      const checks = await runDoctor(dir);
      expect(check(checks, 'runtime-dir')?.status).toBe('ok');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('checks the policy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bv-doctor-'));
    try {
      const checks = await runDoctor(dir);
      const policy = check(checks, 'policy');

      expect(policy).toBeDefined();
      expect(policy?.status).not.toBe('ok');
      expect(policy?.fix).toContain('bv init');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports the policy as present once it is written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bv-doctor-'));
    try {
      await mkdir(join(dir, '.bv'), { recursive: true });
      await writeFile(join(dir, '.bv', 'policy.yaml'), 'version: 1\n', 'utf8');
      const checks = await runDoctor(dir);
      expect(check(checks, 'policy')?.status).toBe('ok');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a malformed policy as a failure with a fix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bv-doctor-'));
    try {
      await mkdir(join(dir, '.bv'), { recursive: true });
      await writeFile(join(dir, '.bv', 'policy.yaml'), 'version: 999\n', 'utf8');
      const checks = await runDoctor(dir);
      const policy = check(checks, 'policy');

      expect(policy?.status).toBe('fail');
      expect(policy?.fix).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports the API key as a warning, not a failure', async () => {
    // Mode A needs no key, so a missing key must not fail the doctor.
    const dir = await mkdtemp(join(tmpdir(), 'bv-doctor-'));
    try {
      const checks = await runDoctor(dir);
      const key = check(checks, 'anthropic-key');

      expect(key).toBeDefined();
      expect(key?.status).not.toBe('fail');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('always returns at least the core checks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bv-doctor-'));
    try {
      const checks = await runDoctor(dir);
      const names = checks.map((entry) => entry.name);
      expect(names).toContain('node');
      expect(names).toContain('playwright-chromium');
      expect(names).toContain('runtime-dir');
      expect(names).toContain('policy');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('gives every failing check a fix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bv-doctor-'));
    try {
      const checks = await runDoctor(dir);
      for (const entry of checks) {
        if (entry.status === 'fail') {
          expect(entry.fix, `${entry.name} failed with no fix`).toBeDefined();
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
