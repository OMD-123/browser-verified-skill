/**
 * Tests for the pure core helpers.
 *
 * These modules have no browser or filesystem dependency in their logic, so
 * they are tested directly rather than through the CLI.
 */
import { describe, expect, it } from 'vitest';
import { estimateTokens, DEFAULT_CHARS_PER_TOKEN } from '../../src/perception/tokens.js';
import { renderTree, renderDiff, renderHeader, truncate } from '../../src/perception/render.js';
import {
  pruneSnapshot,
  truncateText,
  isInteresting,
  estimateTreeTokens,
} from '../../src/perception/prune.js';
import { parseRef, isRef, RefRegistry } from '../../src/perception/refs.js';
import { absPath, bvRoot, policyPath, runDir, stepDir, auditPath } from '../../src/core/paths.js';
import { ok, fail } from '../../src/core/output.js';
import { EXIT } from '../../src/core/exit.js';
import {
  toBvError,
  UsageError,
  PolicyDeniedError,
  NeedsApprovalError,
  InjectionBlockedError,
  VerificationFailedError,
} from '../../src/core/errors.js';
import type { AxNode } from '../../src/perception/snapshot.js';

/** A button node. */
function button(name: string, text = name): AxNode {
  return { role: 'button', name, text, children: [] };
}

describe('the token estimator', () => {
  it('uses four characters per token by default', () => {
    expect(DEFAULT_CHARS_PER_TOKEN).toBe(4);
  });

  it('estimates a string', () => {
    const estimate = estimateTokens('a'.repeat(400));
    expect(estimate.tokens).toBe(100);
    expect(estimate.characters).toBe(400);
  });

  it('marks the count as an estimate', () => {
    const estimate = estimateTokens('hello');
    expect(estimate.estimated).toBe(true);
    expect(estimate.method).toBe('chars-per-token');
  });

  it('rounds up', () => {
    expect(estimateTokens('abcde').tokens).toBe(2);
  });

  it('estimates an empty string as zero', () => {
    expect(estimateTokens('').tokens).toBe(0);
  });
});

describe('the tree renderer', () => {
  it('renders a node with its role and name', () => {
    const text = renderTree([button('Log in')]);
    expect(text).toContain('button');
    expect(text).toContain('Log in');
  });

  it('renders nested nodes', () => {
    const text = renderTree([
      { role: 'list', name: 'Items', children: [button('One'), button('Two')] },
    ]);
    expect(text).toContain('One');
    expect(text).toContain('Two');
  });

  it('renders an empty tree as an empty string', () => {
    expect(renderTree([])).toBe('');
  });

  it('truncates long text with a marker', () => {
    const truncated = truncate('x'.repeat(100), 10);
    expect(truncated.length).toBeLessThanOrEqual(11);
    expect(truncated.endsWith('…')).toBe(true);
  });

  it('does not truncate short text', () => {
    expect(truncate('short', 100)).toBe('short');
  });

  it('renders a diff with an added node', () => {
    const diff = renderDiff({
      header: {
        url: 'http://x/',
        title: 'T',
        nodes: 1,
        interactive: 1,
        changes: 1,
        frames: 0,
      },
      changes: [{ kind: 'added', ref: 'e1', role: 'button', name: 'New', depth: 0 }],
      navigated: false,
    });
    expect(diff).toContain('New');
    expect(diff).toContain('http://x/');
  });

  it('renders a diff for a removed node', () => {
    const diff = renderDiff({
      header: {
        url: 'http://x/',
        title: 'T',
        nodes: 1,
        interactive: 1,
        changes: 1,
        frames: 0,
      },
      changes: [{ kind: 'removed', ref: 'e1', role: 'button', name: 'Gone', depth: 0 }],
      navigated: false,
    });
    expect(diff).toContain('Gone');
  });

  it('renders a diff with no changes', () => {
    const diff = renderDiff({
      header: {
        url: 'http://x/',
        title: 'T',
        nodes: 1,
        interactive: 1,
        changes: 0,
        frames: 0,
      },
      changes: [],
      navigated: false,
    });
    expect(diff).toContain('no changes');
  });

  it('renders a header', () => {
    const header = renderHeader({
      url: 'http://x/',
      title: 'T',
      nodes: 3,
      interactive: 1,
      changes: 2,
      frames: 0,
    });
    expect(header).toContain('http://x/');
  });
});

