// The Milo judge. Usage (from middleware/): npm run milo-judge -- [--rig decide|owner|perfect] [--model gpt-5.4-nano] [--set dev|holdout|both] [--verbose]
//   owner    the real turn owner on the fake clock (the gate). Exits 3 "needs turn owner" until lanes 1A/1B merge and owner-adapter.mts is bound.
//   decide   the stand-in decide rig (name gate + one minimal decide call); runs decide-layer scenarios only. Not the gate.
//   perfect  the scorer's self-test (a perfect log must score 100%).
// The hold-out set prints totals only, never scenario text or ids.
import { decideRig, perfectRig, type Rig } from './rigs.mts';
import { fakeClock } from './fake-clock.mts';
import { ownerPresent, ownerRig } from './owner-adapter.mts';
import { loadCorpus, pct, runAll, type CorpusName } from './runner.mts';
import { totals } from './score.mts';

const arg = (k: string, d: string): string => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] ?? d : d; };
const rigName = arg('rig', 'owner');
const model = arg('model', 'gpt-5.4-nano');
const sets: CorpusName[] = arg('set', 'both') === 'both' ? ['dev', 'holdout'] : [arg('set', 'dev') as CorpusName];
const verbose = process.argv.includes('--verbose');

const rig: Rig | null = rigName === 'perfect' ? perfectRig : rigName === 'decide' ? decideRig(model) : ownerPresent() ? ownerRig(() => fakeClock()) : null;
let exit = 0;
for (const set of sets) {
  const all = loadCorpus(set);
  const runnable = rigName === 'decide' ? all.filter((s) => s.layer === 'decide') : all;
  const skipped = all.length - runnable.length;
  if (!rig) {
    console.log(`${set}: NEEDS TURN OWNER (turn/turn-owner.ts is not on this branch yet): ${all.length} scenarios not run`);
    exit = 3;
    continue;
  }
  const scores = await runAll(rig, runnable);
  const t = totals(scores);
  console.log(`${set} [${rigName}${rigName === 'decide' ? ` ${model}` : ''}] ${t.scenarios} scenarios${skipped ? ` (${skipped} floor-layer need the turn owner)` : ''}`);
  console.log(`  allow-list ${pct(t.allowList)}  silence ${pct(t.silence)}  action ${pct(t.action)}  content ${pct(t.content)}`);
  console.log(`  errors ${Object.entries(t.errors).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`);
  const pass = Object.values(t.pass).every(Boolean);
  console.log(`  gate ${pass ? 'PASS' : 'FAIL'} (${Object.entries(t.pass).map(([k, v]) => `${k}:${v ? 'ok' : 'no'}`).join(' ')})`);
  if (!pass && rigName !== 'decide') exit = exit || 1;
  if (verbose && set === 'dev') for (const s of scores.filter((x) => x.problems.length)) console.log(`  - ${s.id} [${s.tags.join(',')}] ${s.problems.map((p) => `${p.kind}: ${p.detail}`).join('; ')}`);
}
process.exit(exit);
