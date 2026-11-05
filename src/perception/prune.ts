/**
 * Pruning: shrink a snapshot without losing anything an agent needs.
 *
 * The rules, in order:
 *  1. Drop decorative roles (`generic`, `none`, `presentation`) that carry no
 *     text and no ref-worthy semantics — but keep them when they have a ref
 *     and no children, because they may be the target of an action.
 *  2. Collapse repeated siblings of the same role+name into one node with a
 *     `… +N similar items` marker.
 *  3. Truncate long text with an explicit length marker.
 *  4. Apply a token budget by dropping the lowest-value nodes first.
 */
import { countNodes, walkNodes, type AxNode } from './snapshot.js';

/** Options controlling pruning. */
export interface PruneOptions {
  /** Maximum characters of text kept per node. Default 120. */
  maxTextLength?: number;
  /**
   * How many identical siblings to keep before collapsing. Default 3.
   */
  maxSimilarSiblings?: number;
  /** Approximate token budget. Default: unlimited. */
  maxTokens?: number;
  /** Characters per token used by the estimator. Default 4. */
  charsPerToken?: number;
}

/** The result of pruning a tree. */
export interface PruneResult {
  /** The pruned tree. */
  roots: AxNode[];
  /** Number of nodes before pruning. */
  before: number;
  /** Number of nodes after pruning. */
  after: number;
  /** Whether the token budget forced further truncation. */
  budgetApplied: boolean;
}

/** Roles that carry no meaning on their own. */
const DECORATIVE_ROLES = new Set(['generic', 'none', 'presentation']);

/** Roles that are always worth keeping. */
const SEMANTIC_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'heading',
  'link',
  'listbox',
  'menuitem',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'iframe',
  'img',
  'table',
  'status',
  'alert',
  'dialog',
  'form',
  'navigation',
  'main',
  'banner',
  'contentinfo',
]);

