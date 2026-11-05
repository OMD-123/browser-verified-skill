/**
 * Structural diff between two snapshots.
 *
 * The goal is token efficiency: after the first snapshot, a command returns
 * only what changed, plus a one-line header describing the page.
 *
 * Matching happens on **two levels**:
 *
 *  1. Strict identity (role + name + ref). This is the normal case.
 *  2. Loose identity (role + name), used as a fallback for nodes whose ref
 *     changed. Playwright re-allocates refs after a navigation (the frame
 *     counter is context-global and monotonic), so without this fallback a
 *     diff across a navigation would report every node as removed and every
 *     node as added.
 *
 * The `text` field is never part of identity: a text change is reported as a
 * `changed` entry.
 */
import { nodeIdentity, nodeLooseIdentity, walkNodes, type AxNode } from './snapshot.js';

/** The kind of change to a node. */
export type ChangeKind = 'added' | 'removed' | 'changed';

/** One change between two snapshots. */
export interface NodeChange {
  kind: ChangeKind;
  /** The ref of the node, when it has one. */
  ref?: string;
  /** The role of the node. */
  role: string;
  /** The accessible name of the node. */
  name?: string;
  /** The text of the node, before or after the change. */
  text?: string;
  /** For `changed` nodes: the text before. */
  before?: string;
  /** For `changed` nodes: the text after. */
  after?: string;
  /** Which property changed. */
  field?: 'text' | 'name' | 'state' | 'children' | 'ref';
  /** For `changed` nodes: the state flag that changed. */
  state?: { key: string; before: unknown; after: unknown };
  /** Depth in the tree, for indentation. */
  depth: number;
}

/** A page header describing the current page in one line. */
export interface PageHeader {
  url: string;
  title: string;
  /** Number of nodes in the (pruned) tree. */
  nodes: number;
  /** Number of interactive elements (buttons, links, inputs). */
  interactive: number;
  /** Number of changes in this diff. */
  changes: number;
  /** Number of frames seen. */
  frames: number;
}

/** The result of diffing two snapshots. */
export interface SnapshotDiff {
  header: PageHeader;
  changes: NodeChange[];
  /** True when the document was replaced (navigation), so all refs are invalid. */
  navigated: boolean;
}

/** Roles that count as interactive for the header. */
const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'menuitem',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
]);

/** State flags compared between snapshots. */
const STATE_FLAGS = ['checked', 'expanded', 'selected', 'pressed', 'disabled'] as const;

/** Build a lookup of identity → node for a tree. */
function indexNodes(roots: readonly AxNode[]): Map<string, AxNode> {
  const index = new Map<string, AxNode>();
  walkNodes(roots, (node) => {
    const key = nodeIdentity(node);
    // Keep the first occurrence: the shallowest node with a given identity.
    if (!index.has(key)) index.set(key, node);
  });
  return index;
}

/** Build a lookup of loose identity → nodes, for the ref-changed fallback. */
function indexLoose(roots: readonly AxNode[]): Map<string, AxNode[]> {
  const index = new Map<string, AxNode[]>();
  walkNodes(roots, (node) => {
    const key = nodeLooseIdentity(node);
    const list = index.get(key);
    if (list === undefined) {
      index.set(key, [node]);
    } else {
      list.push(node);
    }
  });
  return index;
}

