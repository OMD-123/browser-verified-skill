/**
 * The differential runner (M23).
 *
 * `bv diff --a URL --b URL` opens two pages and reports how they differ.
 *
 * The comparison is on the **accessibility tree**, not on pixels, because
 * the tree is what the agent acts on. A pixel difference might be a
 * gradient; a tree difference is a missing button.
 *
 * The report says which side has something the other does not. That
 * direction matters: "B has a button A does not" is a finding; "the two
 * trees differ" is not.
 */
import type { Browser, Page } from 'playwright';
/**
 * A node of the tree being compared.
 *
 * A local type rather than the snapshot's `AxNode`, because a node in a
 * comparison always has a name: a node without one would match every
 * other nameless node of the same role.
 */
export interface DiffNode {
  /** The ARIA role. */
  role: string;
  /** The accessible name. */
  name: string;
}

/** One difference between two pages. */
export interface TreeDifference {
  /** The node's role. */
  role: string;
  /** The node's accessible name. */
  name: string;
  /** Which side has it. */
  onlyIn: 'a' | 'b';
}

/** The result of a comparison. */
export interface DiffResult {
  /** The first URL. */
  urlA: string;
  /** The second URL. */
  urlB: string;
  /** The nodes only in A. */
  onlyInA: TreeDifference[];
  /** The nodes only in B. */
  onlyInB: TreeDifference[];
  /** The nodes in both, with a different name. */
  changed: { role: string; nameA: string; nameB: string }[];
  /** The number of nodes in each tree. */
  nodeCounts: { a: number; b: number };
  /** Whether the trees are the same. */
  identical: boolean;
}

/**
 * The key of a node, for matching the two trees.
 *
 * The role and the name together: two buttons with the same name are the
 * same button, a button and a link with the same name are not.
 */
function nodeKey(node: DiffNode): string {
  return `${node.role}::${node.name}`;
}

/**
 * Open two pages and compare their accessibility trees.
 */
export async function diffPages(
  browser: Browser,
  urlA: string,
  urlB: string,
): Promise<DiffResult> {
  const context = await browser.newContext();
  const pageA = await context.newPage();
  const pageB = await context.newPage();

  try {
    await pageA.goto(urlA, { waitUntil: 'domcontentloaded' });
    await pageB.goto(urlB, { waitUntil: 'domcontentloaded' });

    const [treeA, treeB] = await Promise.all([readTree(pageA), readTree(pageB)]);

    const keysA = new Set(treeA.map(nodeKey));
    const keysB = new Set(treeB.map(nodeKey));

    const onlyInA: TreeDifference[] = [];
    const onlyInB: TreeDifference[] = [];

    for (const node of treeA) {
      if (!keysB.has(nodeKey(node))) {
        onlyInA.push({ role: node.role, name: node.name, onlyIn: 'a' });
      }
    }
    for (const node of treeB) {
      if (!keysA.has(nodeKey(node))) {
        onlyInB.push({ role: node.role, name: node.name, onlyIn: 'b' });
      }
    }

    // A node whose role is the same but whose name differs is a change,
    // not an addition: the button is still there, it says something else.
    const namesByRoleA = new Map<string, string[]>();
    const namesByRoleB = new Map<string, string[]>();
    for (const node of treeA) {
      namesByRoleA.set(node.role, [...(namesByRoleA.get(node.role) ?? []), node.name]);
    }
    for (const node of treeB) {
      namesByRoleB.set(node.role, [...(namesByRoleB.get(node.role) ?? []), node.name]);
    }

    const changed: { role: string; nameA: string; nameB: string }[] = [];
    for (const [role, namesA] of namesByRoleA) {
      const namesB = namesByRoleB.get(role);
      if (namesB === undefined) continue;
      for (const nameA of namesA) {
        if (namesB.includes(nameA)) continue;
        // The closest name in B, so the report says what it became.
        const nameB = namesB[0] ?? '';
        changed.push({ role, nameA, nameB });
        break;
      }
    }

    return {
      urlA,
      urlB,
      onlyInA,
      onlyInB,
      changed,
      nodeCounts: { a: treeA.length, b: treeB.length },
      identical:
        onlyInA.length === 0 &&
        onlyInB.length === 0 &&
        changed.length === 0,
    };
  } finally {
    await context.close();
  }
}