/** Truncate text with an explicit length marker so the agent knows it is cut. */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}… [${text.length - maxLength} more chars]`;
}

/**
 * Collapse runs of identical siblings.
 *
 * `link "Read more"` repeated 40 times becomes one `link "Read more"` with a
 * `… +37 similar items` marker, so the agent sees the shape without the bulk.
 */
function collapseSimilarSiblings(children: AxNode[], maxSimilar: number): AxNode[] {
  const result: AxNode[] = [];
  let index = 0;

  while (index < children.length) {
    const node = children[index];
    if (node === undefined) break;

    // Only collapse leaf-ish nodes that are identical in role and name.
    const collapsible =
      node.children === undefined &&
      node.role !== 'heading' &&
      (node.name !== undefined || node.text !== undefined);

    if (!collapsible) {
      result.push(node);
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < children.length) {
      const candidate = children[end];
      if (candidate === undefined) break;
      if (
        candidate.role !== node.role ||
        candidate.name !== node.name ||
        candidate.text !== node.text ||
        candidate.children !== undefined
      ) {
        break;
      }
      end += 1;
    }

    const runLength = end - index;
    if (runLength <= maxSimilar) {
      for (let i = index; i < end; i++) {
        const item = children[i];
        if (item !== undefined) result.push(item);
      }
    } else {
      const keep = maxSimilar;
      for (let i = 0; i < keep; i++) {
        const item = children[index + i];
        if (item !== undefined) result.push(item);
      }
      result.push({
        role: 'note',
        text: `… +${runLength - keep} similar items`,
      });
    }
    index = end;
  }

  return result;
}

/** Remove decorative wrappers that add nothing. */
function dropDecorative(node: AxNode): AxNode | undefined {
  if (!DECORATIVE_ROLES.has(node.role)) return node;
  if (node.children === undefined || node.children.length === 0) {
    // A leaf generic with no text and no name is invisible to an agent.
    const hasText = node.text !== undefined && node.text.trim().length > 0;
    const hasName = node.name !== undefined && node.name.trim().length > 0;
    if (!hasText && !hasName) return undefined;
    return node;
  }
  // A generic wrapper is only noise if all of its children are noise too.
  const kept = node.children.map((c) => dropDecorative(c)).filter((c) => c !== undefined);
  if (kept.length === 0) return undefined;
  if (kept.length === 1 && node.name === undefined && node.text === undefined) {
    return kept[0];
  }
  return { ...node, children: kept };
}

/** Prune a tree according to the options. */
export function pruneSnapshot(roots: readonly AxNode[], options: PruneOptions = {}): PruneResult {
  const maxTextLength = options.maxTextLength ?? 120;
  const maxSimilar = options.maxSimilarSiblings ?? 3;
  const charsPerToken = options.charsPerToken ?? 4;
  const before = countNodes(roots);

  const pruneNode = (node: AxNode): AxNode | undefined => {
    const kept = dropDecorative(node);
    if (kept === undefined) return undefined;

    const next: AxNode = { ...kept };

    if (next.text !== undefined) {
      next.text = truncateText(next.text, maxTextLength);
    }
    if (next.name !== undefined && next.name.length > maxTextLength * 2) {
      next.name = truncateText(next.name, maxTextLength * 2);
    }

    if (next.children !== undefined) {
      const prunedChildren = next.children.map((c) => pruneNode(c)).filter((c) => c !== undefined);
      const collapsed = collapseSimilarSiblings(prunedChildren, maxSimilar);
      if (collapsed.length > 0) {
        next.children = collapsed;
      } else {
        delete next.children;
      }
    }

    return next;
  };

  const prunedRoots = roots.map((r) => pruneNode(r)).filter((r) => r !== undefined);

  // Token budget: drop the deepest, least semantic nodes until we fit.
  let budgetApplied = false;
  const maxTokens = options.maxTokens;
  if (maxTokens !== undefined && maxTokens > 0) {
    let estimate = estimateTreeTokens(prunedRoots, charsPerToken);
    while (estimate > maxTokens && prunedRoots.length > 0) {
      const removed = removeLeastValuable(prunedRoots);
      if (!removed) break;
      budgetApplied = true;
      estimate = estimateTreeTokens(prunedRoots, charsPerToken);
    }
  }

  return { roots: prunedRoots, before, after: countNodes(prunedRoots), budgetApplied };
}

/**
 * Estimate the token cost of a tree.
 *
 * Uses characters ÷ 4, which is an approximation. Callers that need an exact
 * count must use the model provider's counting endpoint.
 */
export function estimateTreeTokens(roots: readonly AxNode[], charsPerToken = 4): number {
  let chars = 0;
  walkNodes(roots, (node) => {
    chars += node.role.length;
    if (node.name !== undefined) chars += node.name.length + 6;
    if (node.text !== undefined) chars += node.text.length + 6;
    if (node.ref !== undefined) chars += node.ref.length + 6;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'role' || key === 'name' || key === 'text' || key === 'ref') continue;
      if (key === 'children') continue;
      if (typeof value === 'boolean') chars += key.length + 4;
    }
  });
  return Math.ceil(chars / charsPerToken);
}

/**
 * Remove the least valuable node from the tree.
 *
 * "Least valuable" means: a node with no ref, no name and no text, deepest
 * first. Nodes that carry a ref, a name or text are meaningful and are kept.
 */
function removeLeastValuable(roots: AxNode[]): boolean {
  let target: { parent: AxNode; index: number; depth: number } | undefined;
  let deepest = -1;

  const search = (nodes: AxNode[], depth: number, parent?: AxNode): void => {
    nodes.forEach((node, index) => {
      if (node.children) {
        search(node.children, depth + 1, node);
      }
      const meaningful =
        node.ref !== undefined || node.name !== undefined || node.text !== undefined;
      if (!meaningful && parent !== undefined && depth > deepest) {
        deepest = depth;
        target = { parent, index, depth };
      }
    });
  };
  search(roots, 0);

  if (target === undefined) {
    // Everything is meaningful: drop the deepest leaf anyway rather than
    // looping forever.
    let leaf: { parent: AxNode; index: number; depth: number } | undefined;
    const findLeaf = (nodes: AxNode[], depth: number, parent?: AxNode): void => {
      nodes.forEach((node, index) => {
        if (node.children && node.children.length > 0) {
          findLeaf(node.children, depth + 1, node);
        } else if (parent !== undefined && depth > deepest) {
          deepest = depth;
          leaf = { parent, index, depth };
        }
      });
    };
    findLeaf(roots, 0);
    if (leaf === undefined) return false;
    const { parent, index } = leaf;
    parent.children?.splice(index, 1);
    if (parent.children?.length === 0) delete parent.children;
    return true;
  }

  const { parent, index } = target;
  parent.children?.splice(index, 1);
  if (parent.children?.length === 0) delete parent.children;
  return true;
}

/**
 * Whether a node is worth keeping in a compact view.
 *
 * Used by the diff renderer to decide if a change matters.
 */
export function isInteresting(node: AxNode): boolean {
  if (SEMANTIC_ROLES.has(node.role)) return true;
  if (node.name !== undefined && node.name.trim().length > 0) return true;
  if (node.text !== undefined && node.text.trim().length > 0) return true;
  return false;
}
