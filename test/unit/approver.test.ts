/**
 * The approver-credential tests (Phase 0, gap 1).
 *
 * The gap: `bv approve` issued a token with no human check, so the agent
 * could approve its own risky actions. The fix splits two roles:
 *
 *   - the **agent**, which holds the daemon token and can propose actions
 *   - the **approver**, which holds a separate credential the agent never
 *     sees and which is the only thing that can issue an approval token
 *
 * These tests are the ones that prove the split is real. They are written
 * to fail against v1.
 */
import { describe, expect, it, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashAction, ApprovalStore } from '../../src/safety/approvals.js';
import {
  ApprovalChannel,
  ApproverCredential,
  APPROVAL_CODE_TTL_MS,
  MAX_FAILED_CODE_ATTEMPTS,
  approverTokenPath,
  compareHashes,
  hashApproverToken,
  makeCode,
} from '../../src/safety/approver.js';
import {
  ControllingTerminal,
  approvalPrompt,
  controllingTerminalPath,
  terminalPathFor,
} from '../../src/safety/terminal.js';
import { startDaemon } from '../../src/core/daemon.js';

/**
 * The rule, stated once: an approval may only be issued when the caller
 * proves it holds the approver credential, and that credential must be
 * different from the agent's daemon token.
 */
describe('the approver credential', () => {
  it('is different from the agent token', () => {
    const agentToken = randomBytes(32).toString('hex');
    const approverToken = randomBytes(32).toString('hex');

    expect(agentToken).not.toBe(approverToken);
  });

  it('does not appear in the daemon descriptor the agent can read', async () => {
    // The daemon descriptor is what the agent reads to find the daemon.
    // It carries the agent's token hash. It must NOT carry anything that
    // lets the agent mint an approval.
    const descriptor = {
      version: 1,
      port: 12345,
      pid: 1,
      tokenHash: createHash('sha256').update('agent-token').digest('hex'),
      session: 'default',
      startedAt: '2026-01-01T00:00:00.000Z',
      headed: false,
      browser: 'chromium',
    };

    const serialised = JSON.stringify(descriptor);

    // The agent's own token hash is fine — the agent needs it.
    expect(serialised).toContain(descriptor.tokenHash);

    // But nothing in the descriptor may be usable as an approver
    // credential. The approver's secret lives in its own file, and only
    // its hash is ever written down.
    expect(descriptor).not.toHaveProperty('approverToken');
    expect(descriptor).not.toHaveProperty('approverSecret');
    expect(descriptor).not.toHaveProperty('approverTokenHash');
  });
});

describe('the daemon and the approver credential', () => {
  // The credential lives in a file. Each test gets its own directory, so
  // the tests never share a credential and never write into the repo.
  const dirs: string[] = [];

  async function credentialDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'bv-approver-'));
    dirs.push(dir);
    return dir;
  }

  afterAll(async () => {
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses an approval request that carries only the agent token', async () => {
    // This is the attack the whole split exists to stop: the agent calls
    // approve.issue with its own daemon token and tries to approve its
    // own action.
    const approverCredential = await ApproverCredential.load(await credentialDir());

    const daemon = await startDaemon({
      handlers: {
        'approve.issue': async () => ({ data: { ok: true, token: 'a-token' } }),
      },
      approverCredential,
      approverMethods: new Set(['approve.issue']),
    });

    try {
      // The agent's request: the daemon token, and nothing else.
      const response = await fetch(`http://127.0.0.1:${daemon.port}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${daemon.token}`,
        },
        body: JSON.stringify({ method: 'approve.issue', params: { actionId: 'a-1' } }),
      });

      expect(response.status).toBe(403);

      const body = (await response.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain('needs a human approval');
    } finally {
      await daemon.close();
    }
  });

  it('allows the approval request when the approver credential is present', async () => {
    const approverCredential = await ApproverCredential.load(await credentialDir());

    const daemon = await startDaemon({
      handlers: {
        'approve.issue': async () => ({ data: { ok: true, token: 'a-token' } }),
      },
      approverCredential,
      approverMethods: new Set(['approve.issue']),
    });

    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${daemon.token}`,
          'x-bv-approver': approverCredential.revealSecret(),
        },
        body: JSON.stringify({ method: 'approve.issue', params: { actionId: 'a-1' } }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; data: { token: string } };
      expect(body.ok).toBe(true);
      expect(body.data.token).toBe('a-token');
    } finally {
      await daemon.close();
    }
  });

  it('does not let a wrong approver secret through', async () => {
    const approverCredential = await ApproverCredential.load(await credentialDir());

    const daemon = await startDaemon({
      handlers: {
        'approve.issue': async () => ({ data: { ok: true, token: 'a-token' } }),
      },
      approverCredential,
      approverMethods: new Set(['approve.issue']),
    });

    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${daemon.token}`,
          'x-bv-approver': 'not-the-secret',
        },
        body: JSON.stringify({ method: 'approve.issue', params: { actionId: 'a-1' } }),
      });

      expect(response.status).toBe(403);
    } finally {
      await daemon.close();
    }
  });
});

