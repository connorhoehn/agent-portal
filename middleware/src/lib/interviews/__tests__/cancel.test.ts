// lib/interviews/cancel.ts: when a round may be cancelled or marked as not having taken place, when an application may
// be withdrawn, and what a cancelled round means to the rules that already read the state (gap audit 2026-11-20 §1).
import { checkAssignment } from '../assign.js';
import { cancelMove, checkCancel, checkNotHeld, checkWithdraw, notHeldMove, recruiterEndMove, withdrawMove, CANCEL_NOTE_MAX } from '../cancel.js';
import { decisionMove, scorecardsMissing } from '../debrief/rules.js';
import { interviewOpen } from '../invite/rules.js';
import { isScoredNow, stateRefusal } from '../scorecard.js';
import { debriefReady } from '../views.js';
import type { Interview, InterviewState, Opening, Scorecard } from '../types.js';

const NOW = new Date('2026-11-20T12:00:00.000Z');
const PAST = '2026-11-20T11:00:00.000Z';
const LATER = '2026-11-21T11:00:00.000Z';

const iv = (over: Partial<Interview> = {}): Interview => ({
  id: 'iv-1', applicationId: 'app-1', roundId: 'rd-1', type: 'technical', leadId: 'u-lead', panelIds: ['u-panel'],
  scheduledAt: LATER, minutes: 60, state: 'ready', questionIds: [], assignedBy: 'u-rec', assignedAt: PAST, callId: null,
  endedAt: null, acceptances: [], declines: [], revision: 1, ...over,
});

describe('checking the bodies', () => {
  it('cancel takes one of the five reasons and an optional note of at most 280 characters', () => {
    expect(checkCancel({ reason: 'rescheduling' })).toEqual({ ok: true, value: { reason: 'rescheduling', note: null } });
    expect(checkCancel({ reason: 'other', note: '  Moved  to   Friday ' })).toEqual({ ok: true, value: { reason: 'other', note: 'Moved to Friday' } });
    expect(checkCancel({ reason: 'no_show' }).ok).toBe(false);
    expect(checkCancel({ reason: 'candidate_withdrew' }).ok).toBe(false);
    expect(checkCancel({}).ok).toBe(false);
    expect(checkCancel({ reason: 'other', note: 'x'.repeat(CANCEL_NOTE_MAX + 1) }).ok).toBe(false);
    expect(checkCancel({ reason: 'other', note: 'x'.repeat(CANCEL_NOTE_MAX) }).ok).toBe(true);
  });

  it('not held takes no_show or did_not_take_place only', () => {
    expect(checkNotHeld({ reason: 'no_show' }).ok).toBe(true);
    expect(checkNotHeld({ reason: 'did_not_take_place' }).ok).toBe(true);
    expect(checkNotHeld({ reason: 'rescheduling' }).ok).toBe(false);
  });

  it('withdraw names the history length it was read at', () => {
    expect(checkWithdraw({ basedOn: 2 })).toEqual({ ok: true, value: { basedOn: 2, note: null } });
    expect(checkWithdraw({}).ok).toBe(false);
  });
});

describe('cancel', () => {
  it.each(['assigned', 'accepted', 'ready'] as InterviewState[])('a %s round may be cancelled', (state) => {
    expect(cancelMove(iv({ state }))).toEqual({ ok: true, closesRoom: false });
  });
  it.each(['live', 'ended', 'scored', 'reviewed', 'declined', 'cancelled'] as InterviewState[])('a %s round may not', (state) => {
    expect(cancelMove(iv({ state })).ok).toBe(false);
  });
});

