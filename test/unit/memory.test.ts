/**
 * Tests for the site memory (M16).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Playbooks,
  originOf,
  renderPlaybooks,
  DEFAULT_TTL_DAYS,
} from '../../src/memory/playbooks.js';

describe('the playbook store', () => {
  let dir: string;
  let playbooks: Playbooks;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bv-playbooks-'));
    playbooks = new Playbooks(dir);
  });

  afterEach(async () => {
    playbooks.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('starts empty', () => {
    expect(playbooks.count()).toBe(0);
  });

  it('remembers an entry', () => {
    playbooks.remember('https://example.test', 'selector:login', 'role=button name="Sign in"');
    expect(playbooks.count()).toBe(1);
  });

  it('recalls an entry', () => {
    playbooks.remember('https://example.test', 'selector:login', 'role=button name="Sign in"');
    const entry = playbooks.recall('https://example.test', 'selector:login');
    expect(entry?.value).toBe('role=button name="Sign in"');
  });

  it('returns undefined for an unknown entry', () => {
    expect(playbooks.recall('https://example.test', 'nope')).toBeUndefined();
  });

  it('returns undefined for an entry of another origin', () => {
    playbooks.remember('https://a.test', 'k', 'v');
    expect(playbooks.recall('https://b.test', 'k')).toBeUndefined();
  });

  it('raises the confidence when an entry is remembered again', () => {
    playbooks.remember('https://example.test', 'k', 'v');
    const first = playbooks.recall('https://example.test', 'k');
    playbooks.remember('https://example.test', 'k', 'v');
    const second = playbooks.recall('https://example.test', 'k');
    expect(second?.confidence).toBeGreaterThan(first?.confidence ?? 0);
  });

  it('never raises the confidence above one', () => {
    for (let i = 0; i < 20; i++) {
      playbooks.remember('https://example.test', 'k', 'v');
    }
    expect(playbooks.recall('https://example.test', 'k')?.confidence).toBe(1);
  });

  it('updates the value when an entry is remembered again', () => {
    playbooks.remember('https://example.test', 'k', 'old');
    playbooks.remember('https://example.test', 'k', 'new');
    expect(playbooks.recall('https://example.test', 'k')?.value).toBe('new');
  });

  it('lowers the confidence on a failure', () => {
    playbooks.remember('https://example.test', 'k', 'v');
    const before = playbooks.recall('https://example.test', 'k')?.confidence ?? 0;
    const after = playbooks.recordFailure('https://example.test', 'k');
    expect(after?.confidence).toBeLessThan(before);
  });

  it('forgets an entry whose confidence runs out', () => {
    playbooks.remember('https://example.test', 'k', 'v');
    // Four failures take the confidence from 0.6 to below zero.
    for (let i = 0; i < 5; i++) playbooks.recordFailure('https://example.test', 'k');
    expect(playbooks.recall('https://example.test', 'k')).toBeUndefined();
    expect(playbooks.count()).toBe(0);
  });

  it('records a failure for an unknown entry', () => {
    expect(playbooks.recordFailure('https://example.test', 'nope')).toBeUndefined();
  });

  it('forgets an entry', () => {
    playbooks.remember('https://example.test', 'k', 'v');
    expect(playbooks.forget('https://example.test', 'k')).toBe(true);
    expect(playbooks.forget('https://example.test', 'k')).toBe(false);
  });

  it('lists every entry', () => {
    playbooks.remember('https://a.test', 'k1', 'v1');
    playbooks.remember('https://b.test', 'k2', 'v2');
    expect(playbooks.list()).toHaveLength(2);
  });

  it('lists the entries of one origin', () => {
    playbooks.remember('https://a.test', 'k1', 'v1');
    playbooks.remember('https://b.test', 'k2', 'v2');
    expect(playbooks.list('https://a.test')).toHaveLength(1);
  });

  it('prunes the expired entries', async () => {
    const shortLived = new Playbooks(dir, { ttlDays: 0 });
    shortLived.remember('https://example.test', 'k', 'v');
    const pruned = shortLived.prune();
    shortLived.close();
    expect(pruned).toBeGreaterThan(0);
  });

  it('does not return an expired entry', () => {
    const shortLived = new Playbooks(dir, { ttlDays: 0 });
    shortLived.remember('https://example.test', 'k', 'v');
    expect(shortLived.recall('https://example.test', 'k')).toBeUndefined();
    shortLived.close();
  });

  it('clears every entry', () => {
    playbooks.remember('https://example.test', 'k', 'v');
    playbooks.clear();
    expect(playbooks.count()).toBe(0);
  });

  it('persists across instances', async () => {
    playbooks.remember('https://example.test', 'k', 'v');
    playbooks.close();

    const second = new Playbooks(dir);
    expect(second.recall('https://example.test', 'k')?.value).toBe('v');
    second.close();
  });

  it('uses a default lifetime of thirty days', () => {
    expect(DEFAULT_TTL_DAYS).toBe(30);
    playbooks.remember('https://example.test', 'k', 'v');
    const entry = playbooks.recall('https://example.test', 'k');
    const days = (Date.parse(entry?.expiresAt ?? '') - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });
});

describe('the origin helper', () => {
  it('extracts the origin', () => {
    expect(originOf('https://example.test/a/b?c=1')).toBe('https://example.test');
  });

  it('handles a value that is not a URL', () => {
    expect(originOf('not a url')).toBe('not a url');
  });
});

describe('the playbook report', () => {
  it('says the playbook is empty', () => {
    expect(renderPlaybooks([])).toContain('empty');
  });

  it('renders each entry', () => {
    const text = renderPlaybooks([
      {
        origin: 'https://example.test',
        key: 'selector:login',
        value: 'role=button',
        confidence: 0.9,
        lastVerifiedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-02-01T00:00:00.000Z',
      },
    ]);
    expect(text).toContain('https://example.test');
    expect(text).toContain('selector:login');
    expect(text).toContain('0.90');
  });
});
