import { describe, expect, it } from 'vitest';
import {
  normalizeSnapshot,
  countNodes,
  findByRef,
  nodeIdentity,
} from '../../src/perception/snapshot.js';
import { diffSnapshots } from '../../src/perception/diff.js';
import { pruneSnapshot, truncateText, estimateTreeTokens } from '../../src/perception/prune.js';
import { parseRef, isRef, RefRegistry } from '../../src/perception/refs.js';
import { estimateTokens } from '../../src/perception/tokens.js';
import { renderDiff, renderTree } from '../../src/perception/render.js';

describe('snapshot normalisation', () => {
  it('normalises a Playwright ai-mode snapshot', () => {
    const raw = [
      {
        role: 'main',
        ref: 'e2',
        children: [
          { role: 'heading', name: 'Sign in', level: 1, ref: 'e3' },
          { role: 'textbox', name: 'Username', ref: 'e6' },
          { role: 'button', name: 'Log in', ref: 'e9', cursor: 'pointer' },
        ],
      },
    ];
    const nodes = normalizeSnapshot(raw);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.role).toBe('main');
    expect(nodes[0]?.children).toHaveLength(3);
    expect(nodes[0]?.children?.[2]?.cursor).toBe(true);
  });

  it('ignores non-object entries', () => {
    expect(normalizeSnapshot(['x', 42, null, { role: 'button' }])).toHaveLength(1);
    expect(normalizeSnapshot('not an array')).toEqual([]);
  });

  it('counts nodes', () => {
    const nodes = normalizeSnapshot([
      { role: 'main', children: [{ role: 'button' }, { role: 'link' }] },
    ]);
    expect(countNodes(nodes)).toBe(3);
  });

  it('finds a node by ref', () => {
    const nodes = normalizeSnapshot([
      { role: 'main', children: [{ role: 'button', name: 'Go', ref: 'e9' }] },
    ]);
    expect(findByRef(nodes, 'e9')?.name).toBe('Go');
    expect(findByRef(nodes, 'nope')).toBeUndefined();
  });

  it('builds a stable identity', () => {
    expect(nodeIdentity({ role: 'button', name: 'Go', ref: 'e9' })).toBe('button|name=Go|ref=e9');
  });
});

describe('diffing', () => {
  const base = {
    roots: normalizeSnapshot([
      {
        role: 'main',
        ref: 'e2',
        children: [
          { role: 'heading', name: 'Title', ref: 'e3' },
          { role: 'textbox', name: 'Email', ref: 'e4' },
        ],
      },
    ]),
    documentToken: 'doc1',
  };

  it('reports everything as added on the first snapshot', () => {
    const diff = diffSnapshots(undefined, {
      roots: base.roots,
      url: 'http://x/',
      title: 'T',
      documentToken: 'doc1',
    });
    expect(diff.changes.length).toBeGreaterThan(0);
    expect(diff.changes.every((c) => c.kind === 'added')).toBe(true);
    expect(diff.header.nodes).toBe(3);
  });

  it('reports no changes for an identical snapshot', () => {
    const diff = diffSnapshots(base, {
      roots: base.roots,
      url: 'http://x/',
      title: 'T',
      documentToken: 'doc1',
    });
    expect(diff.changes).toHaveLength(0);
    expect(diff.navigated).toBe(false);
  });

  it('reports a text change as changed, not added+removed', () => {
    const next = {
      roots: normalizeSnapshot([
        {
          role: 'main',
          ref: 'e2',
          children: [
            { role: 'heading', name: 'Title', ref: 'e3' },
            { role: 'textbox', name: 'Email', ref: 'e4', text: 'typed' },
          ],
        },
      ]),
      documentToken: 'doc1',
    };
    const diff = diffSnapshots(base, { ...next, url: 'http://x/', title: 'T' });
    const textChange = diff.changes.find((c) => c.field === 'text');
    expect(textChange).toBeDefined();
    expect(textChange?.before).toBe('');
    expect(textChange?.after).toBe('typed');
  });

  it('detects navigation and invalidates refs', () => {
    const diff = diffSnapshots(base, {
      roots: base.roots,
      url: 'http://y/',
      title: 'T2',
      documentToken: 'doc2',
    });
    expect(diff.navigated).toBe(true);
  });

  it('reports removed nodes', () => {
    const next = {
      roots: normalizeSnapshot([
        { role: 'main', ref: 'e2', children: [{ role: 'heading', name: 'Title', ref: 'e3' }] },
      ]),
      documentToken: 'doc1',
    };
    const diff = diffSnapshots(base, { ...next, url: 'http://x/', title: 'T' });
    expect(diff.changes.some((c) => c.kind === 'removed')).toBe(true);
  });

  it('is much smaller than the full tree for a small change', () => {
    // A realistic 3-field form with page chrome (nav, heading, helper text,
    // footer), as a real page would have. The fixed one-line header is
    // amortised over this size.
    const form = normalizeSnapshot([
      {
        role: 'generic',
        ref: 'e1',
        children: [
          {
            role: 'navigation',
            name: 'Main',
            ref: 'e2',
            children: [
              { role: 'link', name: 'Home', ref: 'e3' },
              { role: 'link', name: 'Sign in', ref: 'e4' },
              { role: 'link', name: 'Help', ref: 'e5' },
            ],
          },
          {
            role: 'main',
            ref: 'e6',
            children: [
              { role: 'heading', name: 'Account setup', level: 1, ref: 'e7' },
              {
                role: 'form',
                ref: 'e8',
                children: [
                  { role: 'generic', text: 'Full name', ref: 'e9' },
                  { role: 'textbox', name: 'Full name', ref: 'e10' },
                  { role: 'paragraph', text: 'As it appears on your ID.', ref: 'e11' },
                  { role: 'generic', text: 'Email', ref: 'e12' },
                  { role: 'textbox', name: 'Email', ref: 'e13' },
                  {
                    role: 'paragraph',
                    text: 'We only use this to confirm your account.',
                    ref: 'e14',
                  },
                  { role: 'generic', text: 'City', ref: 'e15' },
                  { role: 'textbox', name: 'City', ref: 'e16' },
                  { role: 'button', name: 'Next', ref: 'e17', cursor: 'pointer' },
                ],
              },
            ],
          },
          {
            role: 'contentinfo',
            ref: 'e18',
            children: [{ role: 'paragraph', text: '© Fixture Corp. Privacy. Terms.', ref: 'e19' }],
          },
        ],
      },
    ]);
    const after = normalizeSnapshot([
      {
        role: 'generic',
        ref: 'e1',
        children: [
          {
            role: 'navigation',
            name: 'Main',
            ref: 'e2',
            children: [
              { role: 'link', name: 'Home', ref: 'e3' },
              { role: 'link', name: 'Sign in', ref: 'e4' },
              { role: 'link', name: 'Help', ref: 'e5' },
            ],
          },
          {
            role: 'main',
            ref: 'e6',
            children: [
              { role: 'heading', name: 'Account setup', level: 1, ref: 'e7' },
              {
                role: 'form',
                ref: 'e8',
                children: [
                  { role: 'generic', text: 'Full name', ref: 'e9' },
                  { role: 'textbox', name: 'Full name', ref: 'e10', text: 'Ada' },
                  { role: 'paragraph', text: 'As it appears on your ID.', ref: 'e11' },
                  { role: 'generic', text: 'Email', ref: 'e12' },
                  { role: 'textbox', name: 'Email', ref: 'e13' },
                  {
                    role: 'paragraph',
                    text: 'We only use this to confirm your account.',
                    ref: 'e14',
                  },
                  { role: 'generic', text: 'City', ref: 'e15' },
                  { role: 'textbox', name: 'City', ref: 'e16' },
                  { role: 'button', name: 'Next', ref: 'e17', cursor: 'pointer' },
                ],
              },
            ],
          },
          {
            role: 'contentinfo',
            ref: 'e18',
            children: [{ role: 'paragraph', text: '© Fixture Corp. Privacy. Terms.', ref: 'e19' }],
          },
        ],
      },
    ]);

    const fullText = renderTree(form);
    const diff = diffSnapshots(
      { roots: form, documentToken: 'd' },
      { roots: after, url: 'http://x/', title: 'T', documentToken: 'd' },
    );
    const diffText = renderDiff(diff, { previousUrl: 'http://x/' });

    // The diff must be under 15% of the full tree's size.
    expect(diffText.length).toBeLessThan(fullText.length * 0.15);
  });
});

