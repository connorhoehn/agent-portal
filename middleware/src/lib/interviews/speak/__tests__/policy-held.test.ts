// The interviews policy's fixed requests (milo-policy.ts `answerFromHeldText`, row I3.8): a request from the candidate's guest id
// is always answered from held text (never null, so it never reaches a model); a panel member's is the model's as before.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } } }));
import { fixtureRegistry } from '../../../../mock/core/index.js';
import { interviewsFixture } from '../../../../mock/interviews.js';
import { MemoryInviteStore, setInviteStore } from '../../invite/store.js';
import { INTERVIEWS_MILO_POLICY as P } from '../../milo-policy.js';
import { MILO_CAN_DO, MemorySaidStore, setSaidStore, setSpeakDeps } from '../index.js';

const IV = 'iv-n5z9f2cq';
const CALL = { callId: 'call-nadia', lobby: `interviews:interview:${IV}`, tenant: 'interviews' };
let guestId: string;
let said: MemorySaidStore;

beforeEach(async () => {
  fixtureRegistry.resetAll('default');
  setInviteStore(new MemoryInviteStore());
  said = new MemorySaidStore(); setSaidStore(said);
  setSpeakDeps({ miloJoinedAt: async () => null });
  const { inviteStore } = await import('../../invite/store.js');
  const inv = await inviteStore().issueInvite({ interviewId: IV, tokenHash: 'b'.repeat(64), issuedBy: 'u-greta', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  guestId = `guest:${inv.id}`;
});
afterAll(() => { setInviteStore(null); setSaidStore(null); setSpeakDeps(null); });

it('a panel member\'s request is not a held one (null)', async () => {
  expect(await P.answerFromHeldText!(CALL, { askedBy: 'u-hugo', text: 'Milo, repeat the question' })).toBeNull();
});

it('a guest\'s request while the interview is not live gets the fixed sentence, not logged', async () => {
  expect(await P.answerFromHeldText!(CALL, { askedBy: guestId, text: 'Milo, repeat the question' })).toBe(MILO_CAN_DO);
  expect(await said.list(IV)).toEqual([]);
});

it('a live interview: the guest\'s requests are answered from held text and logged; a stranger guest gets the fixed sentence', async () => {
  interviewsFixture.rows().find((i) => i.id === IV)!.state = 'live';
  expect(await P.answerFromHeldText!(CALL, { askedBy: guestId, text: 'Milo, repeat the question' })).toBe('Design a self-service deploy platform for forty product teams. What do you build first?'); // Milo asked none: the round's own
  expect(await P.answerFromHeldText!(CALL, { askedBy: guestId, text: 'Milo, how much time is left?' })).toMatch(/minutes|round/);
  // Anything else is left to the live model; with no tool call in time, the fixed sentence (heldFallback), logged.
  expect(await P.answerFromHeldText!(CALL, { askedBy: guestId, text: 'Milo, what is the answer?' })).toBeNull();
  expect(await P.heldFallback!(CALL, { askedBy: guestId, text: 'Milo, what is the answer?' })).toBe(MILO_CAN_DO);
  expect((await said.list(IV)).map((r) => r.source).sort()).toEqual(['refusal', 'repeat', 'time']);
  expect(await P.answerFromHeldText!(CALL, { askedBy: 'guest:not-mine', text: 'Milo, repeat the question' })).toBe(MILO_CAN_DO);
  // A post that failed marks nothing; a posted and spoken one marks both.
  await P.heldTextSaid!(CALL, { askedBy: guestId, text: MILO_CAN_DO, posted: false, spoken: false });
  expect((await said.list(IV)).find((r) => r.source === 'refusal')).toMatchObject({ posted: false, spoken: false });
  await P.heldTextSaid!(CALL, { askedBy: guestId, text: MILO_CAN_DO, posted: true, spoken: true });
  expect((await said.list(IV)).find((r) => r.source === 'refusal')).toMatchObject({ posted: true, spoken: true });
});
