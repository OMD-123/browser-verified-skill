/**
 * In-process tests for the CLI command modules.
 *
 * The subprocess tests check the contract from outside; these check each
 * command's own logic, which is what the coverage report was missing.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerProof } from '../../src/cli/commands/proof.js';
import { registerSafety } from '../../src/cli/commands/safety.js';
import { registerQa } from '../../src/cli/commands/qa.js';
import { setRootProgram } from '../../src/cli/helpers.js';
import { connectDaemon, type DaemonClient } from '../../src/core/client.js';
import type { readRun as ReadRunType } from '../../src/core/runstore/store.js';

vi.mock('../../src/core/client.js', () => ({
  connectDaemon: vi.fn(),
}));

vi.mock('../../src/core/runstore/store.js', async () => {
  const actual = await vi.importActual<{
    readRun: typeof ReadRunType;
  }>('../../src/core/runstore/store.js');
  return { ...actual, readRun: vi.fn() };
});

/**
 * A mock daemon client.
 *
 * Only `call` is used by the commands under test; the rest of the client
 * is filled in so the mock satisfies the real type.
 */
function mockClient(payload: unknown): DaemonClient {
  return {
    port: 0,
    health: async () => ({ ok: true }),
    call: vi.fn().mockResolvedValue(payload),
  } as unknown as DaemonClient;
}

const mockedConnect = vi.mocked(connectDaemon);
const { readRun } = await import('../../src/core/runstore/store.js');
const mockedReadRun = vi.mocked(readRun);

/** Captured output. */
interface Captured {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}

/** Run a command in-process and capture what it printed. */
async function run(cwd: string, args: string[]): Promise<Captured> {
  const program = new Command();
  program
    .name('bv')
    .exitOverride()
    .option('--cwd <dir>', 'the working directory')
    .option('--json', 'machine-readable output', false);
  setRootProgram(program);
  registerProof(program);
  registerSafety(program);
  registerQa(program);

  let stdout = '';
  let stderr = '';
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  const originalExit = process.exitCode;

  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  };

  try {
    await program.parseAsync(['--cwd', cwd, ...args], { from: 'user' });
  } catch {
    // Commander throws on a usage error; the output is what matters.
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    process.exitCode = originalExit;
  }

  const exitCode = process.exitCode;
  return {
    stdout,
    stderr,
    exitCode: typeof exitCode === 'number' ? exitCode : undefined,
  };
}

