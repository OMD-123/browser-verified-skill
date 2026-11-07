import { readFile } from 'node:fs/promises';

interface CoverageEntry {
  path: string;
  statementMap: Record<string, { start: { line: number } }>;
  s: Record<string, number>;
}

const raw = JSON.parse(await readFile('coverage/coverage-final.json', 'utf8')) as Record<
  string,
  CoverageEntry
>;

const filter = process.argv[2] ?? '';

for (const [file, data] of Object.entries(raw)) {
  if (!file.includes(filter)) continue;
  for (const [id, count] of Object.entries(data.s)) {
    if (count > 0) continue;
    const statement = data.statementMap[id];
    if (statement === undefined) continue;
    console.log(`${file.replace(/.*browser-verified./, '')}:${statement.start.line}`);
  }
}
