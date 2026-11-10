/**
 * Generate the README's source tree from the real folders.
 *
 * The tree is generated, not written by hand, so it cannot drift. Run
 * it with `npx tsx scripts/generate-tree.ts` and it rewrites the block
 * in the README between the markers.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const README = join(ROOT, 'README.md');

/** The markers the generated tree sits between. */
const START = '<!-- BEGIN GENERATED TREE -->';
const END = '<!-- END GENERATED TREE -->';

/** What each folder is for. A folder with no note gets none. */
const NOTES: Record<string, string> = {
  actions: 'locate, act, waits, download, frames',
  agent: 'the agent loop and the cost report',
  cli: 'commander wiring only',
  compile: 'recorder, compiler, replay, heal, drift',
  core: 'daemon, client, contexts, paths, exit codes',
  interaction: 'typing, mouse, profiles, throttle',
  llm: 'client, router, budget',
  mcp: 'the MCP server and its wiring',
  memory: 'playbooks and skills',
  perception: 'snapshot, diff, prune, refs, tokens',
  safety: 'policy, approvals, planlock, taint, injection, vault',
  testing: 'suite, console, a11y, perf, visual, flake, diff, redteam',
  types: 'shared types',
  verify: 'conditions, verifier, evidence, extract',
};

/** The folders, in the order the tree lists them. */
const ORDER = [
  'cli',
  'core',
  'perception',
  'actions',
  'safety',
  'verify',
  'compile',
  'interaction',
  'testing',
  'agent',
  'llm',
  'mcp',
  'memory',
  'types',
];

const entries = await readdir(join(ROOT, 'src'), { withFileTypes: true });
const folders = entries
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const missing = folders.filter((name) => !ORDER.includes(name));
if (missing.length > 0) {
  throw new Error(
    `these folders are not in the tree's order list: ${missing.join(', ')}. ` +
      'Add them to ORDER in scripts/generate-tree.ts.',
  );
}

const extra = ORDER.filter((name) => !folders.includes(name));
if (extra.length > 0) {
  throw new Error(
    `the tree's order list has folders that do not exist: ${extra.join(', ')}. ` +
      'Remove them from ORDER in scripts/generate-tree.ts.',
  );
}

const lines: string[] = [];
for (const name of ORDER) {
  const note = NOTES[name];
  const label = note === undefined ? '' : `  # ${note}`;
  lines.push(`│   ├── ${name}/${label}`);
}

const tree = lines.join('\n');

/**
 * The README with the generated tree put back in.
 *
 * Exported so `scripts/check-docs.ts` can compare without writing.
 */
export function withGeneratedTree(readme: string): string {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);

  if (start === -1 || end === -1) {
    throw new Error('the README does not have the generated-tree markers');
  }

  const before = readme.slice(0, start + START.length);
  const after = readme.slice(end);
  return `${before}\n${tree}\n${after}`;
}

// Only write when run directly, so importing it has no side effect.
const isMain = process.argv[1]?.endsWith('generate-tree.ts') === true;
if (isMain) {
  const readme = await readFile(README, 'utf8');
  await writeFile(README, withGeneratedTree(readme), 'utf8');
  console.log(`the tree is up to date: ${folders.length} folders`);
}
