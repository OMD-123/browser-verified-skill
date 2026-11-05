/**
 * Rendering snapshots and diffs into the compact text the CLI returns.
 *
 * The full tree is always written to disk; what the agent sees is this
 * compact view. The diff view is the token-saving default.
 */
import type { AxNode } from './snapshot.js';
import type { NodeChange, PageHeader, SnapshotDiff } from './diff.js';

/** Options for rendering. */
export interface RenderOptions {
  /** The maximum number of characters per line. */
  maxLineLength?: number;
  /** The number of changes to show before truncating. */
  maxChanges?: number;
  /** Extra header notes, e.g. injection findings. */
  notes?: readonly string[];
}

/** The default maximum number of changes to show. */
const DEFAULT_MAX_CHANGES = 40;

/**
 * Format a page header as one line.
 *
 * The header is fixed overhead on every diff, so it is kept as small as
 * possible while still carrying the facts an agent needs to decide what to
 * do next.
 *
 * The URL is only included when it differs from the previous snapshot: after
 * a form fill the URL has not changed, and repeating it costs more tokens
 * than the change it describes. The title is always included, because it
 * identifies the page.
 */
export function renderHeader(
  header: PageHeader,
  notes: readonly string[] = [],
  options: { previousUrl?: string } = {},
): string {
  const parts: string[] = [];
  if (options.previousUrl === undefined || options.previousUrl !== header.url) {
    parts.push(`url=${header.url}`);
  }
  parts.push(`title=${truncate(header.title, 50)}`);

  // Frames and change counts are only worth the tokens when they are
  // non-zero, which keeps the fixed header overhead small on simple pages.
  if (header.frames > 0) parts.push(`frames=${header.frames}`);
  if (header.changes > 0) parts.push(`changes=${header.changes}`);
  if (notes.length > 0) parts.push(notes.join(' '));
  return parts.join(' | ');
}

/** Render a change as a single line. */
export function renderChange(change: NodeChange): string {
  const indent = '  '.repeat(Math.min(change.depth, 6));
  const ref = change.ref !== undefined ? `[${change.ref}]` : '';

  switch (change.kind) {
    case 'added': {
      const label = change.name ?? change.text ?? '';
      return `${indent}+ ${change.role}${ref} ${label}`.trimEnd();
    }
    case 'removed': {
      const label = change.name ?? change.text ?? '';
      return `${indent}- ${change.role}${ref} ${label}`.trimEnd();
    }
    case 'changed': {
      if (change.field === 'text') {
        return `${indent}~ ${change.role}${ref} text: ${truncate(
          change.before ?? '',
          50,
        )} → ${truncate(change.after ?? '', 50)}`;
      }
      if (change.field === 'name') {
        return `${indent}~ ${change.role}${ref} name: ${truncate(
          change.before ?? '',
          50,
        )} → ${truncate(change.after ?? '', 50)}`;
      }
      if (change.field === 'state' && change.state !== undefined) {
        return `${indent}~ ${change.role}${ref} ${change.state.key}: ${String(
          change.state.before,
        )} → ${String(change.state.after)}`;
      }
      if (change.field === 'ref') {
        return `${indent}~ ${change.role} ref: ${change.before} → ${change.after}`;
      }
      return `${indent}~ ${change.role}${ref} changed`;
    }
    default:
      return `${indent}? ${change.role}${ref}`;
  }
}

/** Render a diff into compact text. */
export function renderDiff(
  diff: SnapshotDiff,
  options: RenderOptions & { previousUrl?: string } = {},
): string {
  const maxChanges = options.maxChanges ?? DEFAULT_MAX_CHANGES;
  const lines: string[] = [renderHeader(diff.header, options.notes, options)];

  if (diff.navigated) {
    lines.push('(page navigated: all previous refs are invalid)');
  }

  if (diff.changes.length === 0) {
    lines.push('(no changes)');
    return lines.join('\n');
  }

  const shown = diff.changes.slice(0, maxChanges);
  for (const change of shown) {
    lines.push(renderChange(change));
  }
  if (diff.changes.length > shown.length) {
    lines.push(`… ${diff.changes.length - shown.length} more changes`);
  }
  return lines.join('\n');
}

/** Render a full tree in a compact indented form. */
export function renderTree(roots: readonly AxNode[], options: RenderOptions = {}): string {
  const maxLineLength = options.maxLineLength ?? 160;
  const lines: string[] = [];

  const walk = (nodes: readonly AxNode[], depth: number): void => {
    for (const node of nodes) {
      const indent = '  '.repeat(Math.min(depth, 12));
      const ref = node.ref !== undefined ? `[${node.ref}]` : '';
      const label = node.name ?? node.text ?? '';
      const state = describeState(node);
      let line = `${indent}${node.role}${ref}${state}`;
      if (label !== '') line += ` ${label}`;
      lines.push(truncate(line, maxLineLength));
      if (node.children !== undefined) walk(node.children, depth + 1);
    }
  };

  walk(roots, 0);
  return lines.join('\n');
}

/** Describe the state flags of a node. */
function describeState(node: AxNode): string {
  const parts: string[] = [];
  if (node.checked === true) parts.push('checked');
  if (node.expanded === true) parts.push('expanded');
  if (node.selected === true) parts.push('selected');
  if (node.pressed === true) parts.push('pressed');
  if (node.disabled === true) parts.push('disabled');
  if (node.level !== undefined) parts.push(`h${node.level}`);
  return parts.length > 0 ? ` (${parts.join(',')})` : '';
}

/** Truncate a string with an explicit marker. */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}
