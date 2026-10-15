import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attentionCount, attentionPrompts } from '../workAttentionPrompts.ts';
import type { Job, LabConsult, Proposal } from '../workShared';

const now = '2026-10-14T09:00:00Z';
const consult: LabConsult = { id: 'c1', question: 'Keep the legacy cookie?', context: 'Two clients read it.', repo: 'orgiq-auth-service', boxId: 'box-1', sessionId: null, status: 'pending', answer: null, answeredBy: null, createdAt: now };
const job = (status: string): Job => ({ id: `j-${status}`, kind: 'devbox:task', title: 'Rotate keys', status, priority: 1, boxId: null, attempts: 1, maxAttempts: 3, result: { summary: 'Done.', costUsd: 0.42 }, error: null, createdAt: now, finishedAt: now, botId: null, botName: null, botTrigger: null });
const proposal: Proposal = { id: 'p1', source: 'adr.md', kind: 'link_person_skill', targetId: 'p-014', payload: {}, rationale: 'Named in the ADR.', confidence: 0.86, evidence: { quote: 'Index design by Nora' }, status: 'pending', applyError: null, createdAt: now };
const calls: string[] = [];
const handlers = {
  answerConsult: async (id: string, a: string) => { calls.push(`consult ${id} ${a}`); },
  reviewJob: async (j: Job, d: string) => { calls.push(`review ${j.id} ${d}`); },
  decideProposal: async (p: Proposal, d: string) => { if (d === 'reject') throw new Error('graph locked'); calls.push(`proposal ${p.id} ${d}`); },
};
const build = (canDecide: boolean) => attentionPrompts({ consults: [consult], jobs: [job('awaiting_review'), job('completed')], proposals: [proposal], canDecide, money: (n) => `$${n}`, label: (k) => k }, handlers);

test('one prompt per item that waits on a person, questions first', () => {
  const prompts = build(true);
  assert.deepEqual(prompts.map((p) => p.id), ['consult:c1', 'review:j-awaiting_review', 'proposal:p1']);
  assert.equal(attentionCount([consult], [job('awaiting_review'), job('completed')], [proposal]), 3);
  assert.equal(prompts[0]!.kind, 'text');
  assert.deepEqual(prompts[1]!.options?.map((o) => o.id), ['accept', 'reject']);
});

test('answers call the page handlers; a failed write stays on the card', async () => {
  const [q, r, p] = build(true);
  assert.equal(await q!.onAnswer({ kind: 'text', text: 'Yes, one release' }), undefined);
  assert.equal(await r!.onAnswer({ kind: 'choice', optionId: 'accept' }), undefined);
  assert.deepEqual(await p!.onAnswer({ kind: 'choice', optionId: 'reject' }), { error: 'graph locked' });
  assert.deepEqual(calls, ['consult c1 Yes, one release', 'review j-awaiting_review accept']);
});

test('a reader without the capability sees the prompts read-only', () => {
  assert.ok(build(false).every((p) => typeof p.readOnlyReason === 'string' && p.readOnlyReason.length > 0));
  assert.ok(build(true).every((p) => p.readOnlyReason === undefined));
});
