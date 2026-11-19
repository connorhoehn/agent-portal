// Scripted gate tests (no key, no network): the scenario set, the player and the scoring against the fake driver.
//   cd middleware && npx tsx --test ../scripts/voice-harness/gate.test.mts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakePort, type FakeProfile } from './gate-port-fake.mjs';
import { playScenario } from './gate-player.mjs';
import { virtualClock } from './gate-clock.mjs';
import { GATE, gateScenarios, pct, scoreGate, scoreScenario, type RunObs } from './gate-spec.mjs';

const clipFor = (): Buffer => Buffer.alloc(4_800 * 20); // 2 s of silence: the fake driver does not listen

async function run(id: string, profile: Partial<FakeProfile> = {}): Promise<RunObs> {
  const sc = gateScenarios().find((s) => s.id === id)!;
  const clips: Record<string, Buffer> = {};
  for (const s of sc.steps) if (s.clip) clips[s.clip] = clipFor();
  return playScenario(sc, fakePort(profile), { clips, clock: virtualClock(), instructions: 'test' });
}
const failing = (checks: ReturnType<typeof scoreScenario>): string[] => checks.filter((c) => c.pass === false).map((c) => c.id);

test('the scenario set matches the plan (counts, voices)', () => {
  const by = Object.fromEntries(gateScenarios().map((s) => [s.id, s]));
  assert.equal(by['name-first']!.steps.length, GATE.nameFirst.tries);
  assert.deepEqual(new Set(by['name-first']!.steps.map((s) => s.speaker)), new Set(['hugo', 'cand']));
  assert.equal(by['name-last']!.steps.length, GATE.nameLast.tries);
  assert.equal(by['follow-up']!.steps.filter((s) => /^f\d\d$/.test(s.clip ?? '')).length, GATE.followUp.tries);
  assert.equal(by['chatter']!.steps.length, GATE.chatter.runs * 5);
  assert.equal(by['mentions']!.steps.length, GATE.mentions.clips);
  assert.deepEqual(new Set(by['asker']!.steps.map((s) => s.speaker)), new Set(['hugo', 'cand']));
  assert.equal(gateScenarios().length, 11);
});

test('percentile is nearest-rank', () => {
  assert.equal(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(pct([], 50), null);
});

test('the ideal behaviour passes every scenario', async () => {
  const runs: RunObs[] = [];
  for (const sc of gateScenarios()) runs.push(await run(sc.id));
  const res = scoreGate(runs, { requireAll: true });
  assert.deepEqual(res.checks.filter((c) => c.pass !== true).map((c) => `${c.id}: ${c.value}`), []);
  assert.equal(res.ok, true);
});

test('a skipped scenario is not a pass, and requireAll fails on it', async () => {
  const r = await run('echo'); r.skipped = 'runtime not merged';
  const res = scoreGate([r], { requireAll: true });
  assert.equal(res.ok, false); assert.equal(res.skipped, 1); assert.equal(scoreGate([r]).ok, true);
});

test('name-first: slow answers fail p50 and p90; one over 2.5 s fails "all under"', async () => {
  assert.deepEqual(failing(scoreScenario('name-first', await run('name-first', { latencyMs: () => 1500 }))), ['name-first.p50']);
  assert.deepEqual(failing(scoreScenario('name-first', await run('name-first', { latencyMs: () => 2000 }))), ['name-first.p50', 'name-first.p90', 'name-first.max'].filter((x) => x !== 'name-first.max'));
  assert.deepEqual(failing(scoreScenario('name-first', await run('name-first', { latencyMs: (_s, i) => (i === 3 ? 2600 : 1100) }))), ['name-first.max']);
  assert.deepEqual(failing(scoreScenario('name-first', await run('name-first', { latencyMs: (_s, i) => (i === 3 ? null : 1100) }))).includes('name-first.answered'), true);
});

test('name-last: 2.9 s median fails; a wrong answer fails understood', async () => {
  assert.deepEqual(failing(scoreScenario('name-last', await run('name-last', { latencyMs: () => 2900 }))), ['name-last.p50']);
  const bad = await run('name-last'); bad.steps[1]!.text = 'Go ahead, what do you need?';
  assert.deepEqual(failing(scoreScenario('name-last', bad)), ['name-last.understood']);
});

test('follow-up: a missed follow-up fails 9/9', async () => {
  const r = await run('follow-up', { latencyMs: (s) => (s.clip === 'f03' ? null : 1100) });
  assert.deepEqual(failing(scoreScenario('follow-up', r)), ['follow-up.answered']);
});

test('chatter, mentions, colleague: an unasked reply or a leaked frame fails', async () => {
  const sc = gateScenarios().find((s) => s.id === 'chatter')!; const first = sc.steps.findIndex((s) => s.expect === 'silent');
  assert.deepEqual(failing(scoreScenario('chatter', await run('chatter', { unaskedAfter: new Set([first + 1]) }))), ['chatter.unasked']);
  const mi = gateScenarios().find((s) => s.id === 'mentions')!.steps.findIndex((s) => s.clip === 'm02');
  // Outbound: Milo's voice relayed on a mention fails it; a name routed in (inbound) until its verdict does not (review 1, item 10).
  assert.deepEqual(failing(scoreScenario('mentions', await run('mentions', { unaskedAfter: new Set([mi]) }))), ['mentions.relayed', 'mentions.silent']);
  assert.deepEqual(failing(scoreScenario('mentions', await run('mentions', { leakFrames: (s) => (s.clip === 'm02' ? 3 : 0) }))), []);
  assert.deepEqual(failing(scoreScenario('mentions', await run('mentions', { toolOnMention: true }))), ['mentions.tools']);
  assert.deepEqual(failing(scoreScenario('colleague', await run('colleague', { leakFrames: (s) => (s.clip === 'w01' ? 2 : 0) }))), ['colleague.relayed']);
});

test('asker: the wrong askedBy fails', async () => {
  assert.deepEqual(failing(scoreScenario('asker', await run('asker', { askedBy: (s) => (s.clip === 't02' ? 'hugo' : s.speaker) }))), ['asker.askedBy']);
  assert.deepEqual(failing(scoreScenario('asker', await run('asker', { askedBy: () => null }))), ['asker.askedBy']);
});

test('barge-in: a relay that talks on 1 s after the interruption fails', async () => {
  assert.deepEqual(failing(scoreScenario('barge', await run('barge', { bargeStopMs: 1000 }))), ['barge.silent']);
  assert.deepEqual(failing(scoreScenario('barge', await run('barge', { bargeStopMs: 600 }))), []);
});

test('two at once and echo and candidate-off', async () => {
  assert.deepEqual(failing(scoreScenario('two-at-once', await run('two-at-once', { mixedAudio: true }))), ['two-at-once.mixed']);
  // Decision 10: the queued second asker must be answered, and after the first.
  assert.deepEqual(failing(scoreScenario('two-at-once', await run('two-at-once', { queuedSecond: 'never' }))), ['two-at-once.second']);
  assert.deepEqual(failing(scoreScenario('two-at-once', await run('two-at-once', { queuedSecond: 'first' }))), ['two-at-once.first', 'two-at-once.second']);
  assert.deepEqual(failing(scoreScenario('echo', await run('echo', { echoTriggers: 1 }))), ['echo.trigger']);
  assert.deepEqual(failing(scoreScenario('candidate-off', await run('candidate-off', { candidateLeaks: true }))), ['candidate-off.routed', 'candidate-off.fixed']);
});
