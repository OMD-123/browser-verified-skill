import { readFile } from 'node:fs/promises';

interface Summary {
  [file: string]: {
    branches: { pct: number };
    statements: { pct: number };
    lines: { pct: number };
    functions: { pct: number };
  };
}

const summary = JSON.parse(await readFile('coverage/coverage-summary.json', 'utf8')) as Summary;

const target = process.argv[2] ?? 'src/safety';
const branchFloor = Number(process.argv[3] ?? '100');
const stmtFloor = Number(process.argv[4] ?? '90');

for (const [file, data] of Object.entries(summary)) {
  if (file === 'total') continue;
  const normalised = file.replace(/\\/g, '/');
  if (!normalised.includes(target)) continue;
  const rel = normalised.replace(/.*browser-verified\//, '');
  const gaps: string[] = [];
  if (data.branches.pct < branchFloor) gaps.push(`br ${data.branches.pct}%`);
  if (data.statements.pct < stmtFloor) gaps.push(`st ${data.statements.pct}%`);
  if (data.lines.pct < stmtFloor) gaps.push(`ln ${data.lines.pct}%`);
  if (data.functions.pct < stmtFloor) gaps.push(`fn ${data.functions.pct}%`);
  if (gaps.length > 0) console.log(`${rel.padEnd(44)} ${gaps.join('  ')}`);
}
