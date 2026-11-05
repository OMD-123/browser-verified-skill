/**
 * Perception: turning a live page into a compact, diffable node tree.
 *
 * **Source of truth (verified against playwright@1.64.1 typings):**
 *
 * - `page.ariaSnapshotJSON({ mode: 'ai' })` returns a `Serializable` JSON tree
 *   whose nodes carry `role`, optional `name`, optional `text`, optional `ref`
 *   (e.g. `e9`, `f2e3`), optional `children`, and state flags.
 * - `page.getByRef(ref)` resolves those refs back to a `Locator`, including
 *   cross-origin frames (`f2e3`) and open shadow DOM.
 *
 * This is far better than the CDP `Accessibility.getFullAXTree` approach
 * sketched in DECISIONS D-0001/D-0002: the refs are already namespaced per
 * frame, already stable across re-snapshots of an unchanged page, and already
 * resolvable to a Locator. See DECISIONS D-0027.
 *
 * What we still do ourselves:
 * - prune decorative/duplicate/hidden nodes,
 * - diff two snapshots structurally,
 * - collapse long lists and truncate long text,
 * - apply a token budget,
 * - summarise findings from the injection guard into the header.
 */

/** A node in the accessibility tree. */
export interface AxNode {
  /** ARIA role, e.g. `button`, `textbox`, `heading`, `generic`. */
  role: string;
  /** Accessible name, when the element has one. */
  name?: string;
  /** Direct text content, when the element has its own text. */
  text?: string;
  /** Stable ref from Playwright's `mode: 'ai'` snapshot, e.g. `e9` or `f2e3`. */
  ref?: string;
  /** Heading level, for `heading` nodes. */
  level?: number;
  /** Child nodes. */
  children?: AxNode[];
  /** True when the node is checked, expanded, selected, pressed or disabled. */
  checked?: boolean;
  expanded?: boolean;
  selected?: boolean;
  pressed?: boolean;
  disabled?: boolean;
  /** True when the node has a pointer cursor (a common "is interactive" hint). */
  cursor?: boolean;
  /** Any additional keys Playwright may add in future versions. */
  [extra: string]: unknown;
}

/** A whole-page snapshot. */
export interface Snapshot {
  /** The roots of the tree. Usually one element. */
  roots: AxNode[];
  /** The page URL at the time of the snapshot. */
  url: string;
  /** The page title at the time of the snapshot. */
  title: string;
  /** Total number of nodes before pruning. */
  nodeCount: number;
  /** Number of nodes after pruning. */
  prunedCount: number;
  /** The ISO timestamp of the capture. */
  capturedAt: string;
  /**
   * A token identifying the document the snapshot came from. When this
   * changes, every ref from the previous snapshot is invalid.
   */
  documentToken: string;
}

/**
 * Normalise Playwright's `Serializable` snapshot into our typed tree.
 *
 * Playwright types the result as `Serializable` because the shape is
 * version-dependent; we narrow it defensively here so the rest of the code
 * works with a precise type.
 */
export function normalizeSnapshot(raw: unknown): AxNode[] {
  if (!Array.isArray(raw)) return [];
  const roots: AxNode[] = [];
  for (const item of raw) {
    const node = normalizeNode(item);
    if (node !== undefined) roots.push(node);
  }
  return roots;
}

/** Narrow one raw node. Returns undefined for anything that is not an object. */
function normalizeNode(raw: unknown): AxNode | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;

  const role = typeof source['role'] === 'string' ? source['role'] : undefined;
  if (role === undefined) return undefined;

  const node: AxNode = { role };

  const name = source['name'];
  if (typeof name === 'string') node.name = name;

  const text = source['text'];
  if (typeof text === 'string') node.text = text;

  const ref = source['ref'];
  if (typeof ref === 'string') node.ref = ref;

  const level = source['level'];
  if (typeof level === 'number') node.level = level;

  for (const flag of ['checked', 'expanded', 'selected', 'pressed', 'disabled'] as const) {
    const value = source[flag];
    if (typeof value === 'boolean') node[flag] = value;
  }

  const cursor = source['cursor'];
  if (typeof cursor === 'string') node.cursor = cursor === 'pointer';

  const children = source['children'];
  if (Array.isArray(children)) {
    const normalizedChildren: AxNode[] = [];
    for (const child of children) {
      const normalized = normalizeNode(child);
      if (normalized !== undefined) normalizedChildren.push(normalized);
    }
    if (normalizedChildren.length > 0) node.children = normalizedChildren;
  }

  // Preserve any other scalar keys so future Playwright versions do not
  // silently lose information.
  for (const [key, value] of Object.entries(source)) {
    if (key in node) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      node[key] = value;
    }
  }

  return node;
}

/** Count the nodes in a tree. */
export function countNodes(roots: readonly AxNode[]): number {
  let total = 0;
  const walk = (nodes: readonly AxNode[]): void => {
    for (const node of nodes) {
      total += 1;
      if (node.children) walk(node.children);
    }
  };
  walk(roots);
  return total;
}

/** Walk every node in the tree, depth first. */
export function walkNodes(
  roots: readonly AxNode[],
  visit: (node: AxNode, parent: AxNode | undefined) => void,
): void {
  const walk = (nodes: readonly AxNode[], parent: AxNode | undefined): void => {
    for (const node of nodes) {
      visit(node, parent);
      if (node.children) walk(node.children, node);
    }
  };
  walk(roots, undefined);
}

/** Find a node by its ref. */
export function findByRef(roots: readonly AxNode[], ref: string): AxNode | undefined {
  let found: AxNode | undefined;
  walkNodes(roots, (node) => {
    if (found === undefined && node.ref === ref) found = node;
  });
  return found;
}

/** The accessible label of a node, preferring `name` over `text`. */
export function nodeLabel(node: AxNode): string {
  return node.name ?? node.text ?? '';
}

/**
 * A short, stable description of a node's identity, used for diffing.
 *
 * Two nodes are "the same" when their role, name and ref agree. The ref is
 * the strongest signal: Playwright keeps it stable while the element exists.
 *
 * The `text` field is deliberately **excluded**: text changes are reported as
 * a `changed` entry, and including it would turn every keystroke into a
 * remove+add pair, which doubles the size of a diff.
 */
export function nodeIdentity(node: AxNode): string {
  const parts = [node.role];
  if (node.name !== undefined) parts.push(`name=${node.name}`);
  if (node.ref !== undefined) parts.push(`ref=${node.ref}`);
  return parts.join('|');
}

/**
 * A secondary identity that ignores the ref.
 *
 * Used as a fallback when a node's ref changed (which happens after a
 * navigation, or when Playwright re-allocates refs). Without this, a
 * re-snapshot after navigation would look like every node was removed and
 * every node was added, which is both noisy and wrong.
 */
export function nodeLooseIdentity(node: AxNode): string {
  const parts = [node.role];
  if (node.name !== undefined) parts.push(`name=${node.name}`);
  else if (node.text !== undefined) parts.push(`text=${node.text}`);
  return parts.join('|');
}
