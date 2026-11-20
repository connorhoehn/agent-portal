// Model bake-off for the Decide call: each candidate runs the decide-layer scenarios (with context: last lines, Milo's last action,
// round state) through the stand-in decide rig. Scored on accuracy and error direction. Tuned on dev; the hold-out is reported as totals only.
// Usage: npm run milo-judge:bakeoff -- [--models a,b,c] [--runs 2] [--out path.md]
import { writeFileSync } from 'node:fs';
import { decide, type DecideInput, type DecideResult } from './decide.mts';
import { decideRig } from './rigs.mts';
import { loadCorpus, pct, runAll } from './runner.mts';
import { totals, type ScenarioScore } from './score.mts';

const arg = (k: string, d: string): string => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] ?? d : d; };
const models = arg('models', 'gpt-4.1-mini,gpt-5.4-nano,gpt-5.4-mini,gpt-5.6-luna,gpt-6-luna,gpt-4.1').split(',');
const runs = Number(arg('runs', '2'));
const out = arg('out', '');

const dev = loadCorpus('dev').filter((s) => s.layer === 'decide');
const hold = loadCorpus('holdout').filter((s) => s.layer === 'decide');
const q = (xs: number[], p: number): number => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]! : 0);

interface Row { model: string; n: number; action: string; silence: string; falseSpeech: number; falseWrite: number; falseSilence: number; refusal: number; wrongTool: number; wrongWords: number; allow: string; apiErrors: number; p50: number; p90: number; holdAction: string; holdSilence: string; misses: Map<string, number> }
const rows: Row[] = [];

for (const model of models) {
  const ms: number[] = [];
  let apiErrors = 0;
  const call = async (m: string, i: DecideInput): Promise<DecideResult> => { const r = await decide(m, i); ms.push(r.ms); if (r.error) apiErrors += 1; return r; };
  const all: ScenarioScore[] = [];
  for (let r = 0; r < runs; r += 1) all.push(...(await runAll(decideRig(model, call), dev, 6)));
  const t = totals(all);
  const holdScores = await runAll(decideRig(model, call), hold, 6);
  const h = totals(holdScores);
  const misses = new Map<string, number>();
  for (const s of all) if (s.problems.length) misses.set(s.id, (misses.get(s.id) ?? 0) + 1);
  rows.push({ model, n: all.length, action: pct(t.action), silence: pct(t.silence), falseSpeech: t.errors.false_speech, falseWrite: t.errors.false_write, falseSilence: t.errors.false_silence, refusal: t.errors.refusal, wrongTool: t.errors.wrong_tool, wrongWords: t.errors.wrong_words, allow: pct(t.allowList), apiErrors, p50: q(ms, 0.5), p90: q(ms, 0.9), holdAction: pct(h.action), holdSilence: pct(h.silence), misses });
  console.log(`${model}: dev action ${pct(t.action)} silence ${pct(t.silence)} fs=${t.errors.false_speech} fw=${t.errors.false_write} fsil=${t.errors.false_silence} api-errors=${apiErrors}`);
}

const devById = new Map(dev.map((s) => [s.id, s]));
const md: string[] = [
  `# Milo Decide model bake-off (${new Date().toISOString().slice(0, 10)})`,
  '',
  `Stand-in decide call (name gate, follow-up window, hold, last three lines, Milo's last action, round state) on the FINAL sentence; \`store: false\`, reasoning off for gpt-5/6. Dev corpus: ${dev.length} decide-layer scenarios x ${runs} runs. Scored on the logged line (action and exact words). Error directions: false speech = Milo spoke when it should not; false write = a write tool ran when it should not; false silence = no line when one was wanted. API errors fall back to silence, so they count as false silence; the column shows how many there were.`,
  '',
  '| model | action | silence | false speech | false write | false silence | refusal/wrong tool/words | allow-list | api errors | call p50 / p90 ms | hold-out action / silence (totals only) |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.model} | ${r.action} | ${r.silence} | ${r.falseSpeech} | ${r.falseWrite} | ${r.falseSilence} | ${r.refusal}/${r.wrongTool}/${r.wrongWords} | ${r.allow} | ${r.apiErrors} | ${r.p50} / ${r.p90} | ${r.holdAction} / ${r.holdSilence} |`),
  '',
  '## Dev scenarios each model missed (id, tags, miss count of ' + runs + ')',
  ...rows.map((r) => `- ${r.model}: ${[...r.misses].map(([id, c]) => `${id} [${devById.get(id)?.tags.join(',')}] x${c}`).join('; ') || 'none'}`),
];
if (out) writeFileSync(out, md.join('\n') + '\n');
console.log(md.slice(5, 7 + rows.length).join('\n'));
