import { readFile } from 'node:fs/promises';

interface CoverageEntry {
  path: string;
  fnMap: Record<string, { decl: { start: { line: number } }; name: string }>;
  f: Record<string, number>;
}

const raw = JSON.parse(await readFile('coverage/coverage-final.json', 'utf8')) as Record<
  string,
  CoverageEntry
>;

const target = process.argv[2] ?? '';

for (const [file, data] of Object.entries(raw)) {
  const normalised = file.replace(/\\/g, '/');
  if (!normalised.includes(target)) continue;
  console.log(normalised.replace(/.*browser-verified-skill\//, ''));
  for (const [id, count] of Object.entries(data.f)) {
    if (count > 0) continue;
    const meta = data.fnMap[id];
    if (meta === undefined) continue;
    console.log(`  UNCOVERED FN  L${meta.decl.start.line}  ${meta.name}`);
  }
}
