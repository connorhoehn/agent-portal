// Model bake-off for the Decide call: each candidate runs the decide-layer scenarios (with context: last lines, Milo's last action,
// round state) through the stand-in decide rig. Scored on accuracy and error direction with exact-match graders; a scenario counts only
// when every one of its runs is right (pass^3). Tuned on dev; the hold-out (split from dev by seed phrasing) is reported as totals only.
// LIVE: needs the OpenAI key. Usage: npm run milo-judge:bakeoff -- [--models a,b,c] [--runs 3] [--out path.md]
import { writeFileSync } from 'node:fs';
import { decide, type DecideInput, type DecideResult } from './decide.mts';
import { decideRig } from './rigs.mts';
import { TRIALS, loadCorpus, pct, runTrials } from './runner.mts';
import { totals } from './score.mts';

const arg = (k: string, d: string): string => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] ?? d : d; };
const models = arg('models', 'gpt-4.1-mini,gpt-5.4-nano,gpt-5.4-mini,gpt-5.6-luna,gpt-6-luna,gpt-4.1').split(',');
const runs = Math.max(1, Number(arg('runs', String(TRIALS))) || TRIALS);
const out = arg('out', '');

const dev = loadCorpus('dev').filter((s) => s.layer === 'decide');
const hold = loadCorpus('holdout').filter((s) => s.layer === 'decide');
const q = (xs: number[], p: number): number => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]! : 0);

interface Row { model: string; action: string; silence: string; unsteady: number; falseSpeech: number; falseWrite: number; falseSilence: number; refusal: number; wrongTool: number; wrongContent: number; allow: string; apiErrors: number; p50: number; p90: number; holdAction: string; holdSilence: string; misses: Map<string, number> }
const rows: Row[] = [];

for (const model of models) {
  const ms: number[] = [];
  let apiErrors = 0;
  const call = async (m: string, i: DecideInput): Promise<DecideResult> => { const r = await decide(m, i); ms.push(r.ms); if (r.error) apiErrors += 1; return r; };
  const all = await runTrials(decideRig(model, call), dev, runs);
  const t = totals(all);
  const h = totals(await runTrials(decideRig(model, call), hold, runs));
  const misses = new Map<string, number>();
  for (const s of all) if (s.problems.length) misses.set(s.id, s.trials - s.cleanTrials);
  rows.push({ model, action: pct(t.action), silence: pct(t.silence), unsteady: t.unsteady, falseSpeech: t.errors.false_speech, falseWrite: t.errors.false_write, falseSilence: t.errors.false_silence, refusal: t.errors.refusal, wrongTool: t.errors.wrong_tool, wrongContent: t.errors.wrong_words + t.errors.wrong_args, allow: pct(t.allowList), apiErrors, p50: q(ms, 0.5), p90: q(ms, 0.9), holdAction: pct(h.action), holdSilence: pct(h.silence), misses });
  console.log(`${model}: dev pass^${runs} action ${pct(t.action)} silence ${pct(t.silence)} unsteady=${t.unsteady} fs=${t.errors.false_speech} fw=${t.errors.false_write} fsil=${t.errors.false_silence} api-errors=${apiErrors}`);
}

const devById = new Map(dev.map((s) => [s.id, s]));
const md: string[] = [
  `# Milo Decide model bake-off (${new Date().toISOString().slice(0, 10)})`,
  '',
  `Stand-in decide call (name gate, hold, last three lines, Milo's last action, round state) on the FINAL sentence; \`store: false\`, reasoning off for gpt-5/6. Dev corpus: ${dev.length} decide-layer scenarios x ${runs} runs; action, silence and allow-list count a scenario only when all ${runs} runs are right (pass^${runs}); unsteady = right in some runs, wrong in others. Graders are exact match: the tool, the person, the tool's exact arguments, the exact words. The error columns count every run. Error directions: false speech = Milo spoke when it should not; false write = a write tool ran when it should not; false silence = no line when one was wanted. API errors fall back to silence, so they count as false silence; the column shows how many there were.`,
  '',
  '| model | action | silence | unsteady | false speech | false write | false silence | refusal/wrong tool/words or args | allow-list | api errors | call p50 / p90 ms | hold-out action / silence (totals only) |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.model} | ${r.action} | ${r.silence} | ${r.unsteady} | ${r.falseSpeech} | ${r.falseWrite} | ${r.falseSilence} | ${r.refusal}/${r.wrongTool}/${r.wrongContent} | ${r.allow} | ${r.apiErrors} | ${r.p50} / ${r.p90} | ${r.holdAction} / ${r.holdSilence} |`),
  '',
  '## Dev scenarios each model missed (id, tags, runs missed of ' + runs + ')',
  ...rows.map((r) => `- ${r.model}: ${[...r.misses].map(([id, c]) => `${id} [${devById.get(id)?.tags.join(',')}] x${c}`).join('; ') || 'none'}`),
];
if (out) writeFileSync(out, md.join('\n') + '\n');
console.log(md.slice(5, 7 + rows.length).join('\n'));
