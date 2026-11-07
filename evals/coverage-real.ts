import { readFile } from 'node:fs/promises';

interface Entry {
  lines: { total: number; covered: number; pct: number };
  functions: { total: number; covered: number; pct: number };
  branches: { total: number; covered: number; pct: number };
  statements: { total: number; covered: number; pct: number };
}

const summary = JSON.parse(await readFile('coverage/coverage-summary.json', 'utf8')) as Record<
  string,
  Entry
>;

const groups = new Map<string, Entry>();

for (const [file, data] of Object.entries(summary)) {
  if (file === 'total') continue;
  const normalised = file.replace(/\\/g, '/');
  const match = /\/src\/([^/]+)\//.exec(normalised);
  if (match === null) continue;
  const group = match[1] ?? 'root';

  const existing = groups.get(group);
  if (existing === undefined) {
    groups.set(group, JSON.parse(JSON.stringify(data)) as Entry);
    continue;
  }
  for (const metric of ['lines', 'functions', 'branches', 'statements'] as const) {
    existing[metric].total += data[metric].total;
    existing[metric].covered += data[metric].covered;
  }
}

console.log(
  'group'.padEnd(12),
  'branches'.padStart(14),
  'lines'.padStart(14),
  'functions'.padStart(14),
  'statements'.padStart(14),
);
for (const [group, data] of [...groups].sort()) {
  const pct = (m: 'lines' | 'functions' | 'branches' | 'statements') =>
    data[m].total === 0 ? 100 : Math.round((data[m].covered / data[m].total) * 10000) / 100;
  console.log(
    group.padEnd(12),
    `${pct('branches')}% (${data.branches.covered}/${data.branches.total})`.padStart(14),
    `${pct('lines')}% (${data.lines.covered}/${data.lines.total})`.padStart(14),
    `${pct('functions')}% (${data.functions.covered}/${data.functions.total})`.padStart(14),
    `${pct('statements')}% (${data.statements.covered}/${data.statements.total})`.padStart(14),
  );
}
