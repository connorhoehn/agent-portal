// The Milo judge. Usage (from middleware/):
//   npm run milo-judge -- [--rig owner|scripted|decide|perfect] [--model gpt-5.4-mini] [--set dev|holdout|both] [--trials 3] [--verbose] [--require-owner]
//   owner     the real turn owner on the fake clock (the gate). Until lanes 1A/1B merge and owner-adapter.mts is bound, every scenario is
//             "needs turn owner": skipped, exit 0. --require-owner makes that exit 3 (use it for the gate itself).
//   scripted  OFFLINE: the stand-in decide rig with a scripted model that answers as the truth says. Checks corpus, gates and scorer.
//   decide    LIVE: the stand-in decide rig with one minimal decide call per request (needs the OpenAI key). Not the gate.
//   perfect   the scorer's self-test (a perfect log must score 100%).
// scripted and decide run decide-layer scenarios; floor-layer ones need the turn owner and are skipped, never failed.
// Each scenario runs --trials times and passes only if every trial passes (pass^3). Graders are exact match (score.mts).
// The hold-out set prints totals only, never scenario text or ids. `npm run milo-judge:test` is the offline test suite.
import { decideRig, perfectRig, scriptedRig, type Rig } from './rigs.mts';
import { fakeClock } from './fake-clock.mts';
import { ownerPresent, ownerRig } from './owner-adapter.mts';
import { TRIALS, loadCorpus, pct, runTrials, type CorpusName } from './runner.mts';
import { totals } from './score.mts';

const arg = (k: string, d: string): string => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] ?? d : d; };
const RIGS = ['owner', 'scripted', 'decide', 'perfect'] as const;
const rigName = arg('rig', 'owner') as (typeof RIGS)[number];
if (!RIGS.includes(rigName)) { console.error(`unknown --rig ${rigName}: use ${RIGS.join(', ')}`); process.exit(2); }
const model = arg('model', 'gpt-5.4-mini');
const setArg = arg('set', 'both');
if (!['dev', 'holdout', 'both'].includes(setArg)) { console.error(`unknown --set ${setArg}: use dev, holdout or both`); process.exit(2); }
const sets: CorpusName[] = setArg === 'both' ? ['dev', 'holdout'] : [setArg as CorpusName];
const trials = Math.max(1, Number(arg('trials', String(TRIALS))) || TRIALS);
const verbose = process.argv.includes('--verbose');
const requireOwner = process.argv.includes('--require-owner');

const rigs: Record<Exclude<(typeof RIGS)[number], 'owner'>, Rig> = { perfect: perfectRig, scripted: scriptedRig, decide: decideRig(model) };
const rig: Rig | null = rigName === 'owner' ? (ownerPresent() ? ownerRig(() => fakeClock()) : null) : rigs[rigName];
const decideLayerOnly = rigName === 'decide' || rigName === 'scripted';
let exit = 0;
for (const set of sets) {
  const all = loadCorpus(set);
  const runnable = decideLayerOnly ? all.filter((s) => s.layer === 'decide') : all;
  const skipped = all.length - runnable.length;
  if (!rig) {
    console.log(`${set} [owner] needs turn owner: ${all.length} scenarios SKIPPED (turn/turn-owner.ts is not on this branch yet)`);
    if (requireOwner) exit = 3;
    continue;
  }
  const scores = await runTrials(rig, runnable, trials);
  const t = totals(scores);
  console.log(`${set} [${rigName}${rigName === 'decide' ? ` ${model}` : ''}] ${t.scenarios} scenarios on ${t.seeds} seed phrasings, pass^${t.trials}${skipped ? `; ${skipped} floor-layer SKIPPED (needs turn owner)` : ''}`);
  console.log(`  allow-list ${pct(t.allowList)}  silence ${pct(t.silence)}  action ${pct(t.action)}  content ${pct(t.content)}  unsteady ${t.unsteady}`);
  console.log(`  errors over all trials: ${Object.entries(t.errors).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`);
  const pass = Object.values(t.pass).every(Boolean);
  console.log(`  gate ${pass ? 'PASS' : 'FAIL'} (${Object.entries(t.pass).map(([k, v]) => `${k}:${v ? 'ok' : 'no'}`).join(' ')})`);
  if (!pass && rigName !== 'decide') exit = exit || 1;
  if (verbose && set === 'dev') for (const s of scores.filter((x) => x.problems.length)) console.log(`  - ${s.id} [${s.tags.join(',')}] ${s.cleanTrials}/${s.trials} clean: ${s.problems.map((p) => `${p.kind}: ${p.detail}`).join('; ')}`);
}
process.exit(exit);