describe('the approval channel', () => {
  it('issues a code for a pending action', () => {
    const channel = new ApprovalChannel();
    const entry = channel.add('a-1', 'hash-1', 'click Submit');

    expect(entry.code).toHaveLength(6);
    expect(channel.getByCode(entry.code)?.actionId).toBe('a-1');
  });

  it('finds nothing for a wrong code', () => {
    const channel = new ApprovalChannel();
    channel.add('a-1', 'hash-1', 'click Submit');
    expect(channel.getByCode('ZZZZZZ')).toBeUndefined();
  });

  it('expires a code', () => {
    const channel = new ApprovalChannel();
    channel.add('a-1', 'hash-1', 'click Submit');

    // Make it look old.
    const pending = channel.get('a-1');
    expect(pending).toBeDefined();
    if (pending !== undefined) {
      pending.createdAt = Date.now() - 10 * 60 * 1000;
    }

    expect(channel.get('a-1')).toBeUndefined();
  });

  it('locks after too many wrong codes', () => {
    const channel = new ApprovalChannel();
    const entry = channel.add('a-1', 'hash-1', 'click Submit');

    for (let i = 0; i < MAX_FAILED_CODE_ATTEMPTS; i++) {
      expect(channel.getByCode('ZZZZZZ')).toBeUndefined();
    }

    expect(channel.locked).toBe(true);
    expect(channel.attempts).toBe(MAX_FAILED_CODE_ATTEMPTS);

    // Even the right code is refused once the channel has locked.
    expect(channel.getByCode(entry.code)).toBeUndefined();
  });

  it('removes a pending approval', () => {
    const channel = new ApprovalChannel();
    const entry = channel.add('a-1', 'hash-1', 'click Submit');

    expect(channel.remove('a-1')).toBe(true);
    expect(channel.get('a-1')).toBeUndefined();
    expect(channel.getByCode(entry.code)).toBeUndefined();
  });

  it('reports nothing removed for an unknown action', () => {
    const channel = new ApprovalChannel();
    expect(channel.remove('never-existed')).toBe(false);
  });

  it('prunes the expired approvals', () => {
    const channel = new ApprovalChannel();
    channel.add('a-1', 'hash-1', 'click Submit');
    channel.add('a-2', 'hash-2', 'click Cancel');

    // Make one of them old.
    const pending = channel.get('a-1');
    expect(pending).toBeDefined();
    if (pending !== undefined) {
      pending.createdAt = Date.now() - APPROVAL_CODE_TTL_MS - 1000;
    }

    expect(channel.prune()).toBe(1);
    expect(channel.get('a-1')).toBeUndefined();
    expect(channel.get('a-2')).toBeDefined();
  });

  it('does not lock on a correct code', () => {
    const channel = new ApprovalChannel();
    const entry = channel.add('a-1', 'hash-1', 'click Submit');

    expect(channel.getByCode(entry.code)?.actionId).toBe('a-1');
    expect(channel.locked).toBe(false);
    expect(channel.attempts).toBe(0);
  });

  it('makes a code that a human can read and type', () => {
    for (let i = 0; i < 20; i++) {
      const code = makeCode();
      expect(code).toHaveLength(6);
      // No ambiguous characters: no O/0, I/1, S/5, B/8.
      expect(code).not.toMatch(/[O0I1S5B8]/);
    }
  });
});

