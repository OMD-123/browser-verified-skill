import { readFile } from 'node:fs/promises';

interface CoverageEntry {
  path: string;
  branchMap: Record<string, { loc: { start: { line: number } }; type: string }>;
  b: Record<string, number[]>;
}

const raw = JSON.parse(await readFile('coverage/coverage-final.json', 'utf8')) as Record<
  string,
  CoverageEntry
>;

const target = process.argv[2] ?? '';

for (const [file, data] of Object.entries(raw)) {
  const normalised = file.replace(/\\/g, '/');
  if (!normalised.includes(target)) continue;
  console.log(`\n${normalised.replace(/.*browser-verified\//, '')}`);
  for (const [id, counts] of Object.entries(data.b)) {
    counts.forEach((count, index) => {
      if (count > 0) return;
      const meta = data.branchMap[id];
      if (meta === undefined) return;
      console.log(`  UNCOVERED  L${meta.loc.start.line}  ${meta.type} #${index}`);
    });
  }
}
