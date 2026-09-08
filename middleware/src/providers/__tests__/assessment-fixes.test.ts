// providers/assessment.ts — code-review findings, tested against the real
// mock fixture (MOCK_AURORA is the path that must work). Three findings:
//
// 1. is_na bypassed ApproveException: applyScores honoured is_na:true from
//    the agent's own payload and flipped the dimension straight to
//    not_applicable, with no exception record — but per
//    docs/assessment-tenant.md, "N/A is never self-granting". A claim now
//    only takes effect once an exception for that dimension is *approved*;
//    otherwise it's recorded (na_claimed) and opens a pending exception
//    request instead of mutating the dimension.
//
// 2. Prototype pollution via caller-supplied map keys: several MOCK_* maps
//    are plain object literals, and `map['__proto__']` returns
//    Object.prototype itself rather than undefined — so
//    envelope_ids: ['__proto__'] (or a knowledge doc id of '__proto__')
//    could read/write the shared Object.prototype instead of failing
//    not-found. Every affected lookup now goes through ownEntry().
//
// 3. virtual-* feedback tasks (synthesized from OPEN follow_up_questions)
//    could not actually be resolved or dismissed — resolveFeedback/
//    dismissFeedback only searched the stored feedback rows, so the task just
//    reappeared on the next listFeedback call. They now flip the
//    underlying question's status.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true } } }));

import * as provider from '../assessment.js';
import * as M from '../../mock/assessment.js';

describe('applyScores: is_na is a claim, not a grant (ApproveException gate)', () => {
  it('is_na:true with no approved exception does not mark the dimension not_applicable, and opens a pending exception request', async () => {
    const team = M.findTeam('TEAM-001')!;
    const usedDims = new Set(team.exceptions.map((e) => e.dimension_id));
    const freeDim = M.DIMENSION_IDS.find((d) => !usedDims.has(d))!;
    const exceptionCountBefore = team.exceptions.length;

    const result = await provider.applyScores('TEAM-001', {
      relevant_dimension_ids: [freeDim],
      scores: [{
        dimension_id: freeDim, is_na: true, suggested_level: 3, confidence: 'moderate',
        rationale: 'Team says this does not apply to them.',
      }],
    });

    // The claim is reported back...
    expect(result!.applied).toEqual([{ dimension_id: freeDim, current_level: 3, cap_applied: false, na_claimed: true }]);
    // ...but the stored dimension is NOT flipped to not_applicable.
    const detail = await provider.getTeamDetail('TEAM-001');
    const dim = detail!.dimensions.find((d) => d.id === freeDim)!;
    expect(dim.is_na).toBe(false);
    expect(dim.current_level).toBe(3);
    // A pending exception request now exists for a lead to approve.
    const exceptions = await provider.listExceptions('TEAM-001');
    expect(exceptions!.exceptions.length).toBe(exceptionCountBefore + 1);
    const opened = exceptions!.exceptions.find((e) => e.dimension_id === freeDim)!;
    expect(opened.status).toBe('requested');
  });

  it('is_na:true against a dimension with an already-approved exception (TEAM-001 dim 6) honours it', async () => {
    const before = await provider.listExceptions('TEAM-001');
    const approved = before!.exceptions.find((e) => e.dimension_id === '6' && e.status === 'approved');
    expect(approved).toBeDefined(); // seeded fixture precondition

    const result = await provider.applyScores('TEAM-001', {
      relevant_dimension_ids: ['6'],
      scores: [{ dimension_id: '6', is_na: true, suggested_level: null, confidence: 'high', rationale: 'Exception already approved.' }],
    });
    expect(result!.applied[0]).toMatchObject({ dimension_id: '6', current_level: null, na_claimed: true });
    const detail = await provider.getTeamDetail('TEAM-001');
    expect(detail!.dimensions.find((d) => d.id === '6')!.is_na).toBe(true);
  });

  it('is_na:true against a dimension with a pending (requested) exception does not open a duplicate', async () => {
    const before = await provider.listExceptions('TEAM-001');
    const pending = before!.exceptions.filter((e) => e.dimension_id === '7' && e.status === 'requested');
    expect(pending.length).toBe(1); // seeded fixture precondition

    await provider.applyScores('TEAM-001', {
      relevant_dimension_ids: ['7'],
      scores: [{ dimension_id: '7', is_na: true, suggested_level: null, confidence: 'moderate', rationale: 'Still pending.' }],
    });
    const after = await provider.listExceptions('TEAM-001');
    expect(after!.exceptions.filter((e) => e.dimension_id === '7' && e.status === 'requested').length).toBe(1);
    // and it still isn't honoured — no approval exists yet.
    const detail = await provider.getTeamDetail('TEAM-001');
    expect(detail!.dimensions.find((d) => d.id === '7')!.is_na).toBe(false);
  });

  it('rejects a non-integer suggested_level', async () => {
    const result = await provider.applyScores('TEAM-006', {
      relevant_dimension_ids: ['3'],
      scores: [{ dimension_id: '3', suggested_level: 2.5, confidence: 'moderate', rationale: 'test' }],
    });
    expect(result!.applied).toHaveLength(0);
    expect(result!.rejected[0]!.reason).toMatch(/must be an integer/);
  });
});

