// The Milo judge's development scenarios (scripts/milo-judge/corpus/dev.json, decide layer) run offline against the interviews turn
// policy: the real Decide and Act with a scripted model that picks the tool the truth names (as the judge's own offline rig does).
// What this proves is the tenant's half: every action the truth expects of a role is one this policy offers that role, the words
// logged are exactly the truth's (the clock's time line, the round's question, the fixed introduction, the candidate's fixed
// sentence), a pad request reaches the pad tool as asked, and a candidate who declined Milo makes no model call. Which sentences
// reach Decide at all (the name, the follow-up window, a hold) is the turn owner's; here it is the judge rig's simple stand-in.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } } }));
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { turnPolicyOf } from '../../meeting-assistant/policy.js';
import { act, _resetActed } from '../../meeting-assistant/turn/act.js';
import { decide } from '../../meeting-assistant/turn/decide.js';
import type { MiloAction, TurnPolicy, TurnSentence } from '../../meeting-assistant/turn/types.js';
import { INTERVIEWS_MILO_POLICY, setInterviewConsentSource } from '../milo-policy.js';
import { MemoryMiloSettingsStore } from '../milo-settings.js';
import { interviewCall, resetMiloTools, setMiloToolDeps } from '../milo-tools/index.js';
import { resetPendingPadWrites } from '../milo-tools/pad-request.js';
import { MemorySaidStore, MILO_CAN_DO, NO_QUESTION_YET, setSaidStore, setSpeakDeps, timeLeftLine } from '../speak/index.js';
import { MILO_INTRO } from '../speak/intro.js';
import type { Interview } from '../types.js';

interface Person { id: string; role: 'lead' | 'panellist' | 'candidate'; declined?: boolean }
interface Event { atMs: number; kind: string; who: string; text?: string; down?: boolean }
interface Expect { who: string; action: string; words?: string; argHas?: string }
interface Scenario { id: string; layer: string; people: Person[]; round: { minutes: number; startedAtMs: number; question: string | null }; events: Event[]; expect: Expect[]; noModelCall?: boolean }

