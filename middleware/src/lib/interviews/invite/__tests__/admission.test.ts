// The waiting room's rules (lib/interviews/invite/admission.ts; docs/interviews-tenant-plan.md rows I2.2, I2.3).
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { fixtureRegistry } from '../../../../mock/core/index.js';
import { admissionOf, applyAdmission, nextAdmission, NOT_KNOCKED, setKnockPrecondition, type Admission } from '../admission.js';
import { MemoryInviteStore } from '../store.js';
import { setInviteStore } from '../store.js';

const NOW = new Date('2026-11-16T10:00:00.000Z');
const LATER = new Date('2026-11-16T10:05:00.000Z');
const at = (state: Admission['state']): Admission => ({ state, knockedAt: state === 'not-knocked' ? null : '2026-11-16T09:00:00.000Z', decidedAt: null });

describe('nextAdmission', () => {
  it('a knock waits, from not knocked or turned away; repeating it changes nothing', () => {
    expect(nextAdmission(NOT_KNOCKED, { kind: 'knock' }, NOW)).toEqual({ state: 'waiting', knockedAt: NOW.toISOString(), decidedAt: null });
    expect(nextAdmission(at('turned-away'), { kind: 'knock' }, NOW)).toMatchObject({ state: 'waiting', knockedAt: NOW.toISOString() });
    const waiting = at('waiting');
    expect(nextAdmission(waiting, { kind: 'knock' }, NOW)).toBe(waiting);
    const admitted = at('admitted');
    expect(nextAdmission(admitted, { kind: 'knock' }, NOW)).toBe(admitted);
  });

  it('the lead admits someone waiting, and turns away someone waiting or admitted', () => {
    expect(nextAdmission(at('waiting'), { kind: 'decide', admit: true }, NOW)).toMatchObject({ state: 'admitted', decidedAt: NOW.toISOString() });
    expect(nextAdmission(at('waiting'), { kind: 'decide', admit: false }, NOW)).toMatchObject({ state: 'turned-away', decidedAt: NOW.toISOString() });
    expect(nextAdmission(at('admitted'), { kind: 'decide', admit: false }, NOW)).toMatchObject({ state: 'turned-away' });
  });

  it('nobody can be admitted who has not knocked, or was turned away and has not knocked again', () => {
    expect(nextAdmission(NOT_KNOCKED, { kind: 'decide', admit: true }, NOW)).toBeNull();
    expect(nextAdmission(at('turned-away'), { kind: 'decide', admit: true }, NOW)).toBeNull();
    expect(nextAdmission(NOT_KNOCKED, { kind: 'decide', admit: false }, NOW)).toBeNull();
  });
});

describe('the admission on the invite', () => {
  let store: MemoryInviteStore;
  beforeEach(() => { store = new MemoryInviteStore(); setInviteStore(store); });
  afterEach(() => { setInviteStore(null); setKnockPrecondition(null); fixtureRegistry.resetAll('default'); });

  const opened = async (session = 'a'.repeat(64)) => {
    const invite = await store.issueInvite({ interviewId: 'iv-1', tokenHash: 'f'.repeat(64), issuedBy: 'u-greta', issuedAt: NOW.toISOString(), expiresAt: LATER.toISOString() });
    return (await store.recordOpening(invite.id, NOW.toISOString(), session))!;
  };

  it('knock, admit, turn away, knock again', async () => {
    const invite = await opened();
    expect(admissionOf(invite)).toEqual(NOT_KNOCKED);
    expect(await applyAdmission(invite.id, { kind: 'knock' }, NOW)).toMatchObject({ ok: true, admission: { state: 'waiting' } });
    expect(await applyAdmission(invite.id, { kind: 'decide', admit: true }, LATER)).toMatchObject({ ok: true, admission: { state: 'admitted', decidedAt: LATER.toISOString() } });
    expect(await applyAdmission(invite.id, { kind: 'decide', admit: false }, LATER)).toMatchObject({ ok: true, admission: { state: 'turned-away' } });
    expect(await applyAdmission(invite.id, { kind: 'decide', admit: true }, LATER)).toEqual({ ok: false, reason: 'not-allowed' });
    expect(await applyAdmission(invite.id, { kind: 'knock' }, LATER)).toMatchObject({ ok: true, admission: { state: 'waiting' } });
  });

  it('a new exchange of the link starts the waiting room again', async () => {
    const invite = await opened();
    await applyAdmission(invite.id, { kind: 'knock' }, NOW);
    await applyAdmission(invite.id, { kind: 'decide', admit: true }, NOW);
    const again = await store.recordOpening(invite.id, LATER.toISOString(), 'b'.repeat(64));
    expect(admissionOf(again)).toEqual(NOT_KNOCKED);
  });

  it('dies with the invite: a revoked link takes no knock and no decision', async () => {
    const invite = await opened();
    await applyAdmission(invite.id, { kind: 'knock' }, NOW);
    await store.revokeInvite('iv-1', LATER.toISOString(), 'u-greta');
    expect(await applyAdmission(invite.id, { kind: 'decide', admit: true }, LATER)).toEqual({ ok: false, reason: 'no-guest' });
    expect(await applyAdmission(invite.id, { kind: 'knock' }, LATER)).toEqual({ ok: false, reason: 'no-guest' });
  });

  it('a decision against a session the link has since replaced changes nothing', async () => {
    const invite = await opened();
    await applyAdmission(invite.id, { kind: 'knock' }, NOW);
    expect(await store.setAdmission(invite.id, 'c'.repeat(64), 'waiting', { admissionState: 'admitted', knockedAt: null, admissionDecidedAt: null })).toBeNull();
    expect(await store.setAdmission(invite.id, 'a'.repeat(64), 'not-knocked', { admissionState: 'admitted', knockedAt: null, admissionDecidedAt: null })).toBeNull();
  });

  it('a knock waits for the precondition (C8); the default says yes', async () => {
    const invite = await opened();
    const asked: string[] = [];
    setKnockPrecondition(async (id) => { asked.push(id); return false; });
    expect(await applyAdmission(invite.id, { kind: 'knock' }, NOW)).toEqual({ ok: false, reason: 'precondition', why: 'unanswered' });
    expect(asked).toEqual(['iv-1']);
    setKnockPrecondition(async () => { throw new Error('down'); });
    expect(await applyAdmission(invite.id, { kind: 'knock' }, NOW)).toEqual({ ok: false, reason: 'precondition', why: 'unanswered' });
    setKnockPrecondition(null);
    expect(await applyAdmission(invite.id, { kind: 'knock' }, NOW)).toMatchObject({ ok: true });
  });

  it('a declined required part (row I6.4) is its own refusal, for the knock and for the lead letting them in', async () => {
    const invite = await opened();
    let answer: true | 'declined-required' = 'declined-required';
    setKnockPrecondition(async () => answer);
    expect(await applyAdmission(invite.id, { kind: 'knock' }, NOW)).toEqual({ ok: false, reason: 'precondition', why: 'declined-required' });
    answer = true; // the candidate changed the answer
    expect(await applyAdmission(invite.id, { kind: 'knock' }, NOW)).toMatchObject({ ok: true, admission: { state: 'waiting' } });
    answer = 'declined-required'; // and declined again while waiting
    expect(await applyAdmission(invite.id, { kind: 'decide', admit: true }, NOW)).toEqual({ ok: false, reason: 'precondition', why: 'declined-required' });
    expect(await applyAdmission(invite.id, { kind: 'decide', admit: false }, NOW)).toMatchObject({ ok: true, admission: { state: 'turned-away' } });
  });
});