/** Compute the depth of every node. */
function computeDepths(roots: readonly AxNode[]): Map<string, number> {
  const depths = new Map<string, number>();
  const walk = (nodes: readonly AxNode[], depth: number): void => {
    for (const node of nodes) {
      depths.set(nodeIdentity(node), depth);
      if (node.children) walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return depths;
}

/**
 * Diff two snapshots.
 *
 * When `previous` is undefined, every node is reported as `added`, which is
 * what the first snapshot of a run produces.
 */
export function diffSnapshots(
  previous: { roots: readonly AxNode[]; documentToken: string } | undefined,
  current: {
    roots: readonly AxNode[];
    url: string;
    title: string;
    documentToken: string;
  },
): SnapshotDiff {
  const previousIndex = previous ? indexNodes(previous.roots) : new Map<string, AxNode>();
  const currentIndex = indexNodes(current.roots);
  const depths = computeDepths(current.roots);
  const changes: NodeChange[] = [];

  const navigated = previous !== undefined && previous.documentToken !== current.documentToken;

  /**
   * Pair up nodes whose strict identity differs but whose loose identity
   * matches, so a ref change is reported as a `ref` change rather than as a
   * removal plus an addition.
   */
  const previousLoose = previous ? indexLoose(previous.roots) : new Map<string, AxNode[]>();

  /** Nodes in the previous snapshot that have already been paired up. */
  const pairedPrevious = new Set<AxNode>();
  /** Nodes in the current snapshot that have already been paired up. */
  const pairedCurrent = new Set<AxNode>();

  for (const [key, currentNode] of currentIndex) {
    const previousNode = previousIndex.get(key);
    if (previousNode !== undefined) {
      pairedPrevious.add(previousNode);
      pairedCurrent.add(currentNode);
      continue;
    }
    // Strict match failed: try the loose fallback.
    const candidates = previousLoose.get(nodeLooseIdentity(currentNode)) ?? [];
    const free = candidates.find((c) => !pairedPrevious.has(c));
    if (free !== undefined) {
      pairedPrevious.add(free);
      pairedCurrent.add(currentNode);
    }
  }

  // --- Added ---------------------------------------------------------------
  for (const [key, node] of currentIndex) {
    if (pairedCurrent.has(node)) continue;
    const change: NodeChange = {
      kind: 'added',
      role: node.role,
      depth: depths.get(key) ?? 0,
    };
    if (node.ref !== undefined) change.ref = node.ref;
    if (node.name !== undefined) change.name = node.name;
    if (node.text !== undefined) change.text = node.text;
    changes.push(change);
  }

  // --- Removed -------------------------------------------------------------
  for (const node of previousIndex.values()) {
    if (pairedPrevious.has(node)) continue;
    const change: NodeChange = {
      kind: 'removed',
      role: node.role,
      depth: 0,
    };
    if (node.ref !== undefined) change.ref = node.ref;
    if (node.name !== undefined) change.name = node.name;
    if (node.text !== undefined) change.text = node.text;
    changes.push(change);
  }

  // --- Changed -------------------------------------------------------------
  for (const [key, currentNode] of currentIndex) {
    const previousNode = previousIndex.get(key);
    if (previousNode !== undefined) {
      reportTextChange(previousNode, currentNode, depths, changes);
      reportNameChange(previousNode, currentNode, depths, changes);
      reportStateChanges(previousNode, currentNode, depths, changes);
      continue;
    }

    // Paired via the loose fallback: the node matched, but its ref changed.
    const candidates = previousLoose.get(nodeLooseIdentity(currentNode)) ?? [];
    const looseMatch = candidates.find(
      (c) => !changes.some((ch) => ch.ref === c.ref && ch.kind === 'removed'),
    );
    if (looseMatch === undefined) continue;

    reportTextChange(looseMatch, currentNode, depths, changes);
    reportNameChange(looseMatch, currentNode, depths, changes);
    reportStateChanges(looseMatch, currentNode, depths, changes);

    if (looseMatch.ref !== currentNode.ref) {
      changes.push({
        kind: 'changed',
        role: currentNode.role,
        field: 'ref',
        before: looseMatch.ref ?? '',
        after: currentNode.ref ?? '',
        depth: depths.get(key) ?? 0,
        ...(currentNode.ref !== undefined ? { ref: currentNode.ref } : {}),
        ...(currentNode.name !== undefined ? { name: currentNode.name } : {}),
      });
    }
  }

  // Sort by depth then kind, so the output reads top-down.
  changes.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    const order: Record<ChangeKind, number> = { added: 0, changed: 1, removed: 2 };
    return order[a.kind] - order[b.kind];
  });

  let interactive = 0;
  let frames = 0;
  walkNodes(current.roots, (node) => {
    if (INTERACTIVE_ROLES.has(node.role)) interactive += 1;
    if (node.role === 'iframe') frames += 1;
  });

  return {
    header: {
      url: current.url,
      title: current.title,
      nodes: currentIndex.size,
      interactive,
      changes: changes.length,
      frames,
    },
    changes,
    navigated,
  };
}

/** Report a text change, if any. */
function reportTextChange(
  previousNode: AxNode,
  currentNode: AxNode,
  depths: Map<string, number>,
  changes: NodeChange[],
): void {
  if (previousNode.text === currentNode.text) return;
  changes.push({
    kind: 'changed',
    role: currentNode.role,
    field: 'text',
    before: previousNode.text ?? '',
    after: currentNode.text ?? '',
    depth: depths.get(nodeIdentity(currentNode)) ?? 0,
    ...(currentNode.ref !== undefined ? { ref: currentNode.ref } : {}),
    ...(currentNode.name !== undefined ? { name: currentNode.name } : {}),
  });
}

/** Report a name change, if any. */
function reportNameChange(
  previousNode: AxNode,
  currentNode: AxNode,
  depths: Map<string, number>,
  changes: NodeChange[],
): void {
  if (previousNode.name === currentNode.name) return;
  changes.push({
    kind: 'changed',
    role: currentNode.role,
    field: 'name',
    before: previousNode.name ?? '',
    after: currentNode.name ?? '',
    depth: depths.get(nodeIdentity(currentNode)) ?? 0,
    ...(currentNode.ref !== undefined ? { ref: currentNode.ref } : {}),
  });
}

/** Report state flag changes, if any. */
function reportStateChanges(
  previousNode: AxNode,
  currentNode: AxNode,
  depths: Map<string, number>,
  changes: NodeChange[],
): void {
  for (const flag of STATE_FLAGS) {
    const before = previousNode[flag];
    const after = currentNode[flag];
    if (before === after) continue;
    changes.push({
      kind: 'changed',
      role: currentNode.role,
      field: 'state',
      state: { key: flag, before, after },
      depth: depths.get(nodeIdentity(currentNode)) ?? 0,
      ...(currentNode.ref !== undefined ? { ref: currentNode.ref } : {}),
      ...(currentNode.name !== undefined ? { name: currentNode.name } : {}),
    });
  }
}
