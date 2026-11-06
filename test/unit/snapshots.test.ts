/**
 * Tests for the time-travel snapshots (M14).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSnapshots,
  findSnapshot,
  planRewind,
  redactCookie,
  NOT_RESTORED,
  type StepSnapshot,
} from '../../src/compile/snapshots.js';

describe('the snapshot reader', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bv-snapshots-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Write a step's state file. */
  async function writeStep(
    runId: string,
    step: number,
    state: Record<string, unknown>,
  ): Promise<void> {
    const stepDir = join(dir, '.bv', 'runs', runId, 'steps', String(step).padStart(3, '0'));
    await mkdir(stepDir, { recursive: true });
    await writeFile(join(stepDir, 'state.json'), JSON.stringify(state), 'utf8');
  }

  it('returns nothing when there is no run', async () => {
    expect(await readSnapshots('nope', dir)).toEqual([]);
  });

  it('reads the snapshots of a run', async () => {
    await writeStep('r1', 1, { url: 'http://x/', capturedAt: 'now' });
    await writeStep('r1', 2, { url: 'http://x/done', capturedAt: 'later' });
    const snapshots = await readSnapshots('r1', dir);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.url).toBe('http://x/');
    expect(snapshots[1]?.url).toBe('http://x/done');
  });

  it('skips a step with no state file', async () => {
    await writeStep('r1', 1, { url: 'http://x/' });
    await mkdir(join(dir, '.bv', 'runs', 'r1', 'steps', '002'), { recursive: true });
    expect(await readSnapshots('r1', dir)).toHaveLength(1);
  });

  it('finds the snapshot for a step', async () => {
    await writeStep('r1', 3, { url: 'http://x/three' });
    const snapshot = await findSnapshot('r1', 3, dir);
    expect(snapshot?.url).toBe('http://x/three');
  });

  it('returns undefined for a step with no snapshot', async () => {
    expect(await findSnapshot('r1', 99, dir)).toBeUndefined();
  });

  it('reads the cookies', async () => {
    await writeStep('r1', 1, {
      url: 'http://x/',
      cookies: [{ name: 'session', value: 'secret', domain: 'x' }],
    });
    const snapshot = await findSnapshot('r1', 1, dir);
    expect(snapshot?.cookies?.[0]?.name).toBe('session');
  });

  it('reads the storage hash', async () => {
    await writeStep('r1', 1, { url: 'http://x/', storageHash: 'abc123' });
    expect((await findSnapshot('r1', 1, dir))?.storageHash).toBe('abc123');
  });
});

describe('the rewind plan', () => {
  /** A snapshot with everything. */
  const snapshot: StepSnapshot = {
    step: 2,
    url: 'http://x/page',
    ariaPath: '/tmp/aria.txt',
    statePath: '/tmp/state.json',
    capturedAt: 'now',
  };

  it('plans to go to the step URL', () => {
    expect(planRewind(snapshot, 2).url).toBe('http://x/page');
  });

  it('says the storage state is restored when there is one', () => {
    expect(planRewind(snapshot, 2).storageRestored).toBe(true);
  });

  it('says the storage state is not restored when there is none', () => {
    const withoutState: StepSnapshot = {
      step: snapshot.step,
      url: snapshot.url,
      ariaPath: snapshot.ariaPath,
      capturedAt: snapshot.capturedAt,
    };
    expect(planRewind(withoutState, 2).storageRestored).toBe(false);
  });

  it('lists what cannot be restored', () => {
    const plan = planRewind(snapshot, 2);
    expect(plan.notRestored).toEqual([...NOT_RESTORED]);
  });

  it('says the JavaScript state cannot be restored', () => {
    expect(planRewind(snapshot, 2).notRestored.join(' ')).toContain('JavaScript');
  });

  it('says the server state cannot be restored', () => {
    expect(planRewind(snapshot, 2).notRestored.join(' ')).toContain('server-side');
  });

  it('handles a step with no snapshot', () => {
    const plan = planRewind(undefined, 5);
    expect(plan.url).toBe('');
    expect(plan.storageRestored).toBe(false);
    expect(plan.notRestored.join(' ')).toContain('has no snapshot');
  });
});

describe('the cookie redaction', () => {
  it('masks the value but keeps the name and domain', () => {
    const redacted = redactCookie({ name: 'session', value: 'secret', domain: 'example.test' });
    expect(redacted.name).toBe('session');
    expect(redacted.domain).toBe('example.test');
    expect(redacted.value).toBe('[REDACTED]');
  });
});
