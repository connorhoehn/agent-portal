// The stage decision's rules (debrief/rules.ts; row I5.5): each decision from each stage, what a decision needs, the body.
import type { ApplicationStage, Interview, InterviewState, Scorecard } from '../../types.js';
import { DECISIONS, checkDecision, decisionMove, isDecisionChange, scorecardsMissing, type Decision } from '../rules.js';

const iv = (id: string, state: InterviewState, panel: string[] = []): Interview => ({
  id, applicationId: 'app', roundId: 'rd', type: 'technical', leadId: 'u-lead', panelIds: panel, scheduledAt: null, minutes: 60, state,
  questionIds: [], assignedBy: 'u-r', assignedAt: '2026-11-01T00:00:00Z', inviteTokenHash: null, callId: null, endedAt: null,
  acceptances: [], declines: [], revision: 1,
});
const card = (interviewId: string, interviewerId = 'u-lead', version = 1): Scorecard => ({
  id: `sc-${interviewId}-${interviewerId}-${version}`, interviewId, interviewerId, ratings: [], recommendation: 'yes', summary: 's',
  submittedAt: '2026-11-02T00:00:00Z', version, changedAfterRecap: false, correctionReason: version > 1 ? 'r' : null,
});

describe('each decision from each stage', () => {
  const rounds = [iv('a', 'scored')];
  const cards = [card('a')];
  const table: Array<[ApplicationStage, Decision, ApplicationStage | null]> = [
    ['interviewing', 'advance', 'offer'], ['interviewing', 'hold', 'on-hold'], ['interviewing', 'reject', 'rejected'],
    ['debrief', 'advance', 'offer'], ['debrief', 'hold', 'on-hold'], ['debrief', 'reject', 'rejected'],
    ['on-hold', 'advance', 'offer'], ['on-hold', 'hold', null], ['on-hold', 'reject', 'rejected'],
    ...(['applied', 'screening', 'offer', 'hired', 'rejected', 'withdrawn'] as const).flatMap((s) => DECISIONS.map((d) => [s, d, null] as [ApplicationStage, Decision, null])),
  ];
  it.each(table)('from %s, %s → %s', (stage, decision, to) => {
    const move = decisionMove(stage, decision, rounds, cards);
    if (to) expect(move).toEqual({ ok: true, to });
    else { expect(move.ok).toBe(false); expect(!move.ok && move.message).toMatch(/\.$/); }
  });
});

describe('what a decision needs', () => {
  it('at least one submitted scorecard on the application', () => {
    for (const d of DECISIONS) expect(decisionMove('debrief', d, [iv('a', 'ended')], [])).toMatchObject({ ok: false, message: expect.stringMatching(/No scorecard is in yet/) });
  });
  it('advance waits for every round to be held; hold and reject do not', () => {
    const rounds = [iv('a', 'scored'), iv('b', 'ready')];
    expect(decisionMove('interviewing', 'advance', rounds, [card('a')])).toMatchObject({ ok: false, message: expect.stringMatching(/still to run/) });
    expect(decisionMove('interviewing', 'hold', rounds, [card('a')])).toEqual({ ok: true, to: 'on-hold' });
    expect(decisionMove('interviewing', 'reject', rounds, [card('a')])).toEqual({ ok: true, to: 'rejected' });
  });
  it('a scorecard still due does not stop a decision; it is counted per seat on held rounds only', () => {
    const rounds = [iv('a', 'ended', ['u-p1', 'u-p2']), iv('b', 'scored'), iv('c', 'cancelled', ['u-p3'])];
    const cards = [card('a'), card('a', 'u-lead', 2), card('b')];
    expect(decisionMove('debrief', 'advance', rounds, cards)).toEqual({ ok: true, to: 'offer' });
    expect(scorecardsMissing(rounds, cards)).toBe(2);
  });
});

describe('the body', () => {
  it('takes a decision, a reason of 10 to 1000 characters and the history length read', () => {
    expect(checkDecision({ decision: 'hold', reason: '  Waiting on the second team.  ', basedOn: 4 }))
      .toEqual({ ok: true, value: { decision: 'hold', reason: 'Waiting on the second team.', basedOn: 4 } });
  });
  it.each([
    [{ decision: 'promote', reason: 'A good enough reason.', basedOn: 1 }, 'decision'],
    [{ decision: 'hold', reason: 'Too short', basedOn: 1 }, 'reason'],
    [{ decision: 'hold', reason: 'x'.repeat(1001), basedOn: 1 }, 'reason'],
    [{ decision: 'hold', reason: 'A good enough reason.', basedOn: 0 }, 'basedOn'],
    [{ decision: 'hold', reason: 'A good enough reason.' }, 'basedOn'],
    [{ decision: 'hold', reason: 'A good enough reason.', basedOn: 1, by: 'u-someone' }, 'by'],
    [null, 'body'],
  ])('refuses %j at %s', (body, field) => {
    const out = checkDecision(body);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.fields.map((f) => f.field)).toContain(field);
  });
});

it('tells a decision from any other move in the history', () => {
  expect(isDecisionChange({ stage: 'offer', at: 'x', by: 'u', reason: 'r', decision: 'advance', scorecardsMissing: 0 } as never)).toBe(true);
  expect(isDecisionChange({ stage: 'debrief', at: 'x', by: 'u', reason: null })).toBe(false);
});
