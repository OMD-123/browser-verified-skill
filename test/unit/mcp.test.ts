/**
 * Tests for the MCP server (M21).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';

vi.mock('../../src/core/client.js', () => ({
  connectDaemon: vi.fn(),
}));
import { connectDaemon } from '../../src/core/client.js';
import {
  BROWSER_TOOLS,
  MCP_PROTOCOL_VERSION,
  McpServer,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  toolResult,
  toolText,
  type McpToolRegistry,
} from '../../src/mcp/server.js';

/** A server with stub tools. */
function server(overrides: McpToolRegistry = {}): McpServer {
  const tools: McpToolRegistry = {
    echo: async (args) => toolResult({ echoed: args }),
    fail: async () => {
      throw new Error('the tool exploded');
    },
    ...overrides,
  };
  return new McpServer(tools, BROWSER_TOOLS, {
    name: 'browser-verified-skill',
    version: '0.1.0',
  });
}

describe('the MCP protocol', () => {
  it('answers initialize', async () => {
    const response = await server().handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const result = response?.result as { protocolVersion: string; serverInfo: { name: string } };
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(result.serverInfo.name).toBe('browser-verified-skill');
  });

  it('advertises the tool capability', async () => {
    const response = await server().handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const result = response?.result as { capabilities: { tools: unknown } };
    expect(result.capabilities.tools).toBeDefined();
  });

  it('answers a notification with nothing', async () => {
    const response = await server().handle({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(response).toBeUndefined();
  });

  it('answers ping', async () => {
    const response = await server().handle({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(response?.result).toBeDefined();
  });

  it('lists the tools', async () => {
    const response = await server().handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const result = response?.result as { tools: { name: string }[] };
    expect(result.tools.map((tool) => tool.name)).toContain('snapshot');
    expect(result.tools.map((tool) => tool.name)).toContain('act');
  });

  it('gives every tool a schema', async () => {
    const response = await server().handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const result = response?.result as { tools: { inputSchema: { type: string } }[] };
    for (const tool of result.tools) {
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('calls a tool', async () => {
    const response = await server().handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'echo', arguments: { a: 1 } },
    });
    const result = response?.result as { content: { text: string }[] };
    expect(result.content[0]?.text).toContain('"a": 1');
  });

  it('reports an unknown tool', async () => {
    const response = await server().handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'nope' },
    });
    expect(response?.error?.code).toBe(RPC_METHOD_NOT_FOUND);
  });

  it('reports a missing tool name', async () => {
    const response = await server().handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {},
    });
    expect(response?.error?.code).toBe(RPC_INVALID_PARAMS);
  });

  it('turns a thrown error into a JSON-RPC error', async () => {
    const response = await server().handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'fail' },
    });
    expect(response?.error?.message).toContain('the tool exploded');
  });

  it('reports an unknown method', async () => {
    const response = await server().handle({ jsonrpc: '2.0', id: 1, method: 'nope' });
    expect(response?.error?.code).toBe(RPC_METHOD_NOT_FOUND);
  });

  it('echoes the request id', async () => {
    const response = await server().handle({ jsonrpc: '2.0', id: 'abc', method: 'ping' });
    expect(response?.id).toBe('abc');
  });
});

describe('the MCP transport', () => {
  it('serves one message per line', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

    const serving = server().serve(input, output);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    input.end();
    await serving;

    expect(chunks.join('')).toContain('"id":1');
  });

  it('reports a message that is not JSON', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

    const serving = server().serve(input, output);
    input.write('not json\n');
    input.end();
    await serving;

    expect(chunks.join('')).toContain('not valid JSON');
  });

  it('ignores a blank line', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

    const serving = server().serve(input, output);
    input.write('\n   \n');
    input.end();
    await serving;

    expect(chunks).toHaveLength(0);
  });
});