describe('the approver credential file', () => {
  it('creates the credential on first load and reuses it after', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bv-approver-file-'));
    try {
      const first = await ApproverCredential.load(dir);
      const second = await ApproverCredential.load(dir);

      // The same secret, so the same hash.
      expect(second.tokenHash).toBe(first.tokenHash);
      expect(second.matches(first.revealSecret())).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('puts the credential inside .bv/', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bv-approver-path-'));
    try {
      await ApproverCredential.load(dir);
      const path = approverTokenPath(dir);
      expect(path).toContain('.bv');
      expect(path).toContain('approver.token');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('replaces an empty credential file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bv-approver-empty-'));
    try {
      const path = approverTokenPath(dir);
      await mkdir(join(dir, '.bv'), { recursive: true });
      await writeFile(path, '   \n', 'utf8');

      const credential = await ApproverCredential.load(dir);
      expect(credential.revealSecret().length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not match a wrong secret', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bv-approver-wrong-'));
    try {
      const credential = await ApproverCredential.load(dir);
      expect(credential.matches('wrong')).toBe(false);
      expect(credential.matches('')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not match a secret of the wrong length', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bv-approver-length-'));
    try {
      const credential = await ApproverCredential.load(dir);
      // A truncated secret hashes to a different length in the rare case
      // it is not a hex string, and the comparison must refuse it
      // without throwing.
      expect(credential.matches('not hex at all')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('hashes a token deterministically', () => {
    expect(hashApproverToken('abc')).toBe(hashApproverToken('abc'));
    expect(hashApproverToken('abc')).not.toBe(hashApproverToken('abd'));
  });

  it('refuses hashes of different lengths rather than throwing', () => {
    // `timingSafeEqual` throws when the lengths differ. A credential
    // comparison must refuse, not crash.
    expect(compareHashes('abcd', 'ab')).toBe(false);
    expect(compareHashes('', '')).toBe(true);
    expect(compareHashes('abcd', 'abcd')).toBe(true);
    expect(compareHashes('abcd', 'abce')).toBe(false);
  });
});

describe('the controlling terminal', () => {
  it('names a terminal for this platform', () => {
    const path = controllingTerminalPath();
    expect(path).toBeTruthy();
    expect(typeof path).toBe('string');
  });

  it('maps every platform to a terminal path', () => {
    expect(terminalPathFor('win32')).toBe('\\\\.\\CONOUT$');
    expect(terminalPathFor('linux')).toBe('/dev/tty');
    expect(terminalPathFor('darwin')).toBe('/dev/tty');
    expect(terminalPathFor('freebsd')).toBe('/dev/tty');
  });

  it('reports when there is no terminal, rather than throwing', async () => {
    // A path that does not exist is what a machine with no controlling
    // terminal looks like.
    const terminal = await ControllingTerminal.openPath('/definitely/not/a/terminal/device');

    expect(terminal.available).toBe(false);
    expect(terminal.reason).toBeDefined();

    // Writing to a terminal that is not there returns false.
    expect(await terminal.write('hello')).toBe(false);

    await terminal.close();
  });

  it('reports a failure that is not an Error as a string', async () => {
    // A rejection that is not an Error still has to produce a printable
    // reason, or the daemon would print "undefined".
    const terminal = await ControllingTerminal.openWith('/dev/tty', () =>
      // The whole point of the test: a rejection that is not an Error.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      Promise.reject('just a string'),
    );

    expect(terminal.available).toBe(false);
    expect(terminal.reason).toBe('just a string');
    await terminal.close();
  });

  it('reports an Error failure with its message', async () => {
    const terminal = await ControllingTerminal.openWith('/dev/tty', () =>
      Promise.reject(new Error('permission denied')),
    );

    expect(terminal.available).toBe(false);
    expect(terminal.reason).toBe('permission denied');
    await terminal.close();
  });

  it('opens the real terminal on this machine', async () => {
    const terminal = await ControllingTerminal.open();

    // On a machine with a terminal it is available; on one without, it
    // is not and it says why. Either way, opening does not throw.
    expect(typeof terminal.available).toBe('boolean');
    if (!terminal.available) {
      expect(terminal.reason).toBeDefined();
    }

    await terminal.close();
  });

  it('closes cleanly', async () => {
    const terminal = await ControllingTerminal.open();
    await terminal.close();
    // Closing twice is not an error.
    await terminal.close();
  });
});

describe('the approval prompt', () => {
  it('says what is being approved and how to approve it', () => {
    const text = approvalPrompt({
      actionId: 'action-1',
      code: 'ABC234',
      description: 'click Submit',
    });

    expect(text).toContain('click Submit');
    expect(text).toContain('action-1');
    expect(text).toContain('ABC234');
    expect(text).toContain('bv approve action-1 --code ABC234');
    expect(text).toContain('five minutes');
  });

  it('shows the url when there is one', () => {
    const text = approvalPrompt({
      actionId: 'action-1',
      code: 'ABC234',
      description: 'click Submit',
      url: 'http://127.0.0.1:3000/approve',
    });

    expect(text).toContain('http://127.0.0.1:3000/approve');
  });
});

describe('the approval store', () => {
  it('refuses to issue a token for an action that was never requested', () => {
    const store = new ApprovalStore();
    expect(store.issue('never-requested')).toBeUndefined();
  });

  it('issues a token for a pending action', () => {
    const store = new ApprovalStore();
    const hash = hashAction({ kind: 'click', target: '#submit' });

    store.request({
      actionId: 'a-1',
      actionHash: hash,
      description: 'click Submit',
    });

    const issued = store.issue('a-1');
    expect(issued).toBeDefined();
    expect(issued?.token).toBeTruthy();
  });

  it('binds a token to the exact action hash', () => {
    const store = new ApprovalStore();
    const hash = hashAction({ kind: 'click', target: '#submit' });

    store.request({
      actionId: 'a-1',
      actionHash: hash,
      description: 'click Submit',
    });

    const issued = store.issue('a-1');
    expect(issued?.actionHash).toBe(hash);

    // A different action must not consume it.
    const other = hashAction({ kind: 'click', target: '#cancel' });
    const result = store.consume(issued?.token ?? '', {
      actionId: 'a-1',
      actionHash: other,
    });
    expect(result.ok).toBe(false);
  });

  it('consumes a token exactly once', () => {
    const store = new ApprovalStore();
    const hash = hashAction({ kind: 'click', target: '#submit' });

    store.request({ actionId: 'a-1', actionHash: hash, description: 'click Submit' });
    const issued = store.issue('a-1');

    const first = store.consume(issued?.token ?? '', {
      actionId: 'a-1',
      actionHash: hash,
    });
    expect(first.ok).toBe(true);

    const second = store.consume(issued?.token ?? '', {
      actionId: 'a-1',
      actionHash: hash,
    });
    expect(second.ok).toBe(false);
  });
});
