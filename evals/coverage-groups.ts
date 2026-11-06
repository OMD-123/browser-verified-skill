import { readFile } from 'node:fs/promises';

interface SummaryEntry {
  branches: { pct: number };
  statements: { pct: number };
  lines: { pct: number };
  functions: { pct: number };
}

const summary = JSON.parse(await readFile('coverage/coverage-summary.json', 'utf8')) as Record<
  string,
  SummaryEntry
>;

interface Group {
  br: number[];
  st: number[];
  ln: number[];
  fn: number[];
  files: number;
}

const groups: Record<string, Group> = {};

for (const [file, data] of Object.entries(summary)) {
  if (file === 'total') continue;
  const normalised = file.replace(/\\/g, '/');
  const match = /src\/([^/]+)\//.exec(normalised);
  if (match === null) continue;
  const key = match[1] as string;
  const group = (groups[key] ??= { br: [], st: [], ln: [], fn: [], files: 0 });
  group.br.push(data.branches.pct);
  group.st.push(data.statements.pct);
  group.ln.push(data.lines.pct);
  group.fn.push(data.functions.pct);
  group.files += 1;
}

const average = (values: number[]): number =>
  Math.round(values.reduce((a, b) => a + b, 0) / Math.max(1, values.length));

for (const [name, group] of Object.entries(groups)) {
  console.log(
    `${name.padEnd(12)} br ${String(average(group.br)).padStart(3)}%  ` +
      `st ${String(average(group.st)).padStart(3)}%  ` +
      `ln ${String(average(group.ln)).padStart(3)}%  ` +
      `fn ${String(average(group.fn)).padStart(3)}%  (${group.files} files)`,
  );
}
