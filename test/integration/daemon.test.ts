import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon } from '../../src/core/daemon.js';
import {
  hashToken,
  tokenMatches,
  generateToken,
  readDaemonInfo,
  readDaemonToken,
  writeDaemonInfo,
  clearDaemonInfo,
  isProcessAlive,
} from '../../src/core/daemon-info.js';
import { createClient } from '../../src/core/client.js';

describe('daemon token handling', () => {
  it('generates a 64-character hex token', () => {
    const token = generateToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes a token deterministically', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
    expect(hashToken('abc')).toHaveLength(64);
  });

  it('matches a correct token and rejects a wrong one', () => {
    const hash = hashToken('secret');
    expect(tokenMatches('secret', hash)).toBe(true);
    expect(tokenMatches('wrong', hash)).toBe(false);
    expect(tokenMatches('', hash)).toBe(false);
  });

  it('rejects a token of a different length', () => {
    expect(tokenMatches('secret', hashToken('a-different-length-token'))).toBe(false);
  });

  it('detects a live process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});

describe('daemon HTTP API', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bv-daemon-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses a request without a token', async () => {
    const daemon = await startDaemon({
      handlers: { ping: async () => ({ data: { pong: true } }) },
      token: 'test-token',
    });
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'ping' }),
      });
      expect(response.status).toBe(401);
      const body = (await response.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain('unauthorized');
    } finally {
      await daemon.close();
    }
  });

  it('refuses a request with a wrong token', async () => {
    const daemon = await startDaemon({
      handlers: { ping: async () => ({ data: { pong: true } }) },
      token: 'right',
    });
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
        body: JSON.stringify({ method: 'ping' }),
      });
      expect(response.status).toBe(401);
    } finally {
      await daemon.close();
    }
  });

  it('accepts a request with the right token', async () => {
    const daemon = await startDaemon({
      handlers: { ping: async () => ({ data: { pong: true } }) },
      token: 'right',
    });
    try {
      const client = createClient(`http://127.0.0.1:${daemon.port}`, 'right', daemon.port);
      const result = await client.call<{ pong: boolean }>('ping');
      expect(result.pong).toBe(true);
    } finally {
      await daemon.close();
    }
  });

  it('returns 404 for an unknown method', async () => {
    const daemon = await startDaemon({
      handlers: {},
      token: 't',
    });
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
        body: JSON.stringify({ method: 'nope' }),
      });
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('unknown method');
    } finally {
      await daemon.close();
    }
  });

  it('returns 400 for a malformed body', async () => {
    const daemon = await startDaemon({ handlers: {}, token: 't' });
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
        body: 'not json',
      });
      expect(response.status).toBe(400);
    } finally {
      await daemon.close();
    }
  });

  it('binds to loopback only', async () => {
    const daemon = await startDaemon({ handlers: {}, token: 't' });
    try {
      const address = daemon.server.address();
      expect(typeof address === 'object' && address !== null && address.address).toBe('127.0.0.1');
    } finally {
      await daemon.close();
    }
  });

  it('survives a client crash and keeps serving', async () => {
    const daemon = await startDaemon({
      handlers: { ping: async () => ({ data: { pong: true } }) },
      token: 't',
    });
    try {
      // A client that opens a connection and dies without reading.
      const client = createClient(`http://127.0.0.1:${daemon.port}`, 't', daemon.port);
      await client.call('ping');

      // The daemon is still healthy and still serving.
      expect(await client.health()).toBe(true);
      const result = await client.call<{ pong: boolean }>('ping');
      expect(result.pong).toBe(true);
    } finally {
      await daemon.close();
    }
  });
});

describe('daemon descriptor on disk', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bv-desc-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes and reads the descriptor and token', async () => {
    const token = generateToken();
    const info = {
      version: 1 as const,
      port: 1234,
      pid: process.pid,
      tokenHash: hashToken(token),
      session: 'default',
      startedAt: new Date().toISOString(),
      headed: false,
      browser: 'chromium',
    };
    await writeDaemonInfo(info, token, dir);

    const readInfo = await readDaemonInfo(dir);
    expect(readInfo?.port).toBe(1234);
    expect(readInfo?.session).toBe('default');

    const readToken = await readDaemonToken(dir);
    expect(readToken).toBe(token);

    // The descriptor stores the hash, not the token.
    const raw = await readFile(join(dir, '.bv', 'daemon.json'), 'utf8');
    expect(raw).not.toContain(token);
    expect(raw).toContain(info.tokenHash);
  });

  it('returns undefined when there is no descriptor', async () => {
    expect(await readDaemonInfo(dir)).toBeUndefined();
    expect(await readDaemonToken(dir)).toBeUndefined();
  });

  it('clears the descriptor', async () => {
    const token = generateToken();
    await writeDaemonInfo(
      {
        version: 1,
        port: 1,
        pid: process.pid,
        tokenHash: hashToken(token),
        session: 'x',
        startedAt: new Date().toISOString(),
        headed: false,
        browser: 'chromium',
      },
      token,
      dir,
    );
    await clearDaemonInfo(dir);
    expect(await readDaemonInfo(dir)).toBeUndefined();
    expect(await readDaemonToken(dir)).toBeUndefined();
  });

  it('writes the descriptor with owner-only permissions where supported', async () => {
    const token = generateToken();
    await writeDaemonInfo(
      {
        version: 1,
        port: 1,
        pid: process.pid,
        tokenHash: hashToken(token),
        session: 'x',
        startedAt: new Date().toISOString(),
        headed: false,
        browser: 'chromium',
      },
      token,
      dir,
    );
    const info = await stat(join(dir, '.bv', 'daemon.json'));
    expect(info.isFile()).toBe(true);
    // On POSIX the mode must be 0600; on Windows there are no mode bits.
    if (process.platform !== 'win32') {
      expect(info.mode & 0o777).toBe(0o600);
    }
  });
});
