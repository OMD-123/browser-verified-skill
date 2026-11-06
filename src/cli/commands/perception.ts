/**
 * `bv snapshot`, `bv act` and `bv goto` — the perception and action commands.
 */
import type { Command } from 'commander';
import { ok, fail } from '../../core/output.js';
import { EXIT } from '../../core/exit.js';
import { connectDaemon } from '../../core/client.js';
import { parseTarget, type ActionKind } from '../../actions/locate.js';
import { emit, globalOptions } from '../helpers.js';
import { UsageError } from '../../core/errors.js';

/** The action kinds the CLI accepts. */
const ACTION_KINDS: readonly ActionKind[] = [
  'click',
  'dblclick',
  'hover',
  'type',
  'fill',
  'select',
  'check',
  'uncheck',
  'press',
  'scroll',
  'upload',
  'focus',
];

/** The result of a daemon `snapshot` call. */
interface SnapshotPayload {
  header: { url: string; title: string; nodes: number; interactive: number; changes: number };
  diff: string;
  tree?: string;
  snapshotPath: string;
  estimatedTokens: number;
  nodeCount: number;
  prunedCount: number;
  navigated: boolean;
}

/** The result of a daemon `act` call. */
interface ActPayload {
  ok: boolean;
  kind: string;
  strategy?: string;
  attempted: string[];
  failures: { strategy: string; reason: string }[];
  message: string;
  durationMs: number;
  urlBefore: string;
  urlAfter: string;
  diff: string;
  step: { step: number; snapshotPath?: string };
  /** Set when the safety gate refused the action. */
  denied?: boolean;
  /** What the gate wants next. */
  next?: 'proceed' | 'deny' | 'needs_approval' | 'off_plan';
  /** The action class the gate classified it as. */
  actionClass?: string;
  /** Why the gate refused it. */
  reasons?: string[];
  /** The policy rules that were consulted. */
  ruleIds?: string[];
  /** The id of the pending approval, when one is needed. */
  approvalId?: string;
  /** What the approval would allow. */
  approvalDescription?: string;
}