describe('prototype pollution guard: "__proto__" as a caller-supplied map key', () => {
  afterEach(() => {
    // The invariant under test, checked after every case in this block: no
    // fix here is allowed to leak onto the shared Object.prototype.
    expect(Object.prototype.hasOwnProperty('status')).toBe(false);
    expect(Object.prototype.hasOwnProperty('markdown')).toBe(false);
    expect(Object.prototype.hasOwnProperty('ingested_at')).toBe(false);
  });

  it('commitSubmissions with envelope_ids: ["__proto__"] commits nothing', async () => {
    const result = await provider.commitSubmissions({ team_id: 'TEAM-002', envelope_ids: ['__proto__'] });
    expect(result.committed).toEqual([]);
  });

  it('getSubmissionDetail("__proto__") returns null, not Object.prototype', async () => {
    const env = await provider.getSubmissionDetail('TEAM-002', '__proto__');
    expect(env).toBeNull();
  });

  it('updateSubmissionLink("__proto__") returns null', async () => {
    const env = await provider.updateSubmissionLink('TEAM-002', '__proto__', { dimension_id: '1', status: 'fetched' });
    expect(env).toBeNull();
  });

  it('deleteSubmission("__proto__") returns false', async () => {
    expect(await provider.deleteSubmission('TEAM-002', '__proto__')).toBe(false);
  });

  it('clearSubmissions with a "__proto__" envelope_id target clears nothing', async () => {
    const result = await provider.clearSubmissions({ targets: [{ team_id: 'TEAM-002', envelope_id: '__proto__' }] });
    expect(result.cleared).toBe(0);
  });

  it('getKnowledgeDoc("__proto__") returns null', async () => {
    expect(await provider.getKnowledgeDoc('__proto__')).toBeNull();
  });

  it('putKnowledgeDoc("__proto__") returns null and does not write markdown anywhere', async () => {
    const result = await provider.putKnowledgeDoc('__proto__', '# polluted');
    expect(result).toBeNull();
  });

  it('publishKnowledgeDoc("__proto__") 404s (ok: false)', async () => {
    const result = await provider.publishKnowledgeDoc('__proto__');
    expect(result.ok).toBe(false);
  });

  it('createKnowledgeComment("__proto__") returns null', async () => {
    expect(await provider.createKnowledgeComment('__proto__', 'hi')).toBeNull();
  });
});

describe('virtual-* feedback tasks can be resolved and dismissed', () => {
  it('resolveFeedback on a virtual task answers the underlying follow-up question so it stops reappearing', async () => {
    const open = (await provider.listFeedback({ kind: 'follow_up', status: 'OPEN' })).filter((t) => t.virtual);
    expect(open.length).toBeGreaterThanOrEqual(2); // seeded fixture precondition
    const target = open[0]!;

    const result = await provider.resolveFeedback(target.task_id, 'Answered via evidence walkthrough.');
    expect(result).not.toBeNull();
    expect(result!.task_id).toBe(target.task_id); // wire shape: task_id is unchanged
    expect(result!.status).toBe('RESOLVED');
    expect(result!.response).toBe('Answered via evidence walkthrough.');

    const stillOpen = await provider.listFeedback({ kind: 'follow_up', status: 'OPEN' });
    expect(stillOpen.some((t) => t.task_id === target.task_id)).toBe(false);
  });

  it('dismissFeedback on a virtual task drops the underlying follow-up question so it stops reappearing', async () => {
    const open = (await provider.listFeedback({ kind: 'follow_up', status: 'OPEN' })).filter((t) => t.virtual);
    expect(open.length).toBeGreaterThanOrEqual(1);
    const target = open[0]!;

    const result = await provider.dismissFeedback(target.task_id);
    expect(result).not.toBeNull();
    expect(result!.task_id).toBe(target.task_id);
    expect(result!.status).toBe('DISMISSED');

    const stillOpen = await provider.listFeedback({ kind: 'follow_up', status: 'OPEN' });
    expect(stillOpen.some((t) => t.task_id === target.task_id)).toBe(false);
  });

  it('an unknown virtual task id returns null rather than throwing', async () => {
    expect(await provider.resolveFeedback('virtual-Q-doesnotexist', 'x')).toBeNull();
    expect(await provider.dismissFeedback('virtual-Q-doesnotexist')).toBeNull();
  });
});

// Re-processing a submission (a new revision, a re-run) must not stack
// another copy of a follow-up the team has not answered yet — the audit saw
// three near-identical open questions on one dimension after three runs.
describe('applyScores follow-up idempotency', () => {
  it('asks a question once while it is OPEN, and matches ignoring case/punctuation', async () => {
    const payload = {
      relevant_dimension_ids: ['4'],
      scores: [{
        dimension_id: '4', suggested_level: 2, confidence: 'moderate', rationale: 'r',
        evidence_excerpts: [], follow_up_questions: ['Which repos enforce signed commits?'],
      }],
    };
    await provider.applyScores('TEAM-003', payload);
    await provider.applyScores('TEAM-003', { ...payload, scores: [{ ...payload.scores[0]!, follow_up_questions: ['which repos enforce signed commits'] }] });
    const dim = M.scoresFor('TEAM-003')!['4']!;
    const open = dim.follow_up_questions.filter((q) => q.status === 'OPEN' && provider.normalizeQuestion(q.text) === 'which repos enforce signed commits');
    expect(open).toHaveLength(1);
  });
});