const PROBE = 'What would you change in this part, and why?';
const JUDGE = join(__dirname, '../../../../../scripts/milo-judge');
const scenarios = (JSON.parse(readFileSync(join(JUDGE, 'corpus/dev.json'), 'utf8')) as { scenarios: Scenario[] }).scenarios.filter((s) => s.layer === 'decide');
// The judge's own spellings of the name and its clock (seed.mts, truth.mts), read so this test follows them.
const spellings = /NAME_SPELLINGS = \[([^\]]+)\]/.exec(readFileSync(join(JUDGE, 'seed.mts'), 'utf8'))![1]!.replace(/['\s]/g, '').split(',');
const NAME_RE = new RegExp(`(^|[^\\p{L}\\p{N}_])(${spellings.join('|')})(?![\\p{L}\\p{N}_])`, 'iu');
const T0 = 1_800_000_000_000;
const FOLLOW_UP_MS = 10_000;
const SILENT = ['stay_silent', 'keep_listening'];
const SPEECH = ['time_left', 'repeat_question', 'introduce', 'cannot_help'];
const IV = 'iv-corpus';
const policy = turnPolicyOf(INTERVIEWS_MILO_POLICY) as TurnPolicy;
const call = interviewCall(IV);
const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

afterAll(() => { setMiloToolDeps(null); setSaidStore(null); setSpeakDeps(null); setInterviewConsentSource(null); });

async function run(s: Scenario): Promise<string[]> {
  const uid = (id: string): string => (s.people.find((p) => p.id === id)?.role === 'candidate' ? `guest:${id}` : id);
  const start = T0 + s.round.startedAtMs;
  let now = T0;
  let ids = 0;
  const interview = {
    id: IV, leadId: s.people.find((p) => p.role === 'lead')?.id ?? 'u-nobody', panelIds: s.people.filter((p) => p.role === 'panellist').map((p) => p.id),
    state: 'live', type: 'technical', callId: 'call-corpus', minutes: s.round.minutes, scheduledAt: new Date(start).toISOString(), questionIds: [], applicationId: 'app-x',
  } as unknown as Interview;
  const said = new MemorySaidStore(); setSaidStore(said);
  resetMiloTools(); resetPendingPadWrites(); _resetActed();
  setInterviewConsentSource(async () => ({ transcription: true, milo: !s.people.some((p) => p.declined) }));
  setSpeakDeps({ callOf: async () => 'call-corpus', miloJoinedAt: async () => start, now: () => now, newId: () => `said-${s.id}-${++ids}` });
  const asked: string[] = [];
  setMiloToolDeps({
    interview: async () => interview, guestOf: async (u) => u.startsWith('guest:'), settings: (i) => new MemoryMiloSettingsStore().get(i), questions: async () => [],
    // A probe's writer is a model: here it is a fixed question, and the truth `@probe` is that question.
    board: async () => null, heard: async () => [], answerKey: async () => [], prober: async () => PROBE,
    surface: async () => 'pad', write: async (_i, plan) => { await plan({ text: '', language: 'python' }); return { ok: false, code: 'nothing' }; },
    padLog: async () => 0, judge: async () => 'helper', writer: async (_iv, input) => { asked.push(input.text); return null; }, now: () => now, newId: () => `said-${s.id}-t${++ids}`,
  });
  if (s.round.question) await said.append({ id: `q-${s.id}`, interviewId: IV, callId: 'call-corpus', kind: 'question', source: 'kit', questionId: 'q', suggestionId: null, text: s.round.question, askedBy: interview.leadId, saidAt: new Date(start).toISOString(), posted: true, spoken: true });

  const want = s.expect.filter((e) => e.action !== 'silent');
  const logged: Array<{ who: string; action: string; line: string | null; atMs: number; text?: string }> = [];
  const holds = new Set<string>();
  const answeredAt = new Map<string, number>();
  let next = 0;
  let requests = 0;
  let lastAction: MiloAction | null = null;
  for (const ev of [...s.events].sort((a, b) => a.atMs - b.atMs)) {
    now = T0 + ev.atMs;
    if (ev.kind === 'hold') { if (ev.down) holds.add(ev.who); else holds.delete(ev.who); continue; }
    if (ev.kind !== 'sentence' || !ev.text) continue;
    const named = NAME_RE.test(ev.text);
    const at = answeredAt.get(ev.who);
    const followUp = at !== undefined && ev.atMs - at <= FOLLOW_UP_MS;
    const held = holds.has(ev.who);
    if (!named && !followUp && !held) continue;
    const sentence: TurnSentence = { id: `${s.id}-${ev.atMs}-${ev.who}`, who: uid(ev.who), text: ev.text, atMs: now, via: held ? 'hold' : named ? 'name' : 'follow-up' };
    const decision = await decide({ call, policy, sentence, recent: [], lastAction }, {
      modelReads: async () => () => true,
      request: async () => {
        requests += 1;
        const e = want[next];
        if (!e || e.who !== ev.who) return { call: { name: 'stay_silent', arguments: '{}' }, text: '', usage: null, ms: 0 };
        next += 1;
        return { call: { name: e.action, arguments: JSON.stringify(e.action === 'pad_write' ? { text: e.argHas ?? ev.text } : {}) }, text: '', usage: null, ms: 0 };
      },
    });
    const out = await act({ call, policy, sentence, decision });
    if (out.action) lastAction = out.action;
    if (!out.tool || SILENT.includes(out.tool) || (SPEECH.includes(out.tool) && out.line === null)) continue;
    // Speak's first step: the line is in the said log before anything is said.
    if (out.line && !out.logged) await policy.logSpoken(call, { text: out.line, askedBy: sentence.who, tool: out.tool, sentenceId: sentence.id });
    if (out.line && !(await said.list(IV)).some((r) => r.kind === 'answer' && r.text === out.line && r.askedBy === sentence.who)) return [`${s.id}: "${out.line}" was not logged`];
    logged.push({ who: ev.who, action: out.tool, line: out.line, atMs: ev.atMs, ...(out.tool === 'pad_write' ? { text: asked.at(-1) } : {}) });
    if (SPEECH.includes(out.tool) || out.tool === 'pad_write') answeredAt.set(ev.who, ev.atMs + 4_000);
  }

  const problems: string[] = [];
  if (s.noModelCall && requests) problems.push(`${s.id}: ${requests} model calls where none may be made`);
  const got = logged.map((l) => `${l.who}:${l.action}`);
  const expected = want.map((e) => `${e.who}:${e.action}`);
  if (got.join() !== expected.join()) return [...problems, `${s.id}: logged [${got.join(', ')}], the truth is [${expected.join(', ')}]`];
  want.forEach((e, i) => {
    const l = logged[i]!;
    const accepted = e.words === undefined ? null
      : e.words === '@time_left' ? [0, -15_000, 15_000].map((d) => timeLeftLine(s.round.minutes, start, T0 + l.atMs + d))
        : e.words === '@question' ? [s.round.question ?? NO_QUESTION_YET]
          : e.words === '@intro' ? [MILO_INTRO] : e.words === '@can_do' ? [MILO_CAN_DO] : e.words === '@probe' ? [PROBE] : [e.words];
    if (accepted && !accepted.includes(l.line ?? '')) problems.push(`${s.id}: said "${l.line}", the truth is "${accepted[0]}"`);
    if (e.action === 'pad_write' && !l.text?.trim()) problems.push(`${s.id}: the pad tool was asked nothing`);
    if (e.action === 'pad_write' && e.argHas !== undefined && !` ${words(l.text ?? '').join(' ')} `.includes(` ${words(e.argHas ?? '').join(' ')} `)) problems.push(`${s.id}: the pad tool was asked "${l.text}", not "${e.argHas}"`);
  });
  return problems;
}

it('every decide-layer scenario of the development corpus: the action the truth names, its exact words, logged first', async () => {
  expect(scenarios.length).toBeGreaterThan(80);
  const problems: string[] = [];
  for (const s of scenarios) problems.push(...await run(s));
  expect(problems).toEqual([]);
});