/**
 * Read the accessibility tree of a page as a flat list of nodes.
 *
 * The tree is read through the DOM rather than the CDP, because the diff
 * only needs the roles and the names, and the DOM path works in every
 * browser this tool supports.
 */
async function readTree(page: Page): Promise<DiffNode[]> {
  const nodes = await page.evaluate(collectTree);
  return nodes.map((node) => ({ role: node.role, name: node.name }));
}

/* v8 ignore start -- runs in the browser, not in this process */
/**
 * Collect the tree in the page.
 *
 * This is a named function reference rather than an inline arrow, and it
 * has **no nested function declarations**: a bundler that injects a
 * `__name` helper into named functions breaks an inline arrow that
 * Playwright serialises into the page. The nested helpers are inlined for
 * the same reason.
 */
function collectTree(): { role: string; name: string }[] {
  const collected: { role: string; name: string }[] = [];

  for (const element of Array.from(document.querySelectorAll('*'))) {
    // The role.
    let role = element.getAttribute('role') ?? '';
    if (role.length === 0) {
      const tag = element.tagName.toLowerCase();
      if (tag === 'a') role = 'link';
      else if (tag === 'button') role = 'button';
      else if (tag === 'input') {
        const type = (element as HTMLInputElement).type;
        if (type === 'submit') role = 'button';
        else if (type === 'checkbox') role = 'checkbox';
        else if (type === 'radio') role = 'radio';
        else role = 'textbox';
      } else if (tag === 'textarea') role = 'textbox';
      else if (tag === 'select') role = 'combobox';
      else if (/^h[1-6]$/.test(tag)) role = 'heading';
      else if (tag === 'img') role = 'img';
      else if (tag === 'ul' || tag === 'ol') role = 'list';
      else if (tag === 'li') role = 'listitem';
      else if (tag === 'form') role = 'form';
      else if (tag === 'nav') role = 'navigation';
      else if (tag === 'main') role = 'main';
      else if (tag === 'footer') role = 'contentinfo';
      else if (tag === 'header') role = 'banner';
      else if (tag === 'table') role = 'table';
      else if (tag === 'p') role = 'paragraph';
      else role = 'generic';
    }

    // The accessible name.
    let name = element.getAttribute('aria-label') ?? '';
    if (name.trim().length === 0) name = element.getAttribute('title') ?? '';
    if (name.trim().length === 0) {
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text.length > 0 && text.length <= 120) name = text;
    }
    if (name.trim().length === 0 && element instanceof HTMLInputElement) {
      name = element.value;
    }

    if (role === 'generic') continue;
    if (name.trim().length === 0) continue;
    collected.push({ role, name: name.trim() });
  }

  return collected;
}
/* v8 ignore stop */

/**
 * Render a diff for a human.
 *
 * The counts come first, then the differences, so a reader knows whether
 * the difference is worth reading before they read it.
 */
export function renderDiff(result: DiffResult): string {
  const lines: string[] = [];

  if (result.identical) {
    lines.push('The two pages have the same accessibility tree.');
    return lines.join('\n');
  }

  lines.push(
    `A: ${result.urlA} (${result.nodeCounts.a} nodes)\n` +
      `B: ${result.urlB} (${result.nodeCounts.b} nodes)`,
  );

  if (result.onlyInA.length > 0) {
    lines.push(`\nOnly in A (${result.onlyInA.length}):`);
    for (const difference of result.onlyInA.slice(0, 30)) {
      lines.push(`  ${difference.role} "${difference.name}"`);
    }
    if (result.onlyInA.length > 30) {
      lines.push(`  ... and ${result.onlyInA.length - 30} more`);
    }
  }

  if (result.onlyInB.length > 0) {
    lines.push(`\nOnly in B (${result.onlyInB.length}):`);
    for (const difference of result.onlyInB.slice(0, 30)) {
      lines.push(`  ${difference.role} "${difference.name}"`);
    }
    if (result.onlyInB.length > 30) {
      lines.push(`  ... and ${result.onlyInB.length - 30} more`);
    }
  }

  if (result.changed.length > 0) {
    lines.push(`\nChanged (${result.changed.length}):`);
    for (const change of result.changed.slice(0, 30)) {
      lines.push(`  ${change.role}: "${change.nameA}" → "${change.nameB}"`);
    }
  }

  return lines.join('\n');
}
