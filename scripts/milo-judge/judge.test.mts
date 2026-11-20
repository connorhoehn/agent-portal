// The judge's own tests, and the judge in its offline (scripted) mode: the truth is pinned to the product's constants, the graders are
// exact match, a scenario passes only when all three trials pass, a perfect log scores 100%, the fake clock fires timers in order, the
// hold-out is split from dev by seed phrasing, and every decide-layer scenario passes with the scripted model. Scenarios that need the
// turn owner are SKIPPED with the reason "needs turn owner" until turn/turn-owner.ts is on the branch. No network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MILO_CAN_DO, MILO_INTRO, NO_QUESTION_YET, T0, timeLeftTruth } from './truth.mts';
import { fakeClock } from './fake-clock.mts';
import { perfectRig, decideRig, scriptedRig, type Rig } from './rigs.mts';
import { TRIALS, loadCorpus, runAll, runTrials } from './runner.mts';
import { passEvery, scoreScenario, totals } from './score.mts';
import { seedOf, sharedSeeds } from './seed.mts';
import { ownerPresent, ownerRig } from './owner-adapter.mts';
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
const out = (logged: { who: string; action: any; words?: string; args?: Record<string, unknown> }[]) => ({ logged: logged.map((l) => ({ ...l, atMs: 60_000 })), decideRequests: [] });

test('the scorer names each error direction', () => {
  const kinds = (s: Scenario, o: ReturnType<typeof out>) => scoreScenario(s, o).problems.map((p) => p.kind);
  assert.deepEqual(kinds(base, out([{ who: 'alex', action: 'cannot_help', words: MILO_CAN_DO }])), []);
  assert.deepEqual(kinds(base, out([])), ['false_silence']);
  assert.deepEqual(kinds(base, out([{ who: 'alex', action: 'cannot_help', words: 'I cannot do that.' }])), ['wrong_words', 'false_speech']);
  const silent: Scenario = { ...base, expect: [{ who: 'alex', action: 'silent' }] };
  assert.ok(kinds(silent, out([{ who: 'alex', action: 'time_left', words: 'About 25 minutes are left in this round.' }])).includes('false_speech'));
  assert.ok(kinds(silent, out([{ who: 'dana', action: 'pad_write' }])).includes('false_write'));
});

test('tool calls are graded by exact match: the tool, the person, exactly its arguments, the asked-for words as whole words', () => {
  const pad: Scenario = { ...base, events: [{ atMs: 60_000, kind: 'sentence', who: 'dana', text: 'Milo, write a test for the empty list.' }], expect: [{ who: 'dana', action: 'pad_write', argHas: 'empty list' }] };
  const kinds = (o: ReturnType<typeof out>) => scoreScenario(pad, o).problems.map((p) => p.kind);
  assert.deepEqual(kinds(out([{ who: 'dana', action: 'pad_write', args: { text: 'A test for the EMPTY list.' } }])), []);
  assert.deepEqual(kinds(out([{ who: 'dana', action: 'pad_write', args: { text: 'a test for the non-emptying listing' } }])), ['wrong_args']);
  assert.deepEqual(kinds(out([{ who: 'dana', action: 'pad_write', args: { text: 'a test for the list when empty' } }])), ['wrong_args']);
  assert.deepEqual(kinds(out([{ who: 'dana', action: 'pad_write', args: { 'empty list': 'x', text: 'a test' } }])), ['wrong_args']);
  assert.deepEqual(kinds(out([{ who: 'dana', action: 'pad_write', args: { text: 'a test for the empty list', language: 'python' } }])), ['wrong_args']);
  assert.deepEqual(kinds(out([{ who: 'dana', action: 'pad_write', args: { text: '  ' } }])), ['wrong_args']);
  assert.deepEqual(kinds(out([{ who: 'dana', action: 'pad_write' }])), ['wrong_args']);
  assert.deepEqual(kinds(out([{ who: 'sam', action: 'pad_write', args: { text: 'a test for the empty list' } }])), ['wrong_person']);
  // A tool that takes no arguments must be logged with none.
  const leave: Scenario = { ...base, events: [{ atMs: 60_000, kind: 'sentence', who: 'dana', text: 'Milo, you can leave.' }], expect: [{ who: 'dana', action: 'leave_call' }] };
  assert.deepEqual(scoreScenario(leave, out([{ who: 'dana', action: 'leave_call', args: {} }])).problems, []);
  assert.deepEqual(scoreScenario(leave, out([{ who: 'dana', action: 'leave_call', args: { reason: 'asked' } }])).problems.map((p) => p.kind), ['wrong_args']);
  // Wrong arguments are a content error (the tool was right); a wrong person or tool is an action error.
  const wrongArgs = scoreScenario(leave, out([{ who: 'dana', action: 'leave_call', args: { reason: 'asked' } }]));
  assert.deepEqual([wrongArgs.actionOk, wrongArgs.contentOk], [true, false]);
  assert.equal(scoreScenario(leave, out([{ who: 'dana', action: 'pause_listening' }])).actionOk, false);
});