describe('did not take place', () => {
  it('the lead, on a live round: closes the room', () => {
    expect(notHeldMove(iv({ state: 'live' }), 'u-lead', false, NOW)).toEqual({ ok: true, closesRoom: true });
  });
  it('the recruiter, on a live round they hold no seat on', () => {
    expect(notHeldMove(iv({ state: 'live' }), 'u-rec', true, NOW)).toEqual({ ok: true, closesRoom: true });
  });
  it('a not-yet-live round only once its start has passed', () => {
    expect(notHeldMove(iv({ state: 'ready', scheduledAt: PAST }), 'u-lead', false, NOW)).toEqual({ ok: true, closesRoom: false });
    expect(notHeldMove(iv({ state: 'ready', scheduledAt: LATER }), 'u-lead', false, NOW)).toMatchObject({ ok: false, reason: 'state' });
    expect(notHeldMove(iv({ state: 'assigned', scheduledAt: null }), 'u-rec', true, NOW)).toMatchObject({ ok: false, reason: 'state' });
  });
  it('a panel member is refused as not the lead; someone without a seat is not found', () => {
    expect(notHeldMove(iv({ state: 'live' }), 'u-panel', false, NOW)).toMatchObject({ ok: false, reason: 'not-lead' });
    expect(notHeldMove(iv({ state: 'live' }), 'u-other', false, NOW)).toMatchObject({ ok: false, reason: 'no-seat' });
  });
  it.each(['ended', 'scored', 'reviewed', 'cancelled', 'declined'] as InterviewState[])('a %s round is refused', (state) => {
    expect(notHeldMove(iv({ state, scheduledAt: PAST }), 'u-lead', false, NOW)).toMatchObject({ ok: false, reason: 'state' });
  });
});

describe('the recruiter\'s End', () => {
  it('ends a live round; an ended one is no change; anything else is refused', () => {
    expect(recruiterEndMove({ state: 'live' })).toEqual({ ok: true, write: true });
    expect(recruiterEndMove({ state: 'ended' })).toEqual({ ok: true, write: false });
    expect(recruiterEndMove({ state: 'ready' }).ok).toBe(false);
  });
});

describe('withdraw', () => {
  it('cancels the not-yet-live rounds and leaves the held ones', () => {
    const rounds = [iv({ id: 'a', state: 'ready' }), iv({ id: 'b', state: 'assigned' }), iv({ id: 'c', state: 'scored' }), iv({ id: 'd', applicationId: 'app-2' })];
    const out = withdrawMove({ id: 'app-1', stage: 'interviewing' }, rounds);
    expect(out.ok && out.toCancel.map((i) => i.id)).toEqual(['a', 'b']);
  });
  it('is refused while a round is live, and on a closed application', () => {
    expect(withdrawMove({ id: 'app-1', stage: 'interviewing' }, [iv({ state: 'live' })]).ok).toBe(false);
    for (const stage of ['withdrawn', 'rejected', 'hired'] as const) expect(withdrawMove({ id: 'app-1', stage }, []).ok).toBe(false);
  });
});

describe('what cancelled means to the rules that read the state', () => {
  const cancelled = iv({ state: 'cancelled', cancellation: { reason: 'no_show', note: null, by: 'u-lead', at: PAST } });
  const card: Scorecard = {
    id: 'sc-1', interviewId: 'iv-held', interviewerId: 'u-lead', ratings: [], recommendation: 'yes', summary: '', submittedAt: PAST,
    version: 1, changedAfterRecap: false, correctionReason: null,
  };
  const held = iv({ id: 'iv-held', state: 'scored', panelIds: [] });

  it('nobody owes a scorecard for it, and none may be written', () => {
    expect(scorecardsMissing([cancelled], [])).toBe(0);
    expect(stateRefusal('cancelled', false)).toBe('This interview did not go ahead, so there is nothing to rate.');
    expect(isScoredNow(cancelled, [])).toBe(false);
  });

  it('it does not block Advance or the debrief', () => {
    expect(decisionMove('interviewing', 'advance', [held, cancelled], [card])).toEqual({ ok: true, to: 'offer' });
    expect(decisionMove('interviewing', 'advance', [held, iv({ state: 'ready' })], [card]).ok).toBe(false);
    expect(debriefReady([held, cancelled])).toBe(true);
  });

  it('its invite is dead', () => {
    expect(interviewOpen(cancelled)).toBe(false);
  });

  it('the round may be assigned again for the same application', () => {
    const opening = { id: 'op-1', state: 'open', kit: { rounds: [{ id: 'rd-1', name: 'Coding', type: 'technical', minutes: 60 }] } } as unknown as Opening;
    const world = { applications: [{ id: 'app-1', candidateId: 'c-1', openingId: 'op-1', stage: 'interviewing' as const, appliedAt: PAST, history: [] }], openings: [opening] };
    const body = { applicationId: 'app-1', roundId: 'rd-1', leadId: 'u-lead', panelIds: [] };
    expect(checkAssignment(body, { ...world, interviews: [cancelled] }, new Set(['u-lead'])).ok).toBe(true);
    expect(checkAssignment(body, { ...world, interviews: [iv({ state: 'ready' })] }, new Set(['u-lead'])).ok).toBe(false);
  });
});
