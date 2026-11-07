/**
 * The MCP server (M21).
 *
 * `bv mcp` exposes the tool over the Model Context Protocol so an agent
 * can drive the browser through the same interface a human uses.
 *
 * The important property: **the MCP path runs the same policy engine**.
 * There is no route through the MCP server that skips a policy check, a
 * plan-lock check or an approval. A tool call is turned into the same
 * daemon request that the CLI makes, and the daemon does the enforcing.
 *
 * The server speaks JSON-RPC 2.0 over stdio, which is what MCP clients
 * expect. It is a small implementation of the parts of the protocol that
 * are needed: `initialize`, `tools/list` and `tools/call`.
 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/** The protocol version this server speaks. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/** A JSON-RPC request. */
export interface JsonRpcRequest {
  /** The JSON-RPC version. Always "2.0". */
  jsonrpc: '2.0';
  /** The request id. */
  id?: string | number | null;
  /** The method. */
  method: string;
  /** The parameters. */
  params?: Record<string, unknown>;
}

/** A JSON-RPC response. */
export interface JsonRpcResponse {
  /** The JSON-RPC version. */
  jsonrpc: '2.0';
  /** The request id, echoed. */
  id: string | number | null;
  /** The result, when the call succeeded. */
  result?: unknown;
  /** The error, when it did not. */
  error?: { code: number; message: string; data?: unknown };
}

/** The JSON-RPC error codes this server uses. */
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL = -32603;

/** An MCP tool. */
export interface McpTool {
  /** The tool's name. */
  name: string;
  /** What it does. */
  description: string;
  /** The JSON Schema of its input. */
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/** The result of a tool call. */
export interface McpToolResult {
  /** The text content. */
  content: { type: 'text'; text: string }[];
  /** Whether the call failed. */
  isError?: boolean;
  /** The structured result, for clients that want it. */
  structuredContent?: unknown;
}

/**
 * The handler for a tool call.
 *
 * It receives the arguments and returns the result. It may also throw: an
 * error becomes a JSON-RPC error, so the agent sees the failure rather
 * than a successful-looking empty response.
 */
export type McpToolHandler = (args: Record<string, unknown>) => Promise<McpToolResult>;

/** The tools the server exposes. */
export type McpToolRegistry = Record<string, McpToolHandler>;

/**
 * The MCP server.
 *
 * Reads JSON-RPC messages from a stream and writes responses to another.
 * The transport is injected, so the server can be tested without a
 * process boundary.
 */
export class McpServer {
  constructor(
    private readonly tools: McpToolRegistry,
    private readonly toolDefinitions: readonly McpTool[],
    private readonly serverInfo: { name: string; version: string },
  ) {}

  /**
   * Handle one JSON-RPC message.
   *
   * Returns the response, or undefined for a notification (a message with
   * no id), which gets no reply.
   */
  async handle(message: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
    const id = message.id ?? null;

    switch (message.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: this.serverInfo,
          },
        };

      case 'notifications/initialized':
        // A notification: no reply.
        return undefined;

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: { tools: this.toolDefinitions },
        };