test(`a scenario passes only when all ${TRIALS} trials pass (pass^${TRIALS})`, async () => {
  assert.equal(TRIALS, 3);
  let run = 0;
  // Right in trials 1 and 2, silent in trial 3.
  const wobbly: Rig = async (s) => { run += 1; return run === 3 ? { logged: [], decideRequests: [] } : perfectRig(s); };
  const [score] = await runTrials(wobbly, [base]);
  assert.deepEqual([score!.trials, score!.cleanTrials, score!.actionOk, score!.contentOk], [3, 2, false, null]);
  assert.match(score!.problems[0]!.detail, /^trial 3: /);
  const t = totals([score!]);
  assert.deepEqual([t.action, t.unsteady, t.trials, t.errors.false_silence], [{ ok: 0, of: 1 }, 1, 3, 1]);
  const steady = totals(await runTrials(perfectRig, [base]));
  assert.deepEqual([steady.action, steady.unsteady], [{ ok: 1, of: 1 }, 0]);
  // Content and the allow-list fold the same way: one bad trial fails the scenario.
  const good = scoreScenario(base, out([{ who: 'alex', action: 'cannot_help', words: MILO_CAN_DO }]));
  const bad = scoreScenario(base, out([{ who: 'alex', action: 'cannot_help', words: 'Sure, here is a hint' }]));
  const [folded] = passEvery([[good], [good], [bad]]);
  assert.deepEqual([folded!.allowListOk, folded!.actionOk], [false, false]);
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

test('the corpus keeps its invariants: unique ids, both layers, time words from the round', () => {
  const dev = loadCorpus('dev');
  const hold = loadCorpus('holdout');
  for (const set of [dev, hold]) assert.equal(new Set(set.map((s) => s.id)).size, set.length);
  assert.ok(hold.length >= 60 && dev.length >= 100);
  for (const set of [dev, hold]) assert.ok(set.some((s) => s.layer === 'floor') && set.some((s) => s.layer === 'decide'));
  for (const s of [...dev, ...hold]) for (const e of s.expect) if (e.action === 'time_left') assert.equal(e.words, '@time_left');
});

test('the hold-out file opens by telling builders not to read it', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(resolve(here, 'corpus/holdout.json'), 'utf8');
  assert.equal(Object.keys(JSON.parse(raw))[0], '_readme');
  assert.match(raw.slice(0, 120), /HOLD-OUT CORPUS\. BUILDERS: DO NOT READ, GREP, OR TUNE AGAINST THIS FILE/);
});

test('the hold-out is split from dev by seed phrasing: no wording under test is on both sides, with or without the name', () => {
  const dev = loadCorpus('dev');
  const hold = loadCorpus('holdout');
  // Totals only: a failure must not print hold-out wording.
  assert.equal(sharedSeeds(dev, hold).length, 0, 'hold-out scenarios share a seed phrasing with dev');
  for (const s of [...dev, ...hold]) assert.ok(seedOf(s).length > 0, `${s.id.startsWith('dev') ? s.id : 'a hold-out scenario'} has an empty seed`);
  const one: Scenario = { ...base, events: [{ atMs: 0, kind: 'sentence', who: 'dana', text: 'Milo, how much time is left?' }] };
  const moved: Scenario = { ...base, events: [{ atMs: 0, kind: 'sentence', who: 'dana', text: 'Milo, time?' }, { atMs: 9, kind: 'sentence', who: 'dana', text: 'How much time is left, please, Mylo' }] };
  assert.equal(seedOf(one), 'how much time is left');
  assert.deepEqual(sharedSeeds([one], [moved]), ['how much time is left']);
  assert.equal(seedOf({ ...moved, seed: 'Time check' }), 'time check');
});

// The judge in its offline mode: the stand-in decide rig with the scripted model, on both corpora, three trials each.
for (const name of ['dev', 'holdout'] as const) {
  test(`offline judge (scripted model) passes every decide-layer scenario on ${name}, pass^${TRIALS}`, async () => {
    const t = totals(await runTrials(scriptedRig, loadCorpus(name).filter((s) => s.layer === 'decide')));
    assert.deepEqual(t.pass, { allowList: true, silence: true, action: true, content: true });
    assert.deepEqual([t.action.ok, t.silence.ok, t.unsteady], [t.action.of, t.silence.of, 0]);
    assert.ok(t.action.of > 0 && t.silence.of > 0);
  });
}

// Floor-layer scenarios (split requests, echo, two lanes, pause and leave) only mean something through the real turn owner.
// Until it is on the branch they are skipped, not failed. Once it is, they run, and an unbound adapter fails loudly.
const NEEDS_OWNER = ownerPresent() ? false : 'needs turn owner';
for (const s of loadCorpus('dev').filter((x) => x.layer === 'floor')) {
  test(`turn owner: ${s.id} [${s.tags.join(', ')}]`, { skip: NEEDS_OWNER }, async () => {
    const [score] = await runTrials(ownerRig(() => fakeClock()), [s]);
    assert.deepEqual(score!.problems, []);
  });
}
test('turn owner: the hold-out floor-layer scenarios (totals only)', { skip: NEEDS_OWNER }, async () => {
  const t = totals(await runTrials(ownerRig(() => fakeClock()), loadCorpus('holdout').filter((x) => x.layer === 'floor')));
  assert.deepEqual([t.action.ok, t.silence.ok, t.content.ok, t.allowList.ok], [t.action.of, t.silence.of, t.content.of, t.allowList.of]);
});

test('the decide rig makes no call for a declined candidate, a sentence with no name, no follow-up and no hold', async () => {
  let calls = 0;
  const rig = decideRig('fake', async () => { calls += 1; return { action: 'stay_silent', args: {}, ms: 1, model: 'fake' }; });
  const decideScenarios = loadCorpus('dev').filter((s) => s.layer === 'decide' && (s.noModelCall || s.tags.includes('chatter')));
  await runAll(rig, decideScenarios);
  assert.equal(calls, 0);
});
