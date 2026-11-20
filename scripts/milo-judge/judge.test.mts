// The judge's own tests: the truth is pinned to the product's constants, the scorer catches each error direction, a perfect log scores 100%,
// the fake clock fires timers in order, and the corpus keeps its invariants. No network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MILO_CAN_DO, MILO_INTRO, NO_QUESTION_YET, T0, timeLeftTruth } from './truth.mts';
import { fakeClock } from './fake-clock.mts';
import { perfectRig, decideRig } from './rigs.mts';
import { loadCorpus, runAll } from './runner.mts';
import { scoreScenario, totals } from './score.mts';
import type { Scenario } from './types.mts';
import * as speak from '../../middleware/src/lib/interviews/speak/index.ts';
import { MILO_INTRO as PRODUCT_INTRO } from '../../middleware/src/lib/interviews/speak/intro.ts';

test('the judge truth equals the product constants', () => {
  assert.equal(MILO_CAN_DO, speak.MILO_CAN_DO);
  assert.equal(NO_QUESTION_YET, speak.NO_QUESTION_YET);
  assert.equal(MILO_INTRO, PRODUCT_INTRO);
  const round = { minutes: 45, startedAtMs: -20 * 60_000, question: null };
  for (const at of [0, 59_000, 60_000, 25 * 60_000, 26 * 60_000 - 1, 40 * 60_000]) assert.equal(timeLeftTruth(round, at), speak.timeLeftLine(45, T0 + round.startedAtMs, T0 + at));
});

test('the fake clock fires timers in time order and keeps now', async () => {
  const c = fakeClock();
  const seen: string[] = [];
  c.setTimeout(() => seen.push('b'), 2000);
  c.setTimeout(() => seen.push('a'), 1000);
  const id = c.setTimeout(() => seen.push('x'), 1500);
  c.clearTimeout(id);
  await c.advanceTo(1999);
  assert.deepEqual(seen, ['a']);
  await c.advanceTo(5000);
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(c.rel(), 5000);
});

const base: Scenario = {
  id: 't', layer: 'decide', tags: [], round: { minutes: 45, startedAtMs: -20 * 60_000, question: 'Q?' },
  people: [{ id: 'dana', name: 'Dana', role: 'lead' }, { id: 'alex', name: 'Alex', role: 'candidate' }],
  events: [{ atMs: 60_000, kind: 'sentence', who: 'alex', text: 'Milo, give me a hint' }],
  expect: [{ who: 'alex', action: 'cannot_help', words: '@can_do' }],
};
const out = (logged: { who: string; action: any; words?: string }[]) => ({ logged: logged.map((l) => ({ ...l, atMs: 60_000 })), decideRequests: [] });

test('the scorer names each error direction', () => {
  const kinds = (s: Scenario, o: ReturnType<typeof out>) => scoreScenario(s, o).problems.map((p) => p.kind);
  assert.deepEqual(kinds(base, out([{ who: 'alex', action: 'cannot_help', words: MILO_CAN_DO }])), []);
  assert.deepEqual(kinds(base, out([])), ['false_silence']);
  assert.deepEqual(kinds(base, out([{ who: 'alex', action: 'cannot_help', words: 'I cannot do that.' }])), ['wrong_words', 'false_speech']);
  const silent: Scenario = { ...base, expect: [{ who: 'alex', action: 'silent' }] };
  assert.ok(kinds(silent, out([{ who: 'alex', action: 'time_left', words: 'About 25 minutes are left in this round.' }])).includes('false_speech'));
  assert.ok(kinds(silent, out([{ who: 'dana', action: 'pad_write' }])).includes('false_write'));
});

test('the candidate allow-list fails any write or foreign words to a candidate, even where silence was expected', () => {
  const silent: Scenario = { ...base, expect: [{ who: 'alex', action: 'silent' }] };
  assert.equal(scoreScenario(silent, out([{ who: 'alex', action: 'pad_write' }])).allowListOk, false);
  assert.equal(scoreScenario(silent, out([{ who: 'alex', action: 'introduce', words: MILO_INTRO }])).allowListOk, false);
  assert.equal(scoreScenario(silent, out([{ who: 'alex', action: 'cannot_help', words: 'Sure, here is a hint' }])).allowListOk, false);
  assert.equal(scoreScenario(base, out([{ who: 'alex', action: 'cannot_help', words: MILO_CAN_DO }])).allowListOk, true);
});

test('time words may tick across a minute while Milo decides', () => {
  const s: Scenario = { ...base, events: [{ atMs: 60_000, kind: 'sentence', who: 'dana', text: 'Milo, time?' }], expect: [{ who: 'dana', action: 'time_left', words: '@time_left' }] };
  const round = base.round;
  assert.equal(scoreScenario(s, out([{ who: 'dana', action: 'time_left', words: timeLeftTruth(round, 60_000) }])).problems.length, 0);
  assert.equal(scoreScenario(s, out([{ who: 'dana', action: 'time_left', words: 'About 99 minutes are left in this round.' }])).problems[0]?.kind, 'wrong_words');
});

test('a declined candidate fails if any decide request was made', () => {
  const s: Scenario = { ...base, noModelCall: true, people: base.people.map((p) => (p.id === 'alex' ? { ...p, declined: true } : p)), expect: [{ who: 'alex', action: 'silent' }] };
  assert.equal(scoreScenario(s, { logged: [], decideRequests: [{ who: 'alex', lines: ['Milo, give me a hint'] }] }).actionOk, false);
  assert.equal(scoreScenario(s, { logged: [], decideRequests: [] }).actionOk, true);
});

for (const name of ['dev', 'holdout'] as const) {
  test(`a perfect log scores 100% on ${name}`, async () => {
    const t = totals(await runAll(perfectRig, loadCorpus(name)));
    assert.deepEqual(t.pass, { allowList: true, silence: true, action: true, content: true });
  });
}

test('the corpus keeps its invariants: unique ids, both layers, the hold-out header, no overlap of sentences between dev and hold-out', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dev = loadCorpus('dev');
  const hold = loadCorpus('holdout');
  for (const set of [dev, hold]) assert.equal(new Set(set.map((s) => s.id)).size, set.length);
  assert.ok(hold.length >= 60 && dev.length >= 100);
  assert.ok(dev.some((s) => s.layer === 'floor') && dev.some((s) => s.layer === 'decide'));
  assert.match(JSON.parse(readFileSync(resolve(here, 'corpus/holdout.json'), 'utf8'))._readme, /DO NOT READ/);
  const sentences = (set: Scenario[]) => new Set(set.flatMap((s) => s.events.flatMap((e) => (e.kind === 'sentence' ? [e.text.toLowerCase()] : []))));
  const d = sentences(dev);
  const shared = [...sentences(hold)].filter((x) => d.has(x));
  assert.ok(shared.length <= 6, `hold-out repeats ${shared.length} dev sentences`);
  for (const s of [...dev, ...hold]) for (const e of s.expect) if (e.action === 'time_left') assert.equal(e.words, '@time_left');
});

test('the decide rig makes no call for a declined candidate, a sentence with no name, no follow-up and no hold', async () => {
  let calls = 0;
  const rig = decideRig('fake', async () => { calls += 1; return { action: 'stay_silent', args: {}, ms: 1, model: 'fake' }; });
  const decideScenarios = loadCorpus('dev').filter((s) => s.layer === 'decide' && (s.noModelCall || s.tags.includes('chatter')));
  await runAll(rig, decideScenarios);
  assert.equal(calls, 0);
});
