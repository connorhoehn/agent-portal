// The request status machine (lib/access/status.ts) and the row rules
// (lib/access/rules.ts): submitted → pending → approved, rejected and
// withdrawn as side exits, a step decided once, nobody deciding their own.
import type { AccessRequestRow, AccessStepRow } from '../../../mock/access-requests.js';
import { canFlags, decideRefusal, mayRead, OWN_REQUEST_ERROR, type AccessActor } from '../rules.js';
import { currentStep, decide, submitRows, TransitionError, withdraw } from '../status.js';
import { CAST, directory, item } from './fixtures.js';

const NOW = '2026-10-13T12:00:00.000Z';
function submitted(kinds: Array<AccessStepRow['kind']> = ['manager', 'steward']) {
  return submitRows({ id: 'req-9', requesterId: 'u-rhea', beneficiaryId: 'u-rhea', itemId: 'role:orgiq:sme', justification: 'x'.repeat(20),
    duration: '30d', sodVerdict: 'clear', sodOverriddenBy: null, sodOverrideReason: null, submittedAt: NOW }, kinds);
}
const actor = (id: string, personId: string | null, role: string, mayDecide = true): AccessActor => ({ id, personId, role, mayDecide, mayProvision: role === 'access-admin' });

describe('submit', () => {
  it('writes submitted, step 1 current and the rest waiting, with a submitted event', () => {
    const t = submitted();
    expect(t.request.status).toBe('submitted');
    expect(t.steps.map((s) => [s.step, s.kind, s.status])).toEqual([[1, 'manager', 'current'], [2, 'steward', 'waiting']]);
    expect(t.events).toEqual([{ kind: 'submitted', before: 'draft', after: 'submitted', reason: null }]);
  });
});

describe('decide', () => {
  it('approve moves to the next step (pending), the last approval → approved (A0 stops here)', () => {
    const s = submitted();
    const one = decide(s.request, s.steps, 1, 'approve', 'u-omar', null, NOW);
    expect(one.request.status).toBe('pending');
    expect(currentStep(one.steps)?.step).toBe(2);
    const two = decide(one.request, one.steps, 2, 'approve', 'u-priya', 'ok', NOW);
    expect(two.request.status).toBe('approved');
    expect(two.request.decidedAt).toBe(NOW);
    expect(two.events.map((e) => e.kind)).toEqual(['step-approved', 'approved']);
  });
  it('a step is decided once: a second decision is a 409', () => {
    const s = submitted();
    const one = decide(s.request, s.steps, 1, 'approve', 'u-omar', null, NOW);
    expect(() => decide(one.request, one.steps, 1, 'approve', 'u-omar', null, NOW)).toThrow(TransitionError);
    expect(() => decide(one.request, one.steps, 1, 'reject', 'u-omar', 'no', NOW)).toThrow(/already decided/);
  });
  it('a waiting step is not decidable yet (409)', () => {
    const s = submitted();
    expect(() => decide(s.request, s.steps, 2, 'approve', 'u-priya', null, NOW)).toThrow(/not awaiting/);
  });
  it('reject ends the request and skips every later step', () => {
    const s = submitted(['manager', 'steward', 'access-admin']);
    const r = decide(s.request, s.steps, 1, 'reject', 'u-omar', 'no', NOW);
    expect(r.request.status).toBe('rejected');
    expect(r.steps.map((x) => x.status)).toEqual(['rejected', 'skipped', 'skipped']);
    expect(() => decide(r.request, r.steps, 2, 'approve', 'u-priya', null, NOW)).toThrow(TransitionError);
  });
  it('info keeps the step open for a later approve', () => {
    const s = submitted(['steward']);
    const i = decide(s.request, s.steps, 1, 'info', 'u-priya', 'which sprint?', NOW);
    expect([i.request.status, i.steps[0]!.status]).toEqual(['pending', 'info-requested']);
    expect(decide(i.request, i.steps, 1, 'approve', 'u-priya', null, NOW).request.status).toBe('approved');
  });
});

describe('withdraw', () => {
  it('from an open state → withdrawn, undecided steps skipped; from a closed one → 409', () => {
    const s = submitted();
    const w = withdraw(s.request, s.steps, null);
    expect(w.request.status).toBe('withdrawn');
    expect(w.steps.map((x) => x.status)).toEqual(['skipped', 'skipped']);
    expect(() => withdraw(w.request, w.steps, null)).toThrow(TransitionError);
    const approved: AccessRequestRow = { ...s.request, status: 'approved' };
    expect(() => withdraw(approved, s.steps, null)).toThrow(/only an open request/);
  });
});

describe('row rules', () => {
  const dir = directory(CAST());
  const it0 = item();
  it('nobody decides a request they submitted or benefit from (403 naming it)', () => {
    const s = submitted();
    const refusal = decideRefusal(actor('u-rhea', 'p-rhea', 'approver'), s.request, s.steps, 1, it0, dir);
    expect(refusal?.status).toBe(403);
    expect(refusal?.error).toContain(OWN_REQUEST_ERROR);
    const forRhea = { ...s.request, requesterId: 'u-omar' };
    expect(decideRefusal(actor('u-omar', 'p-omar', 'approver'), forRhea, s.steps, 1, it0, dir)?.error).toMatch(/submitted/);
  });
  it('only an eligible decider passes; a decided step is left to the 409', () => {
    const s = submitted();
    expect(decideRefusal(actor('u-omar', 'p-omar', 'approver'), s.request, s.steps, 1, it0, dir)).toBeNull();
    expect(decideRefusal(actor('u-priya', 'p-priya', 'access-admin'), s.request, s.steps, 1, it0, dir)?.error).toMatch(/not eligible/);
    const one = decide(s.request, s.steps, 1, 'approve', 'u-omar', null, NOW);
    expect(decideRefusal(actor('u-omar', 'p-omar', 'approver'), one.request, one.steps, 1, it0, dir)).toBeNull();
  });
  it('read rule: parties, the manager, eligible deciders and access-admin read; others do not', () => {
    const s = submitted();
    expect(mayRead(actor('u-rhea', 'p-rhea', 'requester', false), s.request, s.steps, it0, dir)).toBe(true);
    expect(mayRead(actor('u-omar', 'p-omar', 'approver'), s.request, s.steps, it0, dir)).toBe(true);
    expect(mayRead(actor('u-priya', 'p-priya', 'access-admin'), s.request, s.steps, it0, dir)).toBe(true);
    expect(mayRead(actor('u-x', null, 'approver'), s.request, s.steps, it0, dir)).toBe(false);
  });
  it('can flags follow the actor', () => {
    const s = submitted();
    expect(canFlags(actor('u-rhea', 'p-rhea', 'requester', false), s.request, s.steps, it0, dir)).toEqual({ decide: false, withdraw: true, viewAudit: true });
    expect(canFlags(actor('u-omar', 'p-omar', 'approver'), s.request, s.steps, it0, dir)).toEqual({ decide: true, withdraw: false, viewAudit: true });
    expect(canFlags(actor('u-priya', 'p-priya', 'access-admin'), s.request, s.steps, it0, dir).decide).toBe(false);
  });
});
