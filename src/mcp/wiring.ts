/**
 * The MCP server's wiring to the daemon (M21).
 *
 * Every tool call here becomes a daemon request. That is the whole point:
 * the MCP path and the CLI path go through **one** policy engine, so an
 * agent cannot get to an action the CLI would refuse.
 *
 * The one thing the MCP server does not do is start a browser. The daemon
 * owns the browser; the MCP server is a client of it. If the daemon is not
 * running, the tool says so — it does not quietly launch a second browser.
 */
import { connectDaemon, type DaemonClient } from '../core/client.js';
import { BROWSER_TOOLS, McpServer, toolResult, type McpToolRegistry } from './server.js';

/** The options for the MCP server. */
export interface McpOptions {
  /** The working directory. */
  cwd: string;
  /** The server's name. */
  name?: string;
  /** The server's version. */
  version?: string;
}

/**
 * Build the MCP server, wired to the daemon.
 */
export async function createMcpServer(options: McpOptions): Promise<McpServer> {
  const client = await connectDaemon(options.cwd);

  const registry: McpToolRegistry = {
    snapshot: async (args) => {
      const result = await client.call<{ header: unknown; diff: unknown; nodeCount: number }>(
        'snapshot',
        {
          ...(args['full'] === true ? { full: true } : {}),
          ...(typeof args['maxTokens'] === 'number' ? { maxTokens: args['maxTokens'] } : {}),
        },
      );
      return toolResult(result);
    },

    act: async (args) => {
      const kind = args['kind'];
      const target = args['target'];
      if (typeof kind !== 'string' || typeof target !== 'string') {
        return toolResult({ error: 'the act tool needs a kind and a target' }, true);
      }

      const result = await client.call<{
        ok: boolean;
        error?: string;
        refused?: boolean;
        approvalId?: string;
        ruleIds?: string[];
        reason?: string;
      }>('act', {
        kind,
        target,
        ...(typeof args['value'] === 'string' ? { value: args['value'] } : {}),
        // The tool calls the argument `approve`; the daemon calls it
        // `approvalToken`.
        ...(typeof args['approve'] === 'string' ? { approvalToken: args['approve'] } : {}),
      });

      // A refusal is an error result. An agent that gets a successful-looking
      // response for a refused action will try again the wrong way.
      return toolResult(result, result.ok !== true);
    },

    approve: async (args) => {
      const actionId = args['actionId'];
      if (typeof actionId !== 'string') {
        return toolResult({ error: 'the approve tool needs an actionId' }, true);
      }
      const result = await client.call<{ ok: boolean; token?: string; error?: string }>(
        'approve.issue',
        {
          actionId,
        },
      );
      return toolResult(result, result.ok !== true);
    },

    verify: async (args) => {
      const condition = args['condition'];
      if (condition === undefined) {
        return toolResult({ error: 'the verify tool needs a condition' }, true);
      }
      const result = await client.call<{ passed: boolean; summary: string }>('verify', {
        condition,
      });
      return toolResult(result, result.passed !== true);
    },

    extract: async (args) => {
      const schema = args['schema'];
      if (schema === undefined) {
        return toolResult({ error: 'the extract tool needs a schema' }, true);
      }
      const result = await client.call<{ fields: unknown; order: string[] }>('extract', { schema });
      return toolResult(result);
    },

    compile: async (args) => {
      const runId = args['runId'];
      if (typeof runId !== 'string') {
        return toolResult({ error: 'the compile tool needs a runId' }, true);
      }
      const result = await client.call<{ out: string; steps: number }>('compile', { runId });
      return toolResult(result);
    },

    replay: async (args) => {
      const runId = args['runId'];
      if (typeof runId !== 'string') {
        return toolResult({ error: 'the replay tool needs a runId' }, true);
      }
      const result = await client.call<{ ok: boolean; summary: string }>('replay', {
        runId,
        ...(args['heal'] === true ? { heal: true } : {}),
        ...(typeof args['variables'] === 'object' && args['variables'] !== null
          ? { variables: args['variables'] }
          : {}),
      });
      return toolResult(result, result.ok !== true);
    },
  };

  return new McpServer(registry, BROWSER_TOOLS, {
    name: options.name ?? 'browser-verified-skill',
    version: options.version ?? '1.0.0',
  });
}

/**
 * The daemon client the MCP server uses.
 *
 * Exported so a caller can check the daemon is up before serving.
 */
export async function checkDaemon(cwd: string): Promise<DaemonClient> {
  return connectDaemon(cwd);
}