describe('the pruner', () => {
  it('keeps a short list whole', () => {
    const result = pruneSnapshot([
      { role: 'list', name: 'L', children: [button('a'), button('b')] },
    ]);
    expect(result.roots).toHaveLength(1);
  });

  it('collapses a long list', () => {
    const children = Array.from({ length: 40 }, (_, i) => button(`item ${i}`));
    const result = pruneSnapshot([{ role: 'list', name: 'L', children }]);
    expect(result.roots).toHaveLength(1);
  });

  it('truncates long text and says how much was cut', () => {
    const truncated = truncateText('x'.repeat(100), 10);
    expect(truncated).toContain('…');
    expect(truncated).toContain('90 more chars');
  });

  it('does not truncate short text', () => {
    expect(truncateText('short', 100)).toBe('short');
  });

  it('keeps an interactive node', () => {
    expect(isInteresting(button('Save'))).toBe(true);
  });

  it('drops a decorative node', () => {
    expect(isInteresting({ role: 'none', name: '', text: '', children: [] })).toBe(false);
  });

  it('estimates the tokens of a tree', () => {
    expect(estimateTreeTokens([button('Save')])).toBeGreaterThan(0);
  });
});

describe('the ref helpers', () => {
  it('parses a ref', () => {
    const parsed = parseRef('e12');
    expect(parsed?.raw).toBe('e12');
    expect(parsed?.elementIndex).toBe(12);
    expect(parsed?.isFrame).toBe(false);
  });

  it('parses a frame ref', () => {
    const parsed = parseRef('f1e12');
    expect(parsed?.isFrame).toBe(true);
    expect(parsed?.frameIndex).toBe(1);
    expect(parsed?.elementIndex).toBe(12);
  });

  it('returns undefined for something that is not a ref', () => {
    expect(parseRef('not-a-ref')).toBeUndefined();
  });

  it('recognises a ref', () => {
    expect(isRef('e12')).toBe(true);
    expect(isRef('nope')).toBe(false);
  });

  it('registers and resolves a ref', () => {
    const registry = new RefRegistry();
    registry.add('e12', 'button');
    expect(registry.get('e12')?.role).toBe('button');
    expect(registry.has('e12')).toBe(true);
    expect(registry.size).toBe(1);
    expect(registry.all()).toEqual(['e12']);
  });

  it('resets the registry', () => {
    const registry = new RefRegistry();
    registry.add('e12', 'button');
    registry.reset();
    expect(registry.size).toBe(0);
  });

  it('returns undefined for an unregistered ref', () => {
    const registry = new RefRegistry();
    expect(registry.get('e99')).toBeUndefined();
  });
});

describe('the path helpers', () => {
  it('builds the bv root', () => {
    expect(bvRoot('/tmp/x')).toContain('.bv');
  });

  it('builds the policy path', () => {
    expect(policyPath('/tmp/x')).toContain('policy.yaml');
  });

  it('builds a run directory', () => {
    expect(runDir('r1', '/tmp/x')).toContain('r1');
  });

  it('builds a padded step directory', () => {
    expect(stepDir('r1', 7, '/tmp/x')).toContain('007');
  });

  it('builds the audit path', () => {
    expect(auditPath('r1', '/tmp/x')).toContain('audit.jsonl');
  });

  it('leaves an absolute path alone', () => {
    expect(absPath('/abs/path', '/tmp/x')).toBe('/abs/path');
  });

  it('resolves a relative path against the working directory', () => {
    expect(absPath('rel', '/tmp/x')).toContain('rel');
  });
});

describe('the output helpers', () => {
  it('builds a success result', () => {
    expect(ok({ a: 1 }).code).toBe(EXIT.OK);
  });

  it('builds a failure result', () => {
    expect(fail({}, [], EXIT.FAILURE).code).toBe(EXIT.FAILURE);
  });

  it('defaults a failure to the failure code', () => {
    expect(fail({}, []).code).toBe(EXIT.FAILURE);
  });
});

describe('the error helpers', () => {
  it('turns a usage error into a bv error with the usage code', () => {
    const err = toBvError(new UsageError('bad flag'));
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.message).toBe('bad flag');
  });

  it('turns a plain error into a bv error', () => {
    const err = toBvError(new Error('boom'));
    expect(err.message).toBe('boom');
  });

  it('handles a thrown non-error', () => {
    const err = toBvError('a string');
    expect(err.message).toContain('a string');
  });

  it('maps each error class to its exit code', () => {
    expect(new PolicyDeniedError('x', ['because']).exitCode).toBe(EXIT.POLICY_DENIED);
    expect(new NeedsApprovalError('x').exitCode).toBe(EXIT.NEEDS_APPROVAL);
    expect(new InjectionBlockedError('x', ['because']).exitCode).toBe(EXIT.INJECTION_BLOCK);
    expect(new VerificationFailedError('x').exitCode).toBe(EXIT.VERIFICATION_FAILED);
  });

  it('keeps the reasons of a policy denial', () => {
    const err = new PolicyDeniedError('nope', ['rule one', 'rule two']);
    expect(err.reasons).toEqual(['rule one', 'rule two']);
  });

  it('returns a bv error unchanged', () => {
    const original = new UsageError('x');
    expect(toBvError(original)).toBe(original);
  });
});