describe('the CLI command modules', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bv-cli-'));
    mockedConnect.mockReset();
    mockedReadRun.mockReset();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // --- bv verify ---------------------------------------------------------

  it('needs a condition file', async () => {
    const result = await run(dir, ['verify']);
    expect(result.stdout).toContain('--condition');
  });

  it('rejects a condition file that is not JSON', async () => {
    await writeFile(join(dir, 'bad.json'), 'not json', 'utf8');
    const result = await run(dir, ['verify', '--condition', 'bad.json']);
    expect(result.stdout).toContain('not valid JSON');
  });

  it('rejects a condition that does not match the schema', async () => {
    await writeFile(join(dir, 'bad.json'), '{"type":"nonsense"}', 'utf8');
    const result = await run(dir, ['verify', '--condition', 'bad.json']);
    expect(result.stdout).toContain('not valid');
  });

  it('verifies a condition that holds', async () => {
    await writeFile(join(dir, 'c.json'), '{"type":"url_matches","pattern":"/x"}', 'utf8');
    mockedConnect.mockResolvedValue(
      mockClient({
        passed: true,
        results: [{ condition: { type: 'url_matches' }, passed: true, reason: 'the url matches' }],
        evidence: [],
        verifiedAt: 'now',
        url: 'http://x/',
        summary: 'VERIFIED',
      }),
    );

    const result = await run(dir, ['verify', '--condition', 'c.json']);
    expect(result.stdout).toContain('VERIFIED');
  });

  it('fails when the condition does not hold', async () => {
    await writeFile(join(dir, 'c.json'), '{"type":"url_matches","pattern":"/x"}', 'utf8');
    mockedConnect.mockResolvedValue(
      mockClient({
        passed: false,
        results: [
          { condition: { type: 'url_matches' }, passed: false, reason: 'it does not match' },
        ],
        evidence: [],
        verifiedAt: 'now',
        url: 'http://y/',
        summary: 'UNVERIFIED',
      }),
    );

    const result = await run(dir, ['verify', '--condition', 'c.json']);
    expect(result.stdout).toContain('UNVERIFIED');
  });

  // --- bv extract --------------------------------------------------------

  it('needs a schema file', async () => {
    const result = await run(dir, ['extract']);
    expect(result.stdout).toContain('--schema');
  });

  it('rejects an unknown format', async () => {
    await writeFile(join(dir, 's.json'), '{"type":"object","properties":{}}', 'utf8');
    const result = await run(dir, ['extract', '--schema', 's.json', '--format', 'xml']);
    expect(result.stdout).toContain('--format must be');
  });

  it('renders an extraction as CSV', async () => {
    await writeFile(
      join(dir, 's.json'),
      '{"type":"object","properties":{"A":{"type":"string"}}}',
      'utf8',
    );
    mockedConnect.mockResolvedValue(
      mockClient({
        fields: { A: { value: 'x', evidence: { url: 'http://x/', verified: true } } },
        order: ['A'],
        extractedAt: 'now',
        url: 'http://x/',
      }),
    );

    const result = await run(dir, ['extract', '--schema', 's.json', '--format', 'csv']);
    expect(result.stdout).toContain('field,value,source,verified');
    expect(result.stdout).toContain('http://x/');
  });

  it('writes an extraction to a file', async () => {
    await writeFile(
      join(dir, 's.json'),
      '{"type":"object","properties":{"A":{"type":"string"}}}',
      'utf8',
    );
    mockedConnect.mockResolvedValue(
      mockClient({
        fields: { A: { value: 'x', evidence: { url: 'http://x/', verified: true } } },
        order: ['A'],
        extractedAt: 'now',
        url: 'http://x/',
      }),
    );

    const result = await run(dir, ['extract', '--schema', 's.json', '--out', 'out.json']);
    expect(result.stdout).toContain('written to');
  });

  // --- bv compile --------------------------------------------------------

  it('compiles a recorded run', async () => {
    mockedReadRun.mockResolvedValue({
      runId: 'r1',
      goal: 'test',
      steps: [
        {
          index: 1,
          kind: 'click',
          locators: [
            { strategy: 'role', value: 'role=button name="Go"', role: 'button', name: 'Go' },
          ],
          params: {},
          pre: { url: 'http://x/' },
          post: { url: 'http://x/' },
          assertions: [],
          durationMs: 1,
          at: 'now',
        },
      ],
      startedAt: 'now',
      finishedAt: 'now',
    });

    const result = await run(dir, ['compile', 'r1']);
    expect(result.stdout).toContain('compiled 1 step');
  });

  it('reports a run with no recording', async () => {
    mockedReadRun.mockRejectedValue(new Error('the run r1 has no recording'));
    const result = await run(dir, ['compile', 'r1']);
    expect(result.stdout).toContain('has no recording');
  });

  // --- bv replay ---------------------------------------------------------

  it('replays a recorded run', async () => {
    mockedReadRun.mockResolvedValue({
      runId: 'r1',
      steps: [],
      startedAt: 'now',
      finishedAt: 'now',
    });
    mockedConnect.mockResolvedValue(
      mockClient({
        ok: true,
        summary: 'Replay succeeded: 0 step(s).',
        healedCount: 0,
        drift: [],
      }),
    );

    const result = await run(dir, ['replay', 'r1']);
    expect(result.stdout).toContain('Replay succeeded');
  });

  it('shows the drift of a replay', async () => {
    mockedReadRun.mockResolvedValue({
      runId: 'r1',
      steps: [],
      startedAt: 'now',
      finishedAt: 'now',
    });
    mockedConnect.mockResolvedValue(
      mockClient({
        ok: true,
        summary: 'Replay succeeded.',
        healedCount: 1,
        drift: [
          { stepIndex: 4, from: '#old', to: 'role=button', unchanged: 'role/name unchanged' },
        ],
      }),
    );

    const result = await run(dir, ['replay', 'r1']);
    expect(result.stdout).toContain('#old');
    expect(result.stdout).toContain('role=button');
  });

  // --- bv memory ---------------------------------------------------------

  it('lists the memory', async () => {
    const result = await run(dir, ['memory', 'ls']);
    expect(result.stdout).toContain('empty');
  });

  it('reports forgetting something that is not there', async () => {
    const result = await run(dir, ['memory', 'rm', 'https://x.test', 'key']);
    expect(result.stdout).toContain('no entry');
  });

  it('prunes the memory', async () => {
    const result = await run(dir, ['memory', 'prune']);
    expect(result.stdout).toContain('expired');
  });

  // --- bv plan -----------------------------------------------------------

  it('sets a plan', async () => {
    mockedConnect.mockResolvedValue(
      mockClient({
        ok: true,
        message: 'plan set: test',
        plan: { goal: 'test' },
      }),
    );

    await writeFile(
      join(dir, 'p.json'),
      JSON.stringify({
        goal: 'test',
        successCondition: { type: 'url_matches', pattern: '/x' },
        allowedOrigins: [],
        allowedActionClasses: [],
        maxSteps: 5,
      }),
      'utf8',
    );

    const result = await run(dir, ['plan', 'set', 'p.json']);
    expect(result.stdout).toContain('plan set');
  });

  it('shows a plan', async () => {
    mockedConnect.mockResolvedValue(
      mockClient({
        ok: true,
        plan: {
          goal: 'shown',
          allowedOrigins: [],
          allowedActionClasses: [],
          maxSteps: 5,
          createdAt: 'now',
          successCondition: { type: 'url_matches', pattern: '/x' },
        },
      }),
    );

    const result = await run(dir, ['plan', 'show']);
    expect(result.stdout).toContain('shown');
  });

  it('approves an action', async () => {
    mockedConnect.mockResolvedValue(
      mockClient({ ok: true, token: 'tok', description: 'an action' }),
    );

    const result = await run(dir, ['approve', 'action-1']);
    expect(result.stdout).toContain('approved');
  });

  it('reports an approval that cannot be issued', async () => {
    mockedConnect.mockResolvedValue(
      mockClient({ ok: false, error: 'no pending action with id action-1' }),
    );

    const result = await run(dir, ['approve', 'action-1']);
    expect(result.stdout).toContain('no pending action');
  });

  // --- bv diff ------------------------------------------------------------

  it('needs both URLs for a diff', async () => {
    const result = await run(dir, ['diff', '--a', 'http://x/']);
    expect(result.stdout).toContain('--b');
  });

  it('reports a diff', async () => {
    // Two pages that differ, served from the fixture server.
    const fixture = process.env['BV_FIXTURE_ORIGIN'] ?? 'http://127.0.0.1:3000';
    const result = await run(dir, [
      'diff',
      '--a',
      `${fixture}/pages/login.html`,
      '--b',
      `${fixture}/pages/index.html`,
    ]);
    expect(result.stdout).toContain('Only in');
  });

  // --- bv report ----------------------------------------------------------

  it('rejects an unknown report format', async () => {
    const result = await run(dir, ['report', 'r1', '--format', 'xml']);
    expect(result.stdout).toContain('--format must be');
  });

  it('reports a run with no findings', async () => {
    const result = await run(dir, ['report', 'no-such-run']);
    expect(result.stdout).toContain('no findings');
  });

  // --- bv audit -----------------------------------------------------------

  it('reports that there are no runs', async () => {
    const result = await run(dir, ['audit']);
    expect(result.stdout).toContain('no runs');
  });

  it('shows the audit log of a run', async () => {
    const result = await run(dir, ['audit', 'some-run']);
    expect(result.stdout).toContain('empty');
  });

  // --- bv rewind ---------------------------------------------------------

  it('needs a step to rewind to', async () => {
    const result = await run(dir, ['rewind']);
    expect(result.stdout).toContain('--to');
  });

  it('rejects a bad step number', async () => {
    const result = await run(dir, ['rewind', '--to', 'x']);
    expect(result.stdout).toContain('step number');
  });

  it('rewinds and says what it could not restore', async () => {
    mockedConnect.mockResolvedValue(
      mockClient({
        branchRunId: 'r1-r2',
        toStep: 2,
        url: 'http://x/',
        storageRestored: true,
        notRestored: ['in-page JavaScript state'],
      }),
    );

    const result = await run(dir, ['rewind', '--to', '2']);
    expect(result.stdout).toContain('r1-r2');
    expect(result.stdout).toContain('Not restored');
    expect(result.stdout).toContain('JavaScript');
  });
});
