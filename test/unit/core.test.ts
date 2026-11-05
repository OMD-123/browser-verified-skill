import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { EXIT, isExitCode } from '../../src/core/exit.js';
import { VERSION } from '../../src/version.js';
import { bvRoot, policyPath, runDir, stepDir } from '../../src/core/paths.js';

describe('exit codes', () => {
  it('uses the documented values', () => {
    expect(EXIT.OK).toBe(0);
    expect(EXIT.FAILURE).toBe(1);
    expect(EXIT.USAGE).toBe(2);
    expect(EXIT.POLICY_DENIED).toBe(3);
    expect(EXIT.NEEDS_APPROVAL).toBe(4);
    expect(EXIT.INJECTION_BLOCK).toBe(5);
    expect(EXIT.VERIFICATION_FAILED).toBe(6);
  });

  it('recognises valid exit codes', () => {
    expect(isExitCode(0)).toBe(true);
    expect(isExitCode(6)).toBe(true);
    expect(isExitCode(7)).toBe(false);
  });
});

describe('version', () => {
  it('reads the package version', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('paths', () => {
  const root = join('tmp', 'work');
  const absRoot = resolve(root);

  it('places runtime state under .bv/', () => {
    expect(bvRoot(root)).toBe(join(absRoot, '.bv'));
    expect(policyPath(root)).toBe(join(absRoot, '.bv', 'policy.yaml'));
  });

  it('pads step directories to three digits', () => {
    expect(stepDir('run1', 7, root)).toContain(join('steps', '007'));
    expect(stepDir('run1', 123, root)).toContain(join('steps', '123'));
  });

  it('keeps run artifacts inside the run directory', () => {
    expect(runDir('abc', root)).toBe(join(absRoot, '.bv', 'runs', 'abc'));
  });
});