describe('pruning', () => {
  it('truncates long text with a marker', () => {
    const result = truncateText('x'.repeat(200), 50);
    expect(result.startsWith('x'.repeat(50))).toBe(true);
    expect(result).toContain('150 more chars');
  });

  it('collapses long runs of identical siblings', () => {
    const children = Array.from({ length: 40 }, (_, i) => ({
      role: 'link',
      name: 'Read more',
      ref: `e${i}`,
    }));
    const pruned = pruneSnapshot([{ role: 'list', children }]);
    const list = pruned.roots[0];
    expect(list?.children?.length).toBeLessThan(children.length);
    expect(list?.children?.some((c) => c.text?.includes('similar items'))).toBe(true);
  });

  it('drops decorative empty wrappers', () => {
    const pruned = pruneSnapshot([{ role: 'generic', children: [{ role: 'generic' }] }]);
    expect(pruned.roots).toHaveLength(0);
  });

  it('keeps semantic nodes', () => {
    const pruned = pruneSnapshot([{ role: 'button', name: 'Go', ref: 'e1' }]);
    expect(pruned.roots).toHaveLength(1);
    expect(pruned.roots[0]?.role).toBe('button');
  });

  it('applies a token budget', () => {
    const big = [
      {
        role: 'list',
        children: Array.from({ length: 200 }, (_, i) => ({
          role: 'listitem',
          name: `Item ${i} with a reasonably long name`,
          ref: `e${i}`,
        })),
      },
    ];
    const pruned = pruneSnapshot(big, { maxTokens: 50 });
    expect(pruned.after).toBeLessThan(countNodes(big));
    expect(estimateTreeTokens(pruned.roots)).toBeLessThanOrEqual(60);
  });
});

describe('refs', () => {
  it('parses plain and frame refs', () => {
    expect(parseRef('e12')).toEqual({ raw: 'e12', elementIndex: 12, isFrame: false });
    expect(parseRef('f2e12')).toEqual({
      raw: 'f2e12',
      frameIndex: 2,
      elementIndex: 12,
      isFrame: true,
    });
    expect(parseRef('nope')).toBeUndefined();
    expect(parseRef('x1')).toBeUndefined();
  });

  it('detects refs', () => {
    expect(isRef('e12')).toBe(true);
    expect(isRef('f2e12')).toBe(true);
    expect(isRef('button')).toBe(false);
  });

  it('tracks known refs', () => {
    const registry = new RefRegistry();
    registry.add('e1', 'button', 'Go');
    expect(registry.has('e1')).toBe(true);
    expect(registry.get('e1')?.role).toBe('button');
    registry.reset();
    expect(registry.has('e1')).toBe(false);
  });
});

describe('tokens', () => {
  it('estimates tokens as characters over four and flags it as an estimate', () => {
    const estimate = estimateTokens('a'.repeat(400));
    expect(estimate.tokens).toBe(100);
    expect(estimate.estimated).toBe(true);
    expect(estimate.method).toBe('chars-per-token');
  });
});
