/**
 * The end-to-end MCP test.
 *
 * This starts a real daemon with a real browser and drives it through the
 * MCP protocol. It is the test that proves the claim in the README: the
 * MCP path runs the same policy engine, so an agent cannot get to an
 * action the CLI would refuse.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon, type DaemonHandler } from '../../src/core/daemon.js';
import { createHandlers, type DaemonContext } from '../../src/core/daemon-process.js';
import { RunStore } from '../../src/core/runstore/store.js';
import { BrowserSession } from '../../src/core/session.js';
import { validatePolicy, type Policy } from '../../src/safety/policy.js';
import { PlanLock } from '../../src/safety/planlock.js';
import { ApprovalStore } from '../../src/safety/approvals.js';
import { InjectionScanner } from '../../src/safety/injection/detectors.js';
import { Recorder } from '../../src/compile/recorder.js';
import { McpServer, toolResult, type McpToolRegistry } from '../../src/mcp/server.js';

/** The fixture server's base URL. */
const FIXTURE = process.env['BV_FIXTURE_ORIGIN'] ?? 'http://127.0.0.1:3000';

/** A permissive policy that still needs approval for a submit. */
function policy(): Policy {
  return validatePolicy({
    version: 1,
    domains: { allow: [], deny: [] },
    ownedOrigins: [],
    actionClasses: { approvalRequired: ['submit', 'destructive'], deny: [] },
  });
}

describe('the MCP server against a real daemon', () => {
  let dir: string;
  let server: { close: () => Promise<void> };
  let session: BrowserSession;
  let mcp: McpServer;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bv-mcp-'));
    const store = new RunStore('mcp-run', dir);
    await store.init();

    session = new BrowserSession({
      store,
      userAgent: 'BrowserVerifiedSkill/1.0 (+@url:`https://example.test/contact`)',
      // Headless. A CI runner has no display, so a headed browser cannot
      // launch there. The approval path this test exercises works in a
      // headless session too: the action is refused with an approval id,
      // and the operator approves it out of band.
      headed: false,
    });
    await session.launch();

    const planLock = new PlanLock();
    const approvals = new ApprovalStore();
    const recorder = new Recorder('mcp-run');

    const context: DaemonContext = {
      runId: 'mcp-run',
      store,
      cwd: dir,
      // A headless session asks for an approval rather than denying
      // outright, so the action is refused with an approval id. That is
      // the path the MCP test needs to exercise.
      headed: false,
      policy: policy(),
      planLock,
      approvals,
      scanner: new InjectionScanner(),
      recorder,
      getSession: async () => session,
    };

    const handlers: Record<string, DaemonHandler> = createHandlers(context);
    server = await startDaemon({ handlers, token: 'mcp-test-token' });

    // The MCP server, wired to the daemon the same way `bv mcp` wires it.
    const registry: McpToolRegistry = {
      snapshot: async () => toolResult(await handlers['snapshot']?.({ method: 'snapshot' })),
      act: async (args) => {
        const result = await handlers['act']?.({
          method: 'act',
          params: {
            kind: args['kind'],
            target: args['target'],
            ...(args['value'] !== undefined ? { value: args['value'] } : {}),
            ...(args['approve'] !== undefined ? { approvalToken: args['approve'] } : {}),
          },
        });
        const data = result?.data as { ok?: boolean };
        return toolResult(result?.data, data?.ok !== true);
      },
      approve: async (args) => {
        const result = await handlers['approve.issue']?.({
          method: 'approve.issue',
          params: { actionId: args['actionId'] },
        });
        const data = result?.data as { ok?: boolean };
        return toolResult(result?.data, data?.ok !== true);
      },
      verify: async (args) => {
        const result = await handlers['verify']?.({
          method: 'verify',
          params: { condition: args['condition'] },
        });
        return toolResult(result?.data);
      },
    };

    mcp = new McpServer(registry, [], { name: 'browser-verified-skill', version: '0.1.0' });

    // A plan that allows the submit class, so the action reaches the
    // approval check rather than being refused as off-plan.
    planLock.set({
      goal: 'test',
      successCondition: { type: 'url_matches', pattern: '/pages/' },
      allowedOrigins: [FIXTURE],
      allowedActionClasses: ['read', 'navigate', 'submit', 'input'],
      maxSteps: 20,
      createdAt: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await session.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a snapshot through the protocol', async () => {
    await session.page().then((page) => page.goto(`${FIXTURE}/pages/index.html`));

    const response = await mcp.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'snapshot', arguments: {} },
    });

    const result = response?.result as { content: { text: string }[] };
    expect(result.content[0]?.text).toContain('nodeCount');
  });

  it('refuses an action that needs approval, exactly as the CLI does', async () => {
    await session.page().then((page) => page.goto(`${FIXTURE}/pages/index.html`));

    const response = await mcp.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'act', arguments: { kind: 'click', target: 'role=button name="Submit"' } },
    });

    const result = response?.result as { isError?: boolean; content: { text: string }[] };
    // The refusal is an error result, so the agent sees it.
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('approval');
  });

  it('issues an approval and runs the action with it', async () => {
    await session.page().then((page) => page.goto(`${FIXTURE}/pages/login.html`));

    // The first attempt is refused and comes back with an approval id.
    const refused = await mcp.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'act', arguments: { kind: 'click', target: 'role=button name="Log in"' } },
    });
    const refusedResult = refused?.result as {
      content: { text: string }[];
      structuredContent?: { approvalId?: string };
    };
    // The refusal carries the approval id in the structured result.
    const approvalId = refusedResult.structuredContent?.approvalId;
    if (approvalId === undefined) {
      throw new Error(`the refusal had no approval id: ${refusedResult.content[0]?.text}`);
    }
    expect(refusedResult.content[0]?.text).toContain('approvalId');

    // The agent asks for approval.
    const approved = await mcp.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'approve', arguments: { actionId: approvalId } },
    });
    const approvedResult = approved?.result as {
      content: { text: string }[];
      structuredContent?: { token?: string };
    };
    const token = approvedResult.structuredContent?.token;
    expect(token).toBeDefined();

    // And runs the action with the token.
    const acted = await mcp.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'act',
        arguments: { kind: 'click', target: 'role=button name="Log in"', approve: token },
      },
    });
    const actedResult = acted?.result as { isError?: boolean; content: { text: string }[] };
    if (actedResult.isError === true) {
      throw new Error(`the approved action failed: ${actedResult.content[0]?.text}`);
    }
    expect(actedResult.isError).toBeUndefined();
  });

  it('verifies a condition through the protocol', async () => {
    await session.page().then((page) => page.goto(`${FIXTURE}/pages/index.html`));

    const response = await mcp.handle({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'verify',
        arguments: { condition: { type: 'url_matches', pattern: '/pages/index' } },
      },
    });

    const result = response?.result as { content: { text: string }[] };
    expect(result.content[0]?.text).toContain('VERIFIED');
  });

  it('serves the protocol over a stream', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

    const serving = mcp.serve(input, output);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })}\n`);
    input.end();
    await serving;

    expect(chunks.join('')).toContain('"jsonrpc":"2.0"');
  });
});
