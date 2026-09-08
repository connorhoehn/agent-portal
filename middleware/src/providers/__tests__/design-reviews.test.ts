// The ADR loop's decision rules + the mock loop end-to-end.

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import {
  APPROVALS_REQUIRED, decideApproval, tallySignoffs,
  listDesignReviews, getDesignThread, answerQuestion, signoffDesign,
} from '../design-reviews.js';

describe('decideApproval — the ADR gate', () => {
  const deps = new Map<string, 'approved' | 'ideating'>([['d1', 'approved'], ['d2', 'ideating']]);

  it('refuses while questions are open, naming the count', () => {
    const r = decideApproval({ status: 'awaiting_input', openQuestions: 2, dependsOn: [] }, true, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/2 questions still open/);
  });

  it('refuses without a decision post', () => {
    const r = decideApproval({ status: 'ideating', openQuestions: 0, dependsOn: [] }, false, deps);
    expect(r.ok).toBe(false);
  });

  it('refuses while a dependency is unapproved, naming the blocker', () => {
    const r = decideApproval({ status: 'proposed', openQuestions: 0, dependsOn: ['d2'] }, true, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blockingId).toBe('d2');
  });

  it('passes with a decision, no open questions, approved dependencies', () => {
    expect(decideApproval({ status: 'proposed', openQuestions: 0, dependsOn: ['d1'] }, true, deps).ok).toBe(true);
  });
});

describe('tallySignoffs', () => {
  it('latest sign-off per person wins, and one reject blocks', () => {
    const t = tallySignoffs([
      { personName: 'a', role: 'sme', decision: 'reject', at: '1' },
      { personName: 'a', role: 'sme', decision: 'approve', at: '2' },
      { personName: 'b', role: 'owner', decision: 'approve', at: '3' },
    ]);
    expect(t.approvals).toBe(2);
    expect(t.rejections).toBe(0);
    expect(t.approved).toBe(APPROVALS_REQUIRED <= 2);
  });
});

describe('the mock HITL loop end-to-end', () => {
  it('lists the three canonical threads', async () => {
    const reviews = await listDesignReviews();
    expect(reviews.length).toBeGreaterThanOrEqual(3);
    expect(reviews.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining(
      ['des-obs-sampling', 'des-auth-rotation', 'des-obs-dashboards']));
  });

  it('refuses to approve the gated dashboards design only while its ADR is unapproved', async () => {
    // des-obs-dashboards depends on des-obs-sampling, which IS approved in the
    // fixtures — but it has no decision post, so approval still refuses.
    const r = await signoffDesign('des-obs-dashboards', 'approve', 'Test Person', 'sme');
    expect(r && 'error' in r && r.error).toMatch(/no decision post/);
  });

  it('answering the open question advances the thread to proposed with an agent revision', async () => {
    const before = await getDesignThread('des-auth-rotation');
    expect(before?.status).toBe('awaiting_input');
    expect(before?.openQuestions).toBe(1);

    const after = await answerQuestion(
      'des-auth-rotation', 'dp-q-rotation',
      'SOC2 control AC-7 requires ≤60s — shorten the refresh loop.', 'Vera Green');
    expect(after?.openQuestions).toBe(0);
    expect(after?.status).toBe('proposed');
    const kinds = (after?.posts ?? []).map((p: { kind: string }) => p.kind);
    // answer, then the agent's revision, then a proposed decision.
    expect(kinds).toEqual(expect.arrayContaining(['answer', 'revision', 'decision']));
  });

  it('two approvals ratify the ADR and log it to the KB', async () => {
    const one = await signoffDesign('des-auth-rotation', 'approve', 'Vera Green', 'org-leader');
    expect(one && 'thread' in one && one.thread?.status).not.toBe('approved');
    const two = await signoffDesign('des-auth-rotation', 'approve', 'Nora DaSilva', 'sme');
    expect(two && 'thread' in two && two.thread?.status).toBe('approved');
    expect(two && 'thread' in two && two.thread?.kbSynced).toBe(true);
  });
});
