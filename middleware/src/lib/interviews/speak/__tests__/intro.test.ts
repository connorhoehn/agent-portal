// Milo introduces itself (speak/intro.ts): the lead's button, and the lead's spoken introduction, which is trigger (a) of Milo's
// `introduce` tool (milo-policy.ts answerFromHeldText); a request with arguments (test cases) is left to the live model.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } } }));
import { fixtureRegistry } from '../../../../mock/core/index.js';
import { MemoryInviteStore, setInviteStore } from '../../invite/store.js';
import { INTERVIEWS_MILO_POLICY as P } from '../../milo-policy.js';
import { MemoryMiloSettingsStore, setMiloSettingsStore } from '../../milo-settings.js';
import { setInterviewConsentSource } from '../../milo-policy.js';
import { resetMiloTools } from '../../milo-tools/index.js';
import { runServerTool } from '../../../meeting-assistant/server-tools.js';
import { MemorySaidStore, setSaidStore, setSpeakDeps, SPEECH_HOLD_USD } from '../index.js';
import { ALREADY_INTRODUCED, introduceMilo, isIntroduction, MILO_INTRO } from '../intro.js';

const IV = 'iv-s4e8u2zk';            // Kwame's live coding round: Hugo leads, Wen on the panel
const CALL = { callId: 'call-kwame', lobby: `interviews:interview:${IV}`, tenant: 'interviews' };
let said: MemorySaidStore;
let order: string[];
let holds: string[];

beforeEach(() => {
  fixtureRegistry.resetAll('default');
  setInviteStore(new MemoryInviteStore());
  setMiloSettingsStore(new MemoryMiloSettingsStore());
  said = new MemorySaidStore(); setSaidStore(said);
  order = []; holds = [];
  resetMiloTools();
  setSpeakDeps({
    callOf: async () => CALL.callId,
    post: async (_c, _t, kind) => { order.push(`post:${kind}`); return true; },
    say: async () => { order.push('say'); return { outcome: 'spoken' as const, why: null }; },
    holdSpeech: async (_iv, key) => { holds.push(key); return { ok: true as const, release: async () => { order.push('release'); } }; },
  });
});
afterAll(() => { setInviteStore(null); setSaidStore(null); setSpeakDeps(null); setMiloSettingsStore(null); setInterviewConsentSource(null); });

describe('the lead\'s spoken introduction (the words after Milo\'s name)', () => {
  it.each(['here as our AI support', "s here as our AI support", 'is here to take notes', 'is joining us today', 'introduce yourself', 'can you say hello'])(
    '"%s" introduces Milo', (t) => { expect(isIntroduction(t)).toBe(true); });
  it.each(['how much time is left', 'heres a long sentence that keeps on going about the design of the ledger and its failover and more', 'repeat the question'])(
    '"%s" does not', (t) => { expect(isIntroduction(t)).toBe(false); });
});

describe('the button (introduceMilo)', () => {
  it('logs, posts, holds the speech money and says the fixed words, once an interview', async () => {
    const out = await introduceMilo({ id: IV, callId: CALL.callId }, 'u-hugo');
    expect(out).toEqual({ said: 'spoken', line: MILO_INTRO });
    expect(order).toEqual(['post:answer', 'say', 'release']);
    expect(holds).toHaveLength(1);
    expect(SPEECH_HOLD_USD).toBeGreaterThan(0);
    expect((await said.list(IV)).map((r) => [r.kind, r.source, r.text, r.askedBy, r.posted, r.spoken])).toEqual([['answer', 'intro', MILO_INTRO, 'u-hugo', true, true]]);
    expect(await introduceMilo({ id: IV, callId: CALL.callId }, 'u-hugo')).toBe('already');
    expect(ALREADY_INTRODUCED).toMatch(/already/);
  });

  it('the button runs the same `introduce` tool as the words, through the one runner (via button): not held by the words\' repeat window, once', async () => {
    // The lead's words first: logged unposted for the orchestrator, which the button does not count (only a posted introduction).
    expect(await runServerTool(CALL, 'u-hugo', 'introduce', {}, 'phrase')).toEqual({ line: MILO_INTRO, retry: false });
    expect(await runServerTool(CALL, 'u-hugo', 'introduce', {}, 'button')).toEqual({ line: MILO_INTRO, retry: false, delivered: 'spoken' });
    expect(order).toEqual(['post:answer', 'say', 'release']);
    expect(await runServerTool(CALL, 'u-hugo', 'introduce', {}, 'button')).toBeNull();
    expect(await runServerTool(CALL, 'u-wen', 'introduce', {}, 'button')).toEqual({ line: 'Only the lead interviewer can ask Milo to introduce itself.', retry: false });
  });

  it('a press while Milo is not in the call is logged unposted and does not use up the introduction', async () => {
    setSpeakDeps({ callOf: async () => null, holdSpeech: async () => ({ ok: true as const, release: async () => undefined }) });
    expect(await introduceMilo({ id: IV, callId: null }, 'u-hugo')).toEqual({ said: 'none', line: MILO_INTRO });
    setSpeakDeps({ callOf: async () => CALL.callId, post: async () => true, say: async () => ({ outcome: 'spoken' as const, why: null }),
      holdSpeech: async () => ({ ok: true as const, release: async () => undefined }) });
    expect(await introduceMilo({ id: IV, callId: CALL.callId }, 'u-hugo')).toEqual({ said: 'spoken', line: MILO_INTRO });
  });
});

describe('the policy\'s held answers', () => {
  it('the lead saying it: the fixed words, logged unposted for the orchestrator; once; nobody else can', async () => {
    expect(await P.answerFromHeldText!(CALL, { askedBy: 'u-wen', text: 'here as our AI support' })).toBeNull();
    expect(await P.answerFromHeldText!(CALL, { askedBy: 'u-hugo', text: 'what time is it' })).toBeNull();
    expect(await P.answerFromHeldText!(CALL, { askedBy: 'u-hugo', text: 'here as our AI support' })).toBe(MILO_INTRO);
    expect((await said.list(IV)).map((r) => [r.source, r.posted])).toEqual([['intro', false]]);
    // The orchestrator posted and said it; heard again, it is no held answer any more.
    await P.heldTextSaid!(CALL, { askedBy: 'u-hugo', text: MILO_INTRO, posted: true, spoken: true });
    expect((await said.list(IV))[0]).toMatchObject({ posted: true, spoken: true });
    // Heard again: handled, nothing to say.
    expect(await P.answerFromHeldText!(CALL, { askedBy: 'u-hugo', text: 'introduce yourself' })).toBe('');
  });

  it('the candidate asking for test cases is not held text: it goes to the live model (its tool call is judged in milo-tools)', async () => {
    setInterviewConsentSource(async () => ({ transcription: true, milo: true }));
    const { inviteStore } = await import('../../invite/store.js');
    const inv = await inviteStore().issueInvite({ interviewId: IV, tokenHash: 'c'.repeat(64), issuedBy: 'u-greta', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(await P.answerFromHeldText!(CALL, { askedBy: `guest:${inv.id}`, text: 'Hey Milo, can you generate another dozen test cases for me?' })).toBeNull();
    expect(await said.list(IV)).toEqual([]);
  });
});

describe('the fixed introduction', () => {
  it('is the owner\'s wording', () => {
    expect(MILO_INTRO).toBe("Hi, I'm Milo. I won't write your algorithm or anything like that, but use me if you want to speed things up or have a question.");
  });
});
