// Hands-free Milo in an interview (milo-policy.ts `handsfree`, through handsfree/rules.ts): who Milo may listen to, the candidate's
// fixed lines with pad help off (never routed), the stricter instructions with it on, and the pad-help switch still gating writes.
jest.mock('../../../config.js', () => ({
  config: { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } },
}));

import { fixtureRegistry } from '../../../mock/core/index.js';
import { createHandsfreeRules, handsfreeFamilyRules } from '../../meeting-assistant/handsfree/rules.js';
import { HANDSFREE_TURN_RULES, meetingInstructions } from '../../meeting-assistant/instructions.js';
import type { PolicyCall } from '../../meeting-assistant/policy.js';
import type { AssistantRecord } from '../../meeting-assistant/types.js';
import { MemoryInviteStore, inviteStore, setInviteStore } from '../invite/store.js';
import { HANDSFREE_INTERVIEW_RULES, INTERVIEWS_MILO_POLICY as P, setInterviewConsentSource } from '../milo-policy.js';
import { MemoryMiloSettingsStore } from '../milo-settings.js';
import { PAD_OFF, resetMiloTools, runMiloTool, setMiloToolDeps } from '../milo-tools/index.js';
import { MemorySaidStore, MILO_CAN_DO, NO_QUESTION_YET, setSaidStore, setSpeakDeps } from '../speak/index.js';
import type { Interview } from '../types.js';

const IV = 'iv-hf';
const LOBBY = `interviews:interview:${IV}`;
const CALL: PolicyCall = { callId: 'call-hf', lobby: LOBBY, tenant: 'interviews' };
const LEAD = 'u-wen'; const PANEL = 'u-hugo'; const STRANGER = 'u-alice';
const ALL_YES = { recording: true, transcription: true, milo: true };

let interview: Interview;
let settings: MemoryMiloSettingsStore;
let said: MemorySaidStore;
let guest: string;
let consent: { recording?: boolean; transcription: boolean; milo: boolean } | null;

const record = (): AssistantRecord => ({ callId: CALL.callId, tenant: 'interviews', lobby: LOBBY, state: 'listening', acked: [LEAD, PANEL], attendees: [LEAD, PANEL] } as unknown as AssistantRecord);
const rules = () => createHandsfreeRules({ record: async (id) => (id === CALL.callId ? record() : null), policy: () => P });
const say = (userId: string, text: string, via: 'name' | 'follow-up' = 'name') => rules().verdict(CALL, { userId, text, via });