/** Register the perception and action commands. */
export function registerPerception(program: Command): void {
  program
    .command('snapshot')
    .description('capture the page as a compact, diffed accessibility tree')
    .option('--full', 'return the full tree instead of only the changes', false)
    .option('--max-tokens <n>', 'approximate token budget for the pruned tree')
    .option('--expand <ref>', 'expand a collapsed node by ref')
    .action(
      async (options: { full?: boolean; maxTokens?: string; expand?: string }, cmd: Command) => {
        const global = globalOptions(cmd);
        try {
          const client = await connectDaemon(global.cwd);
          const maxTokens = options.maxTokens !== undefined ? Number(options.maxTokens) : undefined;
          if (maxTokens !== undefined && (!Number.isFinite(maxTokens) || maxTokens <= 0)) {
            throw new UsageError('--max-tokens must be a positive number');
          }

          const payload = await client.call<SnapshotPayload>('snapshot', {
            full: options.full === true,
            ...(maxTokens !== undefined ? { maxTokens } : {}),
            ...(options.expand !== undefined ? { expand: options.expand } : {}),
          });

          const lines = [
            payload.diff,
            `full snapshot: ${payload.snapshotPath}`,
            `estimated tokens: ${payload.estimatedTokens} (estimate)`,
          ];
          if (options.full === true && payload.tree !== undefined) {
            lines.push(payload.tree);
          }

          emit(cmd, ok(payload, lines));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
          emit(cmd, fail({ error: message }, [message], code));
        }
      },
    );

  program
    .command('act')
    .description('perform an action on the page')
    .argument('<kind>', `one of: ${ACTION_KINDS.join(', ')}`)
    .argument('<target>', 'a ref (e12), or a descriptor (role=button name="Sign in")')
    .argument('[value]', 'the value to type, fill, select, press or upload')
    .option('--dry-run', 'report what would happen without doing it', false)
    .option('--force', 'skip actionability checks', false)
    .option('--approve <token>', 'an approval token for this exact action')
    .action(
      async (
        kind: string,
        target: string,
        value: string | undefined,
        options: { dryRun?: boolean; force?: boolean; approve?: string },
        cmd: Command,
      ) => {
        const global = globalOptions(cmd);
        if (!ACTION_KINDS.includes(kind as ActionKind)) {
          const message = `unknown action kind "${kind}". Expected one of: ${ACTION_KINDS.join(', ')}`;
          emit(cmd, fail({ error: message }, [message], EXIT.USAGE));
          return;
        }

        try {
          const client = await connectDaemon(global.cwd);
          const descriptor = parseTarget(target);

          if (options.dryRun === true) {
            const lines = [
              `dry run: would ${kind} ${describeTarget(descriptor)}`,
              value !== undefined ? `value: ${value}` : '',
            ].filter((line) => line !== '');
            emit(
              cmd,
              ok(
                {
                  dryRun: true,
                  kind,
                  target: descriptor,
                  ...(value !== undefined ? { value } : {}),
                },
                lines,
              ),
            );
            return;
          }

          const payload = await client.call<ActPayload>('act', {
            kind,
            target: descriptor,
            ...(value !== undefined ? { value } : {}),
            force: options.force === true,
            ...(typeof options.approve === 'string' ? { approvalToken: options.approve } : {}),
          });

          // A refusal from the safety gate is reported differently from a
          // failed action: the action never happened, and the reason says
          // why.
          if (payload.denied === true) {
            const lines = [
              `refused: ${payload.reasons?.join('; ') ?? 'the policy did not allow this action'}`,
              `class: ${payload.actionClass ?? 'unknown'}`,
              ...(payload.ruleIds !== undefined && payload.ruleIds.length > 0
                ? [`rules: ${payload.ruleIds.join(', ')}`]
                : []),
              ...(payload.approvalId !== undefined
                ? [
                    `approval id: ${payload.approvalId}`,
                    `run \`bv approve ${payload.approvalId}\` to approve this exact action`,
                  ]
                : []),
            ];
            const code =
              payload.next === 'needs_approval' ? EXIT.NEEDS_APPROVAL : EXIT.POLICY_DENIED;
            emit(cmd, fail(payload, lines, code));
            return;
          }

          const lines = [
            payload.ok ? `ok: ${payload.message}` : `failed: ${payload.message}`,
            `strategy: ${payload.strategy ?? 'none'}`,
            `url: ${payload.urlBefore} → ${payload.urlAfter}`,
            payload.diff,
          ];
          emit(cmd, payload.ok ? ok(payload, lines) : fail(payload, lines, EXIT.FAILURE));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
          emit(cmd, fail({ error: message }, [message], code));
        }
      },
    );

  program
    .command('goto')
    .description('navigate the active tab to a URL')
    .argument('<url>', 'the URL to navigate to')
    .action(async (url: string, cmd: Command) => {
      const global = globalOptions(cmd);
      try {
        const client = await connectDaemon(global.cwd);
        const payload = await client.call<{ ok: boolean; url: string; message: string }>('goto', {
          url,
        });
        const lines = [payload.message, `url: ${payload.url}`];
        emit(cmd, payload.ok ? ok(payload, lines) : fail(payload, lines, EXIT.FAILURE));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });

  program
    .command('tab')
    .description('list, select or close tabs')
    .argument('[action]', 'list (default), select or close')
    .argument('[index]', 'the tab index, for select and close')
    .action(async (action: string | undefined, index: string | undefined, cmd: Command) => {
      const global = globalOptions(cmd);
      const verb = action ?? 'list';
      try {
        const client = await connectDaemon(global.cwd);
        if (verb === 'list') {
          const payload = await client.call<{
            tabs: { index: number; url: string; title: string; active: boolean; popup: boolean }[];
          }>('tabs');
          const lines = payload.tabs.map(
            (t) =>
              `${t.index}${t.active ? '*' : ' '} ${t.title || '(untitled)'} ${t.url}${t.popup ? ' [popup]' : ''}`,
          );
          if (lines.length === 0) lines.push('(no tabs)');
          emit(cmd, ok(payload, lines));
          return;
        }
        if (verb === 'select' || verb === 'close') {
          const parsed = Number(index);
          if (!Number.isInteger(parsed)) {
            throw new UsageError(`\`bv tab ${verb}\` needs a tab index`);
          }
          const payload = await client.call<{ ok: boolean; index: number }>(
            verb === 'select' ? 'tab.select' : 'tab.close',
            { index: parsed },
          );
          emit(cmd, ok(payload, [`tab ${verb}ed: ${parsed}`]));
          return;
        }
        throw new UsageError(`unknown tab action "${verb}". Expected list, select or close.`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });
}

/** Describe a target descriptor for human output. */
function describeTarget(descriptor: ReturnType<typeof parseTarget>): string {
  const parts: string[] = [];
  if (descriptor.ref !== undefined) parts.push(`ref=${descriptor.ref}`);
  if (descriptor.role !== undefined) parts.push(`role=${descriptor.role}`);
  if (descriptor.name !== undefined) parts.push(`name=${descriptor.name}`);
  if (descriptor.label !== undefined) parts.push(`label=${descriptor.label}`);
  if (descriptor.text !== undefined) parts.push(`text=${descriptor.text}`);
  if (descriptor.testId !== undefined) parts.push(`testid=${descriptor.testId}`);
  if (descriptor.css !== undefined) parts.push(`css=${descriptor.css}`);
  return parts.length > 0 ? parts.join(' ') : '(empty)';
}
