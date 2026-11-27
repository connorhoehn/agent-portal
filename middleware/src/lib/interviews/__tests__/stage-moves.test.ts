// lib/interviews/stage-moves.ts: the recruiter's stage moves (gap audit 2026-11-20 §2), every allowed and every refused
// move, the reopen target, the body check, and the copy on the hiring manager's side that now names these moves.
import { decisionMove } from '../debrief/rules.js';
import { allowedStageMoves, checkStageMove, reopenTarget, stageMove, stageMoveChange, STAGE_MOVE_LABEL, STAGE_MOVES, type StageMoveKind } from '../stage-moves.js';
import { APPLICATION_STAGES, type ApplicationStage, type InterviewState } from '../types.js';

const rounds = (...states: InterviewState[]) => states.map((state) => ({ state }));

const ALLOWED: Array<[ApplicationStage, StageMoveKind, ApplicationStage]> = [
  ['applied', 'screen', 'screening'],
  ['offer', 'hire', 'hired'],
  ['offer', 'decline', 'rejected'],
  ['rejected', 'reopen', 'screening'],
  ['withdrawn', 'reopen', 'screening'],
  ['on-hold', 'reopen', 'screening'],
];

describe('stageMove', () => {
  it.each(ALLOWED)('%s takes %s to %s', (from, move, to) => {
    expect(stageMove(from, move, [])).toEqual({ ok: true, to });
  });

  it('refuses every other move with a sentence', () => {
    const allowed = new Set(ALLOWED.map(([f, m]) => `${f}:${m}`));
    let refused = 0;
    for (const stage of APPLICATION_STAGES) {
      for (const move of STAGE_MOVES) {
        if (allowed.has(`${stage}:${move}`)) continue;
        const out = stageMove(stage, move, rounds('ended'));
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.message).toMatch(/\.$/);
        refused += 1;
      }
    }
    expect(refused).toBe(APPLICATION_STAGES.length * STAGE_MOVES.length - ALLOWED.length);
  });

  it('hired is final: reopen is refused with its own sentence', () => {
    expect(stageMove('hired', 'reopen', rounds('reviewed'))).toEqual({ ok: false, message: expect.stringMatching(/hired/) });
  });

  it('reopen goes back to interviewing when a round was held or is still to run, otherwise to screening', () => {
    for (const s of ['assigned', 'accepted', 'ready', 'live', 'ended', 'scored', 'reviewed'] as const) expect(reopenTarget(rounds(s))).toBe('interviewing');
    expect(reopenTarget(rounds('cancelled', 'declined'))).toBe('screening');
    expect(reopenTarget([])).toBe('screening');
    expect(stageMove('rejected', 'reopen', rounds('cancelled', 'reviewed'))).toEqual({ ok: true, to: 'interviewing' });
  });

  it('allowedStageMoves lists exactly what the page offers', () => {
    expect(allowedStageMoves('applied', [])).toEqual([{ move: 'screen', to: 'screening' }]);
    expect(allowedStageMoves('offer', [])).toEqual([{ move: 'hire', to: 'hired' }, { move: 'decline', to: 'rejected' }]);
    expect(allowedStageMoves('withdrawn', rounds('ended'))).toEqual([{ move: 'reopen', to: 'interviewing' }]);
    for (const s of ['screening', 'interviewing', 'debrief', 'hired'] as const) expect(allowedStageMoves(s, [])).toEqual([]);
  });
});

describe('checkStageMove', () => {
  const WHY = 'The candidate took another offer closer to home.';
  it('takes a move, a basedOn and the reason the move needs', () => {
    expect(checkStageMove({ move: 'screen', basedOn: 1 })).toEqual({ ok: true, value: { move: 'screen', basedOn: 1, reason: null } });
    expect(checkStageMove({ move: 'hire', basedOn: 5 })).toEqual({ ok: true, value: { move: 'hire', basedOn: 5, reason: null } });
    expect(checkStageMove({ move: 'hire', basedOn: 5, reason: '  Starts in  March. ' })).toEqual({ ok: true, value: { move: 'hire', basedOn: 5, reason: 'Starts in March.' } });
    expect(checkStageMove({ move: 'decline', basedOn: 5, reason: WHY })).toMatchObject({ ok: true });
    expect(checkStageMove({ move: 'reopen', basedOn: 3, reason: WHY })).toMatchObject({ ok: true });
  });

  it.each([
    ['decline without a reason', { move: 'decline', basedOn: 5 }, 'reason'],
    ['reopen with too short a reason', { move: 'reopen', basedOn: 5, reason: 'yes' }, 'reason'],
    ['screen with a reason', { move: 'screen', basedOn: 1, reason: WHY }, 'reason'],
    ['a reason over the limit', { move: 'hire', basedOn: 5, reason: 'x'.repeat(1001) }, 'reason'],
    ['a reason that is not text', { move: 'hire', basedOn: 5, reason: 3 }, 'reason'],
    ['an unknown move', { move: 'promote', basedOn: 5 }, 'move'],
    ['a target stage instead of a move', { move: 'reopen', basedOn: 5, reason: WHY, stage: 'offer' }, 'stage'],
    ['no basedOn', { move: 'screen' }, 'basedOn'],
    ['a basedOn of 0', { move: 'screen', basedOn: 0 }, 'basedOn'],
  ])('refuses %s', (_label, body, path) => {
    const out = checkStageMove(body);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.problems.map((p) => p.path)).toContain(path);
  });
});

describe('the history entry and the copy', () => {
  it('records who moved it and why, or the move\'s plain default', () => {
    const at = '2026-11-26T10:00:00.000Z';
    expect(stageMoveChange({ to: 'hired', move: 'hire', reason: null, by: 'u-rec', at })).toEqual({ stage: 'hired', at, by: 'u-rec', reason: 'The offer was accepted.' });
    expect(stageMoveChange({ to: 'screening', move: 'reopen', reason: 'Back in.', by: 'u-rec', at })).toEqual({ stage: 'screening', at, by: 'u-rec', reason: 'Back in.' });
  });

  it('the hiring manager\'s refusals name the recruiter\'s moves by the labels the page uses', () => {
    const offer = decisionMove('offer', 'advance', [], []);
    expect(!offer.ok && offer.message).toContain(STAGE_MOVE_LABEL.hire);
    expect(!offer.ok && offer.message).toContain(STAGE_MOVE_LABEL.decline);
    for (const s of ['rejected', 'withdrawn'] as const) {
      const out = decisionMove(s, 'hold', [], []);
      expect(!out.ok && out.message).toContain(STAGE_MOVE_LABEL.reopen);
    }
    const early = decisionMove('applied', 'hold', [], []);
    expect(!early.ok && early.message).toContain(STAGE_MOVE_LABEL.screen);
    const hired = decisionMove('hired', 'hold', [], []);
    expect(!hired.ok && hired.message).not.toContain(STAGE_MOVE_LABEL.reopen);
  });
});