      case 'tools/call': {
        const params = message.params ?? {};
        const name = params['name'];
        if (typeof name !== 'string') {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: RPC_INVALID_PARAMS, message: 'the tool name is required' },
          };
        }

        const handler = this.tools[name];
        if (handler === undefined) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: RPC_METHOD_NOT_FOUND, message: `no tool named "${name}"` },
          };
        }

        const rawArgs = params['arguments'];
        const args =
          typeof rawArgs === 'object' && rawArgs !== null
            ? (rawArgs as Record<string, unknown>)
            : {};

        try {
          const result = await handler(args);
          return { jsonrpc: '2.0', id, result };
        } catch (err) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: RPC_INTERNAL,
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: RPC_METHOD_NOT_FOUND,
            message: `unknown method "${message.method}"`,
          },
        };
    }
  }

  /**
   * Serve the protocol over a pair of streams.
   *
   * Each line of the input is one JSON-RPC message.
   */
  async serve(input: Readable, output: Writable): Promise<void> {
    const lines = createInterface({ input, crlfDelay: Infinity });

    for await (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      let message: JsonRpcRequest;
      try {
        message = JSON.parse(trimmed) as JsonRpcRequest;
      } catch (err) {
        this.write(output, {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: RPC_INVALID_PARAMS,
            message: `the message is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
        continue;
      }

      const response = await this.handle(message);
      if (response !== undefined) this.write(output, response);
    }
  }

  /** Write one response. */
  private write(output: Writable, response: JsonRpcResponse): void {
    output.write(`${JSON.stringify(response)}\n`);
  }
}

/**
 * The text of a tool result.
 *
 * The MCP result is text plus, when there is one, the structured result.
 * The text is what an agent reads, so it is written to be read: the
 * important fact first.
 */
export function toolText(result: unknown): string {
  if (result === undefined) return '(no result)';
  if (typeof result === 'string') return result;
  if (typeof result === 'number' || typeof result === 'boolean' || result === null) {
    return JSON.stringify(result) ?? 'null';
  }
  try {
    return JSON.stringify(result, null, 2) ?? '(no result)';
  } catch {
    // A value that cannot be serialised is described, not stringified: an
    // object must never become "[object Object]".
    return Object.prototype.toString.call(result);
  }
}

/**
 * Build the result of a tool call.
 *
 * A refusal is an error result, not a successful one: the agent has to
 * see that the action was refused.
 */
export function toolResult(result: unknown, isError = false): McpToolResult {
  return {
    content: [{ type: 'text', text: toolText(result) }],
    ...(isError ? { isError: true } : {}),
    ...(result !== undefined ? { structuredContent: result } : {}),
  };
}

/**
 * The tool definitions for the browser tools.
 *
 * The descriptions say what the tool does *and* what it will refuse to
 * do, because an agent that knows the boundary does not have to discover
 * it by hitting it.
 */
export const BROWSER_TOOLS: readonly McpTool[] = [
  {
    name: 'snapshot',
    description:
      'Read the current page as a compact accessibility tree, with element refs. ' +
      'Use this before acting so you know what is there. It does not change the page.',
    inputSchema: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: 'include the whole tree, not a pruned one' },
        maxTokens: { type: 'number', description: 'the token budget for the tree' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'act',
    description:
      'Perform one action on the page. The action is checked against the plan, the policy ' +
      'and the taint tracker first. An action that needs approval is REFUSED and comes back ' +
      'with an approval id; use the approve tool with that id to run it. ' +
      'This tool never bypasses a policy check.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [
            'click',
            'dblclick',
            'hover',
            'fill',
            'type',
            'select',
            'check',
            'uncheck',
            'press',
            'scroll',
            'upload',
          ],
          description: 'what to do',
        },
        target: { type: 'string', description: 'the element, e.g. role=button name="Sign in"' },
        value: { type: 'string', description: 'the value to fill or type' },
        approve: {
          type: 'string',
          description: 'an approval token, for an action that was refused',
        },
      },
      required: ['kind', 'target'],
      additionalProperties: false,
    },
  },
  {
    name: 'approve',
    description:
      'Issue an approval token for a pending action, so it can be run. An approval is ' +
      'single-use and bound to one exact action.',
    inputSchema: {
      type: 'object',
      properties: { actionId: { type: 'string', description: 'the approval id from the refusal' } },
      required: ['actionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'verify',
    description:
      'Check a success condition against the live page. Returns whether it passed and the ' +
      'evidence. A condition that is not met is reported as unverified, never as done.',
    inputSchema: {
      type: 'object',
      properties: {
        condition: {
          type: 'object',
          description:
            'the condition: url_matches, text_visible, element, network_response, storage or llm_judged, ' +
            'or a composition of them with all, any and not',
        },
      },
      required: ['condition'],
      additionalProperties: false,
    },
  },
  {
    name: 'extract',
    description:
      'Extract values from the page according to a JSON Schema. Every value carries its ' +
      'source, and a value that cannot be confirmed on a second read is reported as null.',
    inputSchema: {
      type: 'object',
      properties: {
        schema: { type: 'object', description: 'the JSON Schema to extract against' },
      },
      required: ['schema'],
      additionalProperties: false,
    },
  },
  {
    name: 'compile',
    description:
      'Compile a recorded run into a plain Playwright TypeScript script. The script imports ' +
      'nothing from browser-verified, so it runs in any Playwright project.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'the run to compile' } },
      required: ['runId'],
      additionalProperties: false,
    },
  },
  {
    name: 'replay',
    description:
      'Replay a recorded run deterministically, with no LLM cost. A step whose locator broke ' +
      'can be healed from the recorded fallbacks, and the change is reported as drift.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'the run to replay' },
        variables: {
          type: 'object',
          description: 'the values of the flow variables',
          additionalProperties: { type: 'string' },
        },
        heal: { type: 'boolean', description: 'repair a step whose locator broke' },
      },
      required: ['runId'],
      additionalProperties: false,
    },
  },
];
