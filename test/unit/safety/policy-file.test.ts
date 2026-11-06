/**
 * Tests for the policy file loader (M05).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicy, writeDefaultPolicy, defaultPolicy } from '../../../src/safety/policy.js';
import { policyPath } from '../../../src/core/paths.js';

describe('the policy loader', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bv-policy-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the default policy when there is no file', async () => {
    const policy = await loadPolicy(dir);
    expect(policy.version).toBe(1);
    expect(policy.actionClasses.deny).toEqual([]);
  });

  it('reads a policy from disk', async () => {
    await mkdir(join(dir, '.bv'), { recursive: true });
    await writeFile(
      policyPath(dir),
      [
        'version: 1',
        'domains:',
        '  allow:',
        '    - example.test',
        '  deny: []',
        'ownedOrigins: []',
        'actionClasses:',
        '  approvalRequired:',
        '    - submit',
        '  deny: []',
        'compliance:',
        '  respectRobots: true',
        '  userAgentSuffix: "BrowserVerified/1.0 (+https://example.test/contact)"',
        '  captcha: human_handoff',
        '  evalReadonly: false',
        'secrets:',
        '  maskInLogs: true',
        '',
      ].join('\n'),
      'utf8',
    );
    const policy = await loadPolicy(dir);
    expect(policy.domains.allow).toEqual(['example.test']);
    expect(policy.compliance.captcha).toBe('human_handoff');
  });

  it('reports invalid YAML clearly', async () => {
    await mkdir(join(dir, '.bv'), { recursive: true });
    await writeFile(policyPath(dir), 'version: 1\n  bad: [unclosed\n', 'utf8');
    await expect(loadPolicy(dir)).rejects.toThrow(/not valid YAML/);
  });

  it('reports an invalid policy clearly', async () => {
    await mkdir(join(dir, '.bv'), { recursive: true });
    await writeFile(policyPath(dir), 'version: 99\n', 'utf8');
    await expect(loadPolicy(dir)).rejects.toThrow(/not valid/);
  });

  it('rejects a policy with a forbidden key', async () => {
    await mkdir(join(dir, '.bv'), { recursive: true });
    await writeFile(policyPath(dir), 'version: 1\nstealth: true\n', 'utf8');
    await expect(loadPolicy(dir)).rejects.toThrow(/not allowed/);
  });
});

describe('the default policy writer', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bv-policy-w-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a policy that loads back', async () => {
    const result = await writeDefaultPolicy(dir);
    expect(result.created).toBe(true);
    const policy = await loadPolicy(dir);
    expect(policy.version).toBe(1);
  });

  it('does not overwrite an existing policy', async () => {
    await mkdir(join(dir, '.bv'), { recursive: true });
    await writeFile(
      policyPath(dir),
      'version: 1\ndomains:\n  allow:\n    - custom.test\n  deny: []\n',
      'utf8',
    );
    const result = await writeDefaultPolicy(dir);
    expect(result.created).toBe(false);
    const policy = await loadPolicy(dir);
    expect(policy.domains.allow).toEqual(['custom.test']);
  });

  it('writes a policy the default validator accepts', () => {
    expect(defaultPolicy().version).toBe(1);
  });
});
