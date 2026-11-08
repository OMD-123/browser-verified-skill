/**
 * In-process tests for the CLI command modules.
 *
 * The subprocess tests check the contract from outside; these check each
 * command's own logic, which is what the coverage report was missing.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerProof } from '../../src/cli/commands/proof.js';
import { registerSafety } from '../../src/cli/commands/safety.js';
import { registerQa } from '../../src/cli/commands/qa.js';
import { registerSession } from '../../src/cli/commands/session.js';
import { registerPerception } from '../../src/cli/commands/perception.js';
import { setRootProgram } from '../../src/cli/helpers.js';
import { connectDaemon, createApproverClient, type DaemonClient } from '../../src/core/client.js';
import type { readRun as ReadRunType } from '../../src/core/runstore/store.js';

vi.mock('../../src/core/client.js', () => ({
  connectDaemon: vi.fn(),
  createApproverClient: vi.fn(),
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
const mockedApprover = vi.mocked(createApproverClient);
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
  registerSession(program);
  registerPerception(program);

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
    // `bv approve` uses the APPROVER client, not the agent's. The
    // approver client carries the credential the agent never has.
    mockedApprover.mockResolvedValue(
      mockClient({ ok: true, token: 'tok', description: 'an action' }),
    );

    const result = await run(dir, ['approve', 'action-1']);
    expect(result.stdout).toContain('approved');
  });

  it('reports an approval that cannot be issued', async () => {
    mockedApprover.mockResolvedValue(
      mockClient({ ok: false, error: 'no pending action with id action-1' }),
    );

    const result = await run(dir, ['approve', 'action-1']);
    expect(result.stdout).toContain('no pending action');
  });

  it('approves an action with a one-time code', async () => {
    // The code channel needs no credential: the code itself is the
    // human's proof, read from the controlling terminal.
    mockedConnect.mockResolvedValue(
      mockClient({ ok: true, token: 'tok', description: 'an action' }),
    );

    const result = await run(dir, ['approve', 'action-1', '--code', 'ABC234']);
    expect(result.stdout).toContain('approved');
    expect(result.stdout).toContain('tok');
  });

  it('reports a code that is not valid', async () => {
    mockedConnect.mockResolvedValue(
      mockClient({ ok: false, error: 'that code is not valid, or it has expired' }),
    );

    const result = await run(dir, ['approve', 'action-1', '--code', 'ABC234']);
    expect(result.stdout).toContain('not valid');
  });

  it('lists the actions waiting for approval', async () => {
    mockedConnect.mockResolvedValue(
      mockClient({
        waiting: [
          {
            actionId: 'action-1',
            description: 'click Submit',
            code: 'ABC234',
            createdAt: Date.now(),
          },
        ],
      }),
    );

    const result = await run(dir, ['approvals']);
    expect(result.stdout).toContain('ABC234');
    expect(result.stdout).toContain('click Submit');
  });

  it('says nothing is waiting for approval', async () => {
    mockedConnect.mockResolvedValue(mockClient({ waiting: [] }));

    const result = await run(dir, ['approvals']);
    expect(result.stdout).toContain('nothing is waiting');
  });

  // --- bv session ---------------------------------------------------------

  it('says no session is running', async () => {
    // No daemon info file, so there is nothing to stop.
    const result = await run(dir, ['session', 'stop']);
    expect(result.stdout).toContain('no session');
  });

  it('reports that no session is running', async () => {
    const result = await run(dir, ['session', 'status']);
    expect(result.stdout).toContain('no session');
  });

  it('reports the status of a running session', async () => {
    await mkdir(join(dir, '.bv'), { recursive: true });
    await writeFile(
      join(dir, '.bv', 'daemon.json'),
      JSON.stringify({
        port: 12345,
        tokenHash: 'abc',
        pid: process.pid,
        session: 'default',
        headed: true,
        startedAt: '2026-01-01T00:00:00.000Z',
      }),
      'utf8',
    );
    mockedConnect.mockResolvedValue(
      mockClient({
        url: 'https://x.test/',
        title: 'A page',
        userAgent: 'BrowserVerifiedSkill/1.0',
      }),
    );

    const result = await run(dir, ['session', 'status']);
    expect(result.stdout).toContain('running: yes');
    expect(result.stdout).toContain('headed: yes');
    expect(result.stdout).toContain('https://x.test/');
    expect(result.stdout).toContain('A page');
  });

  it('reports a stale session as not running', async () => {
    await mkdir(join(dir, '.bv'), { recursive: true });
    await writeFile(
      join(dir, '.bv', 'daemon.json'),
      JSON.stringify({
        port: 12345,
        tokenHash: 'abc',
        // A pid that cannot be alive.
        pid: 0,
        session: 'default',
        headed: false,
        startedAt: '2026-01-01T00:00:00.000Z',
      }),
      'utf8',
    );

    const result = await run(dir, ['session', 'status']);
    expect(result.stdout).toContain('stale');
  });

  it('clears the state of a stale session when it stops', async () => {
    await mkdir(join(dir, '.bv'), { recursive: true });
    await writeFile(
      join(dir, '.bv', 'daemon.json'),
      JSON.stringify({
        port: 12345,
        tokenHash: 'abc',
        pid: 0,
        session: 'default',
        headed: false,
        startedAt: '2026-01-01T00:00:00.000Z',
      }),
      'utf8',
    );

    const result = await run(dir, ['session', 'stop']);
    expect(result.stdout).toContain('no longer running');
  });

  // --- bv snapshot ---------------------------------------------------------

  it('takes a snapshot', async () => {
    mockedConnect.mockResolvedValue(
      mockClient({
        diff: '+ main[e1]',
        snapshotPath: '/tmp/snapshot.txt',
        estimatedTokens: 12,
        tree: 'main[e1]',
      }),
    );

    const result = await run(dir, ['snapshot']);
    expect(result.stdout).toContain('+ main[e1]');
    expect(result.stdout).toContain('estimated tokens');
  });

  it('takes a full snapshot', async () => {
    mockedConnect.mockResolvedValue(
      mockClient({
        diff: '+ main[e1]',
        snapshotPath: '/tmp/snapshot.txt',
        estimatedTokens: 12,
        tree: 'main[e1]\n  button[e2] Sign in',
      }),
    );

    const result = await run(dir, ['snapshot', '--full']);
    expect(result.stdout).toContain('button[e2]');
  });

  it('rejects a non-positive token budget', async () => {
    const result = await run(dir, ['snapshot', '--max-tokens', '0']);
    expect(result.stdout).toContain('--max-tokens');
  });

  // --- bv act --------------------------------------------------------------

  it('rejects an unknown action kind', async () => {
    const result = await run(dir, ['act', 'teleport', '#a']);
    expect(result.stdout).toContain('unknown action kind');
  });

  it('does a dry run without touching the daemon', async () => {
    const result = await run(dir, ['act', 'click', 'role=button name="Go"', '--dry-run']);
    expect(result.stdout).toContain('dry run');
  });

  it('reports a refusal with its rule ids', async () => {
    mockedConnect.mockResolvedValue(
      mockClient({
        denied: true,
        next: 'off_plan',
        actionClass: 'submit',
        reasons: ['the action is outside the plan'],
        ruleIds: ['plan.off_plan.origin'],
      }),
    );

    const result = await run(dir, ['act', 'click', '#a']);
    expect(result.stdout).toContain('outside the plan');
    expect(result.stdout).toContain('plan.off_plan.origin');
  });

  it('reports an approval that is needed', async () => {
    mockedConnect.mockResolvedValue(
      mockClient({
        denied: true,
        next: 'needs_approval',
        actionClass: 'submit',
        reasons: ['the "submit" action class requires approval'],
        ruleIds: ['policy.approval.required.submit'],
        approvalId: 'action-1',
      }),
    );

    const result = await run(dir, ['act', 'click', '#a']);
    expect(result.stdout).toContain('approval id');
    expect(result.stdout).toContain('action-1');
  });

  // --- bv goto -------------------------------------------------------------

  it('navigates', async () => {
    mockedConnect.mockResolvedValue(
      mockClient({ ok: true, message: 'navigated', url: 'https://x.test/' }),
    );

    const result = await run(dir, ['goto', 'https://x.test/']);
    expect(result.stdout).toContain('navigated');
    expect(result.stdout).toContain('https://x.test/');
  });

  // --- bv tab --------------------------------------------------------------

  it('lists the tabs', async () => {
    mockedConnect.mockResolvedValue(
      mockClient({
        tabs: [
          { index: 0, active: true, title: 'One', url: 'https://one.test/', popup: false },
          { index: 1, active: false, title: '', url: 'https://two.test/', popup: true },
        ],
      }),
    );

    const result = await run(dir, ['tab']);
    expect(result.stdout).toContain('One');
    expect(result.stdout).toContain('[popup]');
  });

  it('says when there are no tabs', async () => {
    mockedConnect.mockResolvedValue(mockClient({ tabs: [] }));

    const result = await run(dir, ['tab']);
    expect(result.stdout).toContain('no tabs');
  });

  it('needs an index to select a tab', async () => {
    const result = await run(dir, ['tab', 'select']);
    expect(result.stdout).toContain('tab index');
  });

  it('rejects an unknown tab action', async () => {
    const result = await run(dir, ['tab', 'frobnicate']);
    expect(result.stdout).toContain('unknown tab action');
  });

  // --- bv research ---------------------------------------------------------

  it('needs a questions file and a sources file', async () => {
    const result = await run(dir, ['research']);
    expect(result.stdout).toContain('--questions');
    expect(result.stdout).toContain('--sources');
  });

  it('rejects a questions file that is not a list', async () => {
    await writeFile(join(dir, 'questions.json'), JSON.stringify('nope'), 'utf8');
    await writeFile(join(dir, 'sources.txt'), 'https://x.test/\n', 'utf8');
    const result = await run(dir, [
      'research',
      '--questions',
      'questions.json',
      '--sources',
      'sources.txt',
    ]);
    expect(result.stdout).toContain('questions file must be a list');
  });

  it('rejects a question that is neither a string nor an object', async () => {
    await writeFile(join(dir, 'questions.json'), JSON.stringify([42]), 'utf8');
    await writeFile(join(dir, 'sources.txt'), 'https://x.test/\n', 'utf8');
    const result = await run(dir, [
      'research',
      '--questions',
      'questions.json',
      '--sources',
      'sources.txt',
    ]);
    expect(result.stdout).toContain('every question must be a string');
  });

  it('rejects an object with no question field', async () => {
    await writeFile(join(dir, 'questions.json'), JSON.stringify([{ id: 'a' }]), 'utf8');
    await writeFile(join(dir, 'sources.txt'), 'https://x.test/\n', 'utf8');
    const result = await run(dir, [
      'research',
      '--questions',
      'questions.json',
      '--sources',
      'sources.txt',
    ]);
    expect(result.stdout).toContain('every question must be a string');
  });

  it('accepts a list of plain strings', async () => {
    await writeFile(join(dir, 'questions.json'), JSON.stringify(['what is it?']), 'utf8');
    await writeFile(join(dir, 'sources.txt'), 'https://x.test/\n', 'utf8');
    const result = await run(dir, [
      'research',
      '--questions',
      'questions.json',
      '--sources',
      'sources.txt',
    ]);
    // It gets past the parsing, so the failure is about the source rather
    // than the questions.
    expect(result.stdout).not.toContain('questions file must be a list');
    expect(result.stdout).not.toContain('every question must be a string');
  });

  it('accepts an object with a questions list', async () => {
    await writeFile(
      join(dir, 'questions.json'),
      JSON.stringify({ questions: [{ question: 'what is it?', id: 'q1' }] }),
      'utf8',
    );
    await writeFile(join(dir, 'sources.txt'), 'https://x.test/\n', 'utf8');
    const result = await run(dir, [
      'research',
      '--questions',
      'questions.json',
      '--sources',
      'sources.txt',
    ]);
    expect(result.stdout).not.toContain('questions file must be a list');
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

  // --- bv test ------------------------------------------------------------

  it('needs a suite file', async () => {
    const result = await run(dir, ['test']);
    expect(result.stdout).toContain('--suite');
  });

  it('rejects a suite file that is not JSON', async () => {
    await writeFile(join(dir, 'suite.json'), 'not json', 'utf8');
    const result = await run(dir, ['test', '--suite', 'suite.json']);
    expect(result.stdout).toContain('not valid JSON');
  });

  it('rejects a suite with no name', async () => {
    await writeFile(join(dir, 'suite.json'), JSON.stringify({ checks: [] }), 'utf8');
    const result = await run(dir, ['test', '--suite', 'suite.json']);
    expect(result.stdout).toContain('needs a "name"');
  });

  it('runs a suite', async () => {
    const fixture = process.env['BV_FIXTURE_ORIGIN'] ?? 'http://127.0.0.1:3000';
    const suite = {
      name: 'a suite',
      checks: [
        {
          name: 'the index loads',
          url: `${fixture}/pages/index.html`,
          expect: { type: 'url_matches', pattern: '/pages/index' },
        },
      ],
    };
    await writeFile(join(dir, 'suite.json'), JSON.stringify(suite), 'utf8');

    const result = await run(dir, ['test', '--suite', 'suite.json']);
    expect(result.stdout).toContain('1/1 passed');
  });

  it('reports a failing check', async () => {
    const fixture = process.env['BV_FIXTURE_ORIGIN'] ?? 'http://127.0.0.1:3000';
    const suite = {
      name: 'a suite',
      checks: [
        {
          name: 'a check that cannot pass',
          url: `${fixture}/pages/index.html`,
          expect: { type: 'text_visible', text: 'not on the page' },
        },
      ],
    };
    await writeFile(join(dir, 'suite.json'), JSON.stringify(suite), 'utf8');

    const result = await run(dir, ['test', '--suite', 'suite.json']);
    expect(result.stdout).toContain('a check that cannot pass');
  });

  it('writes the result to a file', async () => {
    const fixture = process.env['BV_FIXTURE_ORIGIN'] ?? 'http://127.0.0.1:3000';
    const suite = {
      name: 'a suite',
      checks: [
        {
          name: 'the index loads',
          url: `${fixture}/pages/index.html`,
          expect: { type: 'url_matches', pattern: '/pages/index' },
        },
      ],
    };
    await writeFile(join(dir, 'suite.json'), JSON.stringify(suite), 'utf8');

    await run(dir, ['test', '--suite', 'suite.json', '--out', 'out/result.txt']);
    const written = await readFile(join(dir, 'out', 'result.txt'), 'utf8');
    expect(written).toContain('1/1 passed');
  });

  it('filters by tag', async () => {
    const fixture = process.env['BV_FIXTURE_ORIGIN'] ?? 'http://127.0.0.1:3000';
    const suite = {
      name: 'a suite',
      checks: [
        {
          name: 'a smoke check',
          url: `${fixture}/pages/index.html`,
          expect: { type: 'url_matches', pattern: '/pages/index' },
          tags: ['smoke'],
        },
        {
          name: 'a slow check',
          url: `${fixture}/pages/login.html`,
          expect: { type: 'url_matches', pattern: '/pages/login' },
          tags: ['slow'],
        },
      ],
    };
    await writeFile(join(dir, 'suite.json'), JSON.stringify(suite), 'utf8');

    const result = await run(dir, ['test', '--suite', 'suite.json', '--tag', 'smoke']);
    expect(result.stdout).toContain('1/1 passed');
  });

  // --- bv redteam ---------------------------------------------------------

  it('rejects an unknown redteam action', async () => {
    const result = await run(dir, ['redteam', 'attack']);
    expect(result.stdout).toContain('unknown redteam action');
  });

  it('runs the red-team catalogue', async () => {
    const result = await run(dir, ['redteam', 'run']);
    expect(result.stdout).toContain('attack(s) were caught');
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
