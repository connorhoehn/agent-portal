// Fixture prose checks for the demo-content judge (docs/demo-content-goal.md
// checks F2/F3): repeated sentence templates across every registered fixture's
// rows (one sentence pasted over fifty evidence rows is filler), and literal
// calendar dates baked into row text (a date that does not move with the mock
// clock is wrong the week after it was written).
//   (cd middleware && npx tsx ../scripts/demo-content/prose.mts) [--json]
import { loadFixtures } from './fixtures.mts';
// @ts-ignore — plain ESM helper shared with the probe
import { repeatedTemplates, LITERAL_DATE } from './rubric.mjs';

const fixtures = await loadFixtures();
const repeated: Array<{ fixture: string; file: string | null; n: number; example: string }> = [];
const dates: Array<{ fixture: string; file: string | null; value: string; context: string }> = [];
const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
};
for (const f of fixtures) {
  const all = strings(f.rows);
  for (const r of repeatedTemplates(all)) repeated.push({ fixture: f.key, file: f.file, n: r.n, example: r.example });
  const seen = new Set<string>();
  for (const s of all) {
    // A stored timestamp field is the clock's (rule 3); copy is what a peer reads.
    if (/^\d{4}-\d{2}-\d{2}T/.test(s) || s.length < 12 || !/\s/.test(s)) continue;
    for (const m of s.matchAll(LITERAL_DATE)) {
      if (seen.has(m[0])) continue;
      seen.add(m[0]);
      dates.push({ fixture: f.key, file: f.file, value: m[0], context: s.slice(Math.max(0, m.index! - 40), m.index! + 60) });
    }
  }
}
repeated.sort((a, b) => b.n - a.n);
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ repeated, dates }, null, 1) + '\n');
else {
  for (const r of repeated) console.log(`repeated\t${r.fixture}\t${r.file}\t${r.n}×\t${r.example}`);
  for (const d of dates) console.log(`date\t${d.fixture}\t${d.file}\t${d.value}\t${d.context}`);
  console.log(`# ${repeated.length} repeated templates, ${dates.length} literal dates`);
}
