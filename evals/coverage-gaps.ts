import { readFile } from 'node:fs/promises';

/** One entry in the v8 coverage report. */
interface CoverageEntry {
  path: string;
  branchMap: Record<string, { loc: { start: { line: number } }; type: string }>;
  b: Record<string, number[]>;
}

const raw = JSON.parse(await readFile('coverage/coverage-final.json', 'utf8')) as Record<
  string,
  CoverageEntry
>;

let total = 0;
let hit = 0;

for (const [file, data] of Object.entries(raw)) {
  const normalised = file.replace(/\\/g, '/');
  if (!normalised.includes('src/safety')) continue;
  const rel = normalised.replace(/.*browser-verified\//, '');

  const uncovered: string[] = [];
  for (const [id, branchCounts] of Object.entries(data.b)) {
    total += branchCounts.length;
    branchCounts.forEach((count, index) => {
      if (count > 0) {
        hit += 1;
        return;
      }
      const meta = data.branchMap[id];
      if (meta === undefined) return;
      uncovered.push(`L${meta.loc.start.line} ${meta.type} #${index}`);
    });
  }

  if (uncovered.length > 0) {
    console.log(`${rel}`);
    for (const u of uncovered) console.log(`    ${u}`);
  }
}

console.log(`\nsafety branch coverage: ${hit}/${total} = ${((100 * hit) / total).toFixed(2)}%`);