beforeEach(async () => {
  fixtureRegistry.resetAll('default');
  setInviteStore(new MemoryInviteStore());
  const inv = await inviteStore().issueInvite({ interviewId: IV, tokenHash: 'c'.repeat(64), issuedBy: 'u-greta', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  guest = `guest:${inv.id}`;
  interview = {
    id: IV, leadId: LEAD, panelIds: [PANEL], state: 'live', type: 'technical', callId: CALL.callId, minutes: 45, scheduledAt: new Date(Date.now() - 15 * 60_000).toISOString(),
    questionIds: [], applicationId: 'app-x',
  } as unknown as Interview;
  settings = new MemoryMiloSettingsStore();
  said = new MemorySaidStore(); setSaidStore(said);
  consent = ALL_YES;
  setInterviewConsentSource(async () => consent);
  resetMiloTools();
  // Rows list by when they were said, then by id: lines logged within one millisecond would otherwise come back in the order of
  // their random ids (the flake on 19 Nov). Ids that count up keep the order they were logged in.
  let ids = 0;
  setSpeakDeps({ callOf: async () => CALL.callId, miloJoinedAt: async () => Date.now() - 15 * 60_000, newId: () => `said-${String(++ids).padStart(6, '0')}` });
  setMiloToolDeps({
    interview: async (id) => (id === IV ? interview : null),
    guestOf: async (u, id) => u === guest && id === IV,
    settings: (id) => settings.get(id),
    questions: async () => [],
    surface: async () => 'pad',
  });
});
afterAll(() => { setMiloToolDeps(null); setSaidStore(null); setSpeakDeps(null); setInviteStore(null); setInterviewConsentSource(null); });

describe('admit: who Milo may listen to in an interview', () => {
  it('the lead and the panel of a live interview are routed; a stranger is denied', async () => {
    expect(await rules().admit(CALL, LEAD)).toBe('route');
    expect(await rules().admit(CALL, PANEL)).toBe('route');
    expect(await rules().admit(CALL, STRANGER)).toBe('deny');
  });

  it('the candidate with pad help off (the default) gets fixed lines only; with it on, routed', async () => {
    expect(await rules().admit(CALL, guest)).toBe('fixed-lines');
    await settings.setCandidateMayAsk(IV, true, LEAD, new Date().toISOString());
    expect(await rules().admit(CALL, guest)).toBe('route');
  });

  it('a candidate who declined Milo, or has not answered, is never admitted, pad help or not', async () => {
    await settings.setCandidateMayAsk(IV, true, LEAD, new Date().toISOString());
    consent = { recording: true, transcription: true, milo: false };
    expect(await rules().admit(CALL, guest)).toBe('deny');
    consent = { recording: true, transcription: false, milo: false };
    expect(await rules().admit(CALL, guest)).toBe('deny');
    consent = null;
    expect(await rules().admit(CALL, guest)).toBe('deny');
  });

  it('nobody once the interview is not live; the guest of another interview never', async () => {
    interview = { ...interview, state: 'ended' } as Interview;
    expect(await rules().admit(CALL, LEAD)).toBe('deny');
    expect(await rules().admit(CALL, guest)).toBe('deny');
    interview = { ...interview, state: 'live' } as Interview;
    expect(await rules().admit(CALL, 'guest:inv-other')).toBe('deny');
    expect(await rules().admit({ ...CALL, lobby: 'interviews:interview:iv-nope' }, LEAD)).toBe('deny');
  });
});

describe('the candidate with pad help off: server lines only, never the model', () => {
  it('time left and repeat are said from the server and logged; anything else is the fixed sentence', async () => {
    const time = await say(guest, 'Milo, how much time is left?');
    expect(time).toEqual({ kind: 'fixed', line: 'About 30 minutes are left in this round.' });
    expect(await say(guest, 'Milo, repeat the question.')).toEqual({ kind: 'fixed', line: NO_QUESTION_YET });
    for (const ask of ['Milo, is my solution right?', 'Milo, add twelve test cases.', 'Milo, what is the time complexity of a hash map?', 'Hey Milo, can you give me a hint?']) {
      expect([ask, await say(guest, ask)]).toEqual([ask, { kind: 'fixed', line: MILO_CAN_DO }]);
    }
    const rows = await said.list(IV);
    expect(rows.map((r) => [r.source, r.askedBy, r.posted, r.spoken])).toEqual([
      ['time', guest, false, false], ['repeat', guest, false, false],
      ['refusal', guest, false, false], ['refusal', guest, false, false], ['refusal', guest, false, false], ['refusal', guest, false, false],
    ]);
  });

  it('a mention is dropped, and without the name there is no window: nothing', async () => {
    expect(await say(guest, "I think Milo's timer is wrong.")).toEqual({ kind: 'mention' });
    expect(await say(guest, 'How much time is left?', 'follow-up')).toEqual({ kind: 'aside' });
    expect(await said.list(IV)).toEqual([]);
  });
});

describe('the candidate with pad help on: routed, under the interview\'s stricter rules', () => {
  beforeEach(async () => { await settings.setCandidateMayAsk(IV, true, LEAD, new Date().toISOString()); });

  it('a request goes to the model; time and repeat are still the server\'s', async () => {
    expect(await say(guest, 'Milo, add twelve test cases.')).toEqual({ kind: 'request' });
    expect(await say(guest, 'Milo, is my solution right?')).toEqual({ kind: 'request' }); // the model is told never to; the words are logged and heard by both sides
    expect(await say(guest, 'Milo, how much time is left?')).toMatchObject({ kind: 'fixed', line: expect.stringMatching(/left in this round/) });
  });

  it('the instructions forbid solving, hinting and judging, and name only the tools', () => {
    const rulesText = handsfreeFamilyRules(CALL, P);
    expect(rulesText).toBe(HANDSFREE_INTERVIEW_RULES);
    for (const word of [/Never solve, hint at, explain, review, check, debug, rate/, /never suggest an approach/, /never give an opinion about the candidate/, /only through the backend's tools/, /can't help with that in an interview/]) {
      expect(HANDSFREE_INTERVIEW_RULES).toMatch(word);
    }
    const text = meetingInstructions({ tenant: 'interviews', roster: ['Wen', 'Candidate'], recordName: null, readAloudOnly: true, delegates: true, handsfree: { familyRules: rulesText } });
    expect(text).toContain(HANDSFREE_TURN_RULES);
    expect(text).toContain(HANDSFREE_INTERVIEW_RULES);
  });

  it('the pad-help switch still gates writes: turned off mid-round, the next trigger is fixed lines and a pad tool is refused', async () => {
    await settings.setCandidateMayAsk(IV, false, LEAD, new Date().toISOString());
    expect(await rules().admit(CALL, guest)).toBe('fixed-lines');
    expect(await runMiloTool(IV, guest, 'pad_add_tests', { cases: [{ args: '[1]', expected: '1' }] })).toBe(PAD_OFF);
    expect(await runMiloTool(IV, guest, 'pad_add_import', { lines: ['import heapq'] })).toBe(PAD_OFF);
  });
});

describe('the panel side', () => {
  it('a request goes to the model; the time is the server\'s; only the lead\'s "introduce yourself" is held', async () => {
    expect(await say(LEAD, 'Milo, add a helper for parsing the input.')).toEqual({ kind: 'request' });
    expect(await say(PANEL, 'Milo, how much time is left?')).toMatchObject({ kind: 'fixed', line: expect.stringMatching(/left in this round/) });
    expect(await say(PANEL, 'Milo, introduce yourself.')).toEqual({ kind: 'request' }); // the model may call introduce; its mayAsk refuses
    expect(await say(LEAD, "Milo's notes will be on the record page.")).toEqual({ kind: 'mention' });
  });

  it('a re-ask within the repeat window is answered: hands-free hears each request once (gate iv-follow / fixed-follow, 19 November)', async () => {
    // The model answered the first ask (its sentence split from the name), then the phrase asks come as follow-ups.
    expect(await P.runTool!(CALL, { askedBy: PANEL, name: 'time_left', args: {} })).toMatch(/left in this round/);
    expect(await say(PANEL, 'And how much time is left now?', 'follow-up')).toMatchObject({ kind: 'fixed', line: expect.stringMatching(/left in this round/) });
    expect(await say(PANEL, 'So how long do we have?', 'follow-up')).toMatchObject({ kind: 'fixed', line: expect.stringMatching(/left in this round/) });
  });

  it('a stranger gets nothing, named or not', async () => {
    expect(await say(STRANGER, 'Milo, how much time is left?')).toEqual({ kind: 'mention' });
  });
});

describe('the early verdict in an interview (review 1, item 9): only what no held answer could take', () => {
  it('mayBeHeld covers every phrase the server answers, and lets an ordinary request through', () => {
    const family = P.handsfree!(CALL);
    for (const text of ['how much time is left?', 'time check', 'how long do we have left', 'repeat the question', 'say that again', 'what was the question', 'introduce yourself', 'say hello to the candidate']) {
      expect([text, family.mayBeHeld!({ text })]).toEqual([text, true]);
    }
    for (const text of ['add twelve test cases.', 'what is a hash map?']) expect([text, family.mayBeHeld!({ text })]).toEqual([text, false]);
  });

  it('the lead\'s ordinary request is a provisional request once admitted; a time question never is, and nothing runs', async () => {
    const r = rules();
    expect(await r.admit(CALL, LEAD)).toBe('route');
    expect(r.provisional(CALL, { userId: LEAD, text: 'Milo, add twelve test cases', via: 'name' })).toBe('request');
    expect(r.provisional(CALL, { userId: LEAD, text: 'Milo, how much time is left', via: 'name' })).toBeNull();
  });
});
