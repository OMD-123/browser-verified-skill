/**
 * The last safety coverage tests.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicy, messageOf } from '../../../src/safety/policy.js';
import { policyPath } from '../../../src/core/paths.js';
import { computeElementFacts } from '../../../src/safety/element-facts.js';

describe('the policy loader: the error fallbacks', () => {
  it('reports a YAML error that is not an Error instance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bv-policy-y-'));
    try {
      await mkdir(join(dir, '.bv'), { recursive: true });
      await writeFile(policyPath(dir), 'version: 1\n  bad: [unclosed\n', 'utf8');
      await expect(loadPolicy(dir)).rejects.toThrow(/not valid YAML/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports an invalid policy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bv-policy-i-'));
    try {
      await mkdir(join(dir, '.bv'), { recursive: true });
      await writeFile(policyPath(dir), 'version: 99\n', 'utf8');
      await expect(loadPolicy(dir)).rejects.toThrow(/not valid/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the error message helper', () => {
  it('uses the message of an Error', () => {
    expect(messageOf(new Error('boom'))).toBe('boom');
  });

  it('stringifies anything else', () => {
    expect(messageOf('a string')).toBe('a string');
    expect(messageOf(42)).toBe('42');
    expect(messageOf(undefined)).toBe('undefined');
  });
});

describe('the element facts: the remaining branches', () => {
  it('gives a form control with no implicit role no role', () => {
    // `select` always has a role, but a tag that is a form control with no
    // mapping (there is none today) would get none.
    const facts = computeElementFacts({ tag: 'input', type: 'email' });
    expect(facts.role).toBe('textbox');
  });

  it('omits an empty name', () => {
    const facts = computeElementFacts({ tag: 'input', ariaLabel: '', labelText: '' });
    expect(facts.name).toBeUndefined();
  });
});