describe('the tool result', () => {
  it('renders an object as JSON', () => {
    expect(toolText({ a: 1 })).toContain('"a": 1');
  });

  it('renders a string as itself', () => {
    expect(toolText('hello')).toBe('hello');
  });

  it('renders nothing as a marker', () => {
    expect(toolText(undefined)).toBe('(no result)');
  });

  it('never renders an object as [object Object]', () => {
    expect(toolText({ a: 1 })).not.toContain('[object Object]');
  });

  it('marks an error result', () => {
    expect(toolResult({ error: 'no' }, true).isError).toBe(true);
  });

  it('does not mark a normal result as an error', () => {
    expect(toolResult({ ok: true }).isError).toBeUndefined();
  });

  it('keeps the structured result', () => {
    expect(toolResult({ a: 1 }).structuredContent).toEqual({ a: 1 });
  });
});

describe('the tool definitions', () => {
  it('says what each tool refuses to do', () => {
    const act = BROWSER_TOOLS.find((tool) => tool.name === 'act');
    expect(act?.description).toContain('REFUSED');
    expect(act?.description).toContain('never bypasses');
  });

  it('lists the action kinds', () => {
    const act = BROWSER_TOOLS.find((tool) => tool.name === 'act');
    const kinds = act?.inputSchema.properties['kind'] as { enum: string[] };
    expect(kinds.enum).toContain('click');
    expect(kinds.enum).toContain('fill');
  });

  it('marks the required fields', () => {
    const act = BROWSER_TOOLS.find((tool) => tool.name === 'act');
    expect(act?.inputSchema.required).toEqual(['kind', 'target']);
  });

  it('rejects unknown fields', () => {
    for (const tool of BROWSER_TOOLS) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });
});

