import { readFile } from 'node:fs/promises';

interface Entry {
  lines: { pct: number };
  functions: { pct: number };
  branches: { pct: number };
  statements: { pct: number };
}

const summary = JSON.parse(await readFile('coverage/coverage-summary.json', 'utf8')) as Record<
  string,
  Entry
>;

const filter = process.argv[2] ?? '/src/';

const rows: [string, Entry][] = [];
for (const [file, data] of Object.entries(summary)) {
  if (file === 'total') continue;
  if (!file.replace(/\\/g, '/').includes(filter)) continue;
  rows.push([file.replace(/.*browser-verified./, ''), data]);
}
rows.sort((a, b) => a[1].lines.pct - b[1].lines.pct);

for (const [file, data] of rows) {
  console.log(
    file.padEnd(46),
    `ln ${String(data.lines.pct).padStart(6)}`,
    `fn ${String(data.functions.pct).padStart(6)}`,
    `br ${String(data.branches.pct).padStart(6)}`,
    `st ${String(data.statements.pct).padStart(6)}`,
  );
}
