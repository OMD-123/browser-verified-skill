/**
 * Tests for the run store (M02).
 *
 * The run store writes the artifacts a run leaves behind: the audit log,
 * the per-step snapshot, the screenshot, the state snapshot, the network
 * slice and the final result.
 *
 * These are the files `bv compile`, `bv report` and `bv audit` read, so
 * they are worth testing directly rather than only through the commands
 * that happen to use them.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../../src/core/runstore/store.js';

describe('the run store', () => {
  let dir: string;
  let store: RunStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bv-runstore-'));
    store = new RunStore('run-1', dir);
    await store.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the audit log', async () => {
    await store.audit({ type: 'action', kind: 'click', target: '#a' });

    const entries = await store.readAudit();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.['kind']).toBe('click');
    expect(entries[0]?.['ts']).toBeDefined();
  });

  it('appends to the audit log', async () => {
    await store.audit({ type: 'action', kind: 'click' });
    await store.audit({ type: 'action', kind: 'fill' });

    const entries = await store.readAudit();
    expect(entries).toHaveLength(2);
  });

  it('reads an empty audit log when there is none', async () => {
    expect(await store.readAudit()).toEqual([]);
  });

  it('reads an empty audit log when the file is corrupt', async () => {
    await store.audit({ type: 'action' });
    const path = join(dir, '.bv', 'runs', 'run-1', 'audit.jsonl');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, 'not json\n', 'utf8');

    expect(await store.readAudit()).toEqual([]);
  });

  it('writes the snapshot for a step', async () => {
    const path = await store.writeSnapshot(1, 'main[e1]\n  button[e2]');

    expect(await readFile(path, 'utf8')).toBe('main[e1]\n  button[e2]');
    expect(path).toContain('steps');
    expect(path).toContain('001');
  });

  it('writes the screenshot for a step', async () => {
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const path = await store.writeScreenshot(2, data);

    expect(path.endsWith('screenshot.png')).toBe(true);
    expect((await stat(path)).size).toBe(4);
  });

  it('writes the state snapshot for a step', async () => {
    const path = await store.writeState(3, { cookies: [], localStorage: {} });

    const parsed = JSON.parse(await readFile(path, 'utf8')) as { cookies: unknown[] };
    expect(parsed.cookies).toEqual([]);
  });

  it('writes the network slice for a step', async () => {
    const path = await store.writeNetwork(4, [{ url: 'https://x.test/a' }]);

    const parsed = JSON.parse(await readFile(path, 'utf8')) as { url: string }[];
    expect(parsed[0]?.url).toBe('https://x.test/a');
  });

  it('writes and reads the result', async () => {
    await store.writeResult({
      runId: 'run-1',
      status: 'verified',
      steps: 3,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
    });

    const result = await store.readResult();
    expect(result?.status).toBe('verified');
    expect(result?.steps).toBe(3);
  });

  it('reads no result when there is none', async () => {
    expect(await store.readResult()).toBeUndefined();
  });

  it('writes and reads the recorded IR', async () => {
    const recorded = { version: 1, steps: [{ kind: 'click' }] };
    await store.writeRecorded(recorded);

    expect(await store.readRecorded()).toEqual(recorded);
  });

  it('reads no recorded IR when there is none', async () => {
    expect(await store.readRecorded()).toBeUndefined();
  });

  it('counts the recorded steps', async () => {
    await store.recordStep({
      step: 1,
      action: 'click',
      target: '#a',
      durationMs: 5,
      urlBefore: 'https://x.test/',
      urlAfter: 'https://x.test/',
      ok: true,
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    await store.recordStep({
      step: 2,
      action: 'fill',
      target: '#b',
      durationMs: 7,
      urlBefore: 'https://x.test/',
      urlAfter: 'https://x.test/',
      ok: true,
      timestamp: '2026-01-01T00:00:01.000Z',
    });

    expect(store.stepCount).toBe(2);
  });
});