describe('the MCP wiring', () => {
  beforeEach(() => {
    vi.mocked(connectDaemon).mockReset();
  });

  it('turns a refusal into an error result', async () => {
    const { createMcpServer } = await import('../../src/mcp/wiring.js');

    vi.mocked(connectDaemon).mockResolvedValue({
      port: 1,
      health: async () => ({ ok: true }),
      call: vi.fn().mockResolvedValue({
        ok: false,
        refused: true,
        approvalId: 'abc',
        reason: 'the submit class needs approval',
      }),
    } as never);

    const server = await createMcpServer({ cwd: process.cwd() });
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'act', arguments: { kind: 'click', target: 'role=button' } },
    });

    const result = response?.result as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('needs approval');
  });

  it('reads a snapshot through the wiring', async () => {
    const { createMcpServer } = await import('../../src/mcp/wiring.js');

    vi.mocked(connectDaemon).mockResolvedValue({
      port: 1,
      health: async () => ({ ok: true }),
      call: vi.fn().mockResolvedValue({ header: 'h', diff: {}, nodeCount: 3 }),
    } as never);

    const server = await createMcpServer({ cwd: process.cwd() });
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'snapshot', arguments: { full: true, maxTokens: 100 } },
    });

    const result = response?.result as { content: { text: string }[] };
    expect(result.content[0]?.text).toContain('nodeCount');
  });

  it('issues an approval through the wiring', async () => {
    const { createMcpServer } = await import('../../src/mcp/wiring.js');

    vi.mocked(connectDaemon).mockResolvedValue({
      port: 1,
      health: async () => ({ ok: true }),
      call: vi.fn().mockResolvedValue({ ok: true, token: 'tok' }),
    } as never);

    const server = await createMcpServer({ cwd: process.cwd() });
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'approve', arguments: { actionId: 'abc' } },
    });

    const result = response?.result as { content: { text: string }[] };
    expect(result.content[0]?.text).toContain('tok');
  });

  it('rejects an approval with no action id', async () => {
    const { createMcpServer } = await import('../../src/mcp/wiring.js');

    vi.mocked(connectDaemon).mockResolvedValue({
      port: 1,
      health: async () => ({ ok: true }),
      call: vi.fn(),
    } as never);

    const server = await createMcpServer({ cwd: process.cwd() });
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'approve', arguments: {} },
    });

    const result = response?.result as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it('verifies through the wiring', async () => {
    const { createMcpServer } = await import('../../src/mcp/wiring.js');

    vi.mocked(connectDaemon).mockResolvedValue({
      port: 1,
      health: async () => ({ ok: true }),
      call: vi.fn().mockResolvedValue({ passed: true, summary: 'VERIFIED' }),
    } as never);

    const server = await createMcpServer({ cwd: process.cwd() });
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'verify', arguments: { condition: { type: 'url_matches', pattern: '/x' } } },
    });

    const result = response?.result as { content: { text: string }[] };
    expect(result.content[0]?.text).toContain('VERIFIED');
  });

  it('rejects a verify with no condition', async () => {
    const { createMcpServer } = await import('../../src/mcp/wiring.js');

    vi.mocked(connectDaemon).mockResolvedValue({
      port: 1,
      health: async () => ({ ok: true }),
      call: vi.fn(),
    } as never);

    const server = await createMcpServer({ cwd: process.cwd() });
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'verify', arguments: {} },
    });

    const result = response?.result as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it('extracts through the wiring', async () => {
    const { createMcpServer } = await import('../../src/mcp/wiring.js');

    vi.mocked(connectDaemon).mockResolvedValue({
      port: 1,
      health: async () => ({ ok: true }),
      call: vi.fn().mockResolvedValue({ fields: {}, order: [] }),
    } as never);

    const server = await createMcpServer({ cwd: process.cwd() });
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'extract', arguments: { schema: { type: 'object' } } },
    });

    const result = response?.result as { content: { text: string }[] };
    expect(result.content[0]?.text).toContain('fields');
  });

  it('rejects an extract with no schema', async () => {
    const { createMcpServer } = await import('../../src/mcp/wiring.js');

    vi.mocked(connectDaemon).mockResolvedValue({
      port: 1,
      health: async () => ({ ok: true }),
      call: vi.fn(),
    } as never);

    const server = await createMcpServer({ cwd: process.cwd() });
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'extract', arguments: {} },
    });

    const result = response?.result as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it('compiles through the wiring', async () => {
    const { createMcpServer } = await import('../../src/mcp/wiring.js');

    vi.mocked(connectDaemon).mockResolvedValue({
      port: 1,
      health: async () => ({ ok: true }),
      call: vi.fn().mockResolvedValue({ out: 'flows/x.spec.ts', steps: 2 }),
    } as never);

    const server = await createMcpServer({ cwd: process.cwd() });
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'compile', arguments: { runId: 'r1' } },
    });

    const result = response?.result as { content: { text: string }[] };
    expect(result.content[0]?.text).toContain('flows/x.spec.ts');
  });

  it('rejects a compile with no run id', async () => {
    const { createMcpServer } = await import('../../src/mcp/wiring.js');

    vi.mocked(connectDaemon).mockResolvedValue({
      port: 1,
      health: async () => ({ ok: true }),
      call: vi.fn(),
    } as never);

    const server = await createMcpServer({ cwd: process.cwd() });
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'compile', arguments: {} },
    });

    const result = response?.result as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it('replays through the wiring', async () => {
    const { createMcpServer } = await import('../../src/mcp/wiring.js');

    vi.mocked(connectDaemon).mockResolvedValue({
      port: 1,
      health: async () => ({ ok: true }),
      call: vi.fn().mockResolvedValue({ ok: true, summary: 'Replay succeeded.' }),
    } as never);

    const server = await createMcpServer({ cwd: process.cwd() });
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'replay', arguments: { runId: 'r1', heal: true } },
    });

    const result = response?.result as { content: { text: string }[] };
    expect(result.content[0]?.text).toContain('Replay succeeded');
  });

  it('rejects a replay with no run id', async () => {
    const { createMcpServer } = await import('../../src/mcp/wiring.js');

    vi.mocked(connectDaemon).mockResolvedValue({
      port: 1,
      health: async () => ({ ok: true }),
      call: vi.fn(),
    } as never);

    const server = await createMcpServer({ cwd: process.cwd() });
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'replay', arguments: {} },
    });

    const result = response?.result as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it('rejects an act with no target', async () => {
    const { createMcpServer } = await import('../../src/mcp/wiring.js');

    vi.mocked(connectDaemon).mockResolvedValue({
      port: 1,
      health: async () => ({ ok: true }),
      call: vi.fn(),
    } as never);

    const server = await createMcpServer({ cwd: process.cwd() });
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'act', arguments: { kind: 'click' } },
    });

    const result = response?.result as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});
