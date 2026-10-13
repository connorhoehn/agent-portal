// Lane A2's pure helpers (lib/accessRequests.ts): the campaign and item
// filters the toolbar and the command composer share, the decision / campaign
// / override guards the pages disable their controls on, the configuration
// PUT body, and the audit scope notice — plus the review record's command
// grammar, which never decides.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCollectionCommand } from '../../../components/collections/collectionCommands.ts';
import {
  auditScopeNotice, campaignProblem, configurationPatch, filterReviewItems, filterReviews, overrideProblem,
  reviewDecisionProblem, reviewHref, reviewItemTitle, reviewProgressLabel,
  type AccessConfiguration, type AccessReview, type AccessReviewItem,
} from '../../../lib/accessRequests.ts';
import { ACCESS_GRAMMARS, accessCollectionAdapter } from '../accessCollectionCommands.ts';
import { ACCESS_SURFACES } from '../accessSurfaces.ts';

const person = (id: string, displayName: string) => ({ id, displayName });
const review = (over: Partial<AccessReview> = {}): AccessReview => ({
  id: 'rev-0001', tenant: 'orgiq', title: 'Q4 SME certification — Work', status: 'open', owner: person('u-priya', 'Priya Venkataraman'),
  openedAt: '2026-10-08T10:00:00.000Z', closedAt: null, progress: { total: 4, decided: 2, kept: 2, revoked: 0 }, can: { decide: true }, ...over,
});
const item = (id: string, user: string, decision: AccessReviewItem['decision'], comment: string | null = null): AccessReviewItem => ({
  id, reviewId: 'rev-0001', user: person(`u-${user.toLowerCase()}`, user), tenant: 'orgiq', role: 'sme', decision,
  decidedBy: decision ? person('u-priya', 'Priya Venkataraman') : null, decidedAt: decision ? '2026-10-11T10:00:00.000Z' : null,
  comment, revocationRequestId: decision === 'revoke' ? 'req-0009' : null, can: { decide: decision === null },
});

test('campaigns filter by status and search title, workspace and owner', () => {
  const rows = [review(), review({ id: 'rev-0002', tenant: 'pipelines', title: 'Pipelines Q4', status: 'closed' })];
  assert.deepEqual(filterReviews(rows, '', 'open').map((r) => r.id), ['rev-0001']);
  assert.deepEqual(filterReviews(rows, 'pipelines', '').map((r) => r.id), ['rev-0002']);
  assert.deepEqual(filterReviews(rows, 'priya', 'closed').map((r) => r.id), ['rev-0002']);
  assert.equal(reviewProgressLabel(rows[0]!.progress), '2 of 4 decided');
  assert.equal(reviewHref('rev 1'), '/access/reviews/rev%201');
});

test('items filter by undecided / kept / revoked and search the person, role and comment', () => {
  const rows = [item('ri-1', 'Nora', 'keep', 'Owns the bots'), item('ri-2', 'Caleb', 'revoke', 'No work since July'), item('ri-3', 'Layla', null)];
  assert.deepEqual(filterReviewItems(rows, '', 'open').map((i) => i.id), ['ri-3']);
  assert.deepEqual(filterReviewItems(rows, '', 'keep').map((i) => i.id), ['ri-1']);
  assert.deepEqual(filterReviewItems(rows, '', 'revoke').map((i) => i.id), ['ri-2']);
  assert.deepEqual(filterReviewItems(rows, 'july', '').map((i) => i.id), ['ri-2']);
  assert.equal(reviewItemTitle(rows[0]!), 'Nora · sme');
});

test('the guards the pages disable their controls on', () => {
  assert.match(reviewDecisionProblem('revoke', '  ') ?? '', /needs a comment/);
  assert.equal(reviewDecisionProblem('revoke', 'Left the team'), null);
  assert.equal(reviewDecisionProblem('keep', ''), null);
  assert.match(campaignProblem('', 'Work Q4') ?? '', /workspace/);
  assert.match(campaignProblem('orgiq', 'Q4') ?? '', /at least 3/);
  assert.equal(campaignProblem('orgiq', 'Work Q4'), null);
  assert.match(overrideProblem('Fine by me.') ?? '', /at least 20 characters \(11 so far\)/);
  assert.equal(overrideProblem('Finance reviewed the overlap this quarter.'), null);
});

test('the configuration PUT carries only what changed', () => {
  const items: AccessConfiguration['items'] = [
    { id: 'role:orgiq:sme', title: 'SME in Work', kind: 'tenant-role', tenant: 'orgiq', defaultDuration: '30d', stewardRule: 'tenant-steward', sensitive: false },
    { id: 'role:orgiq:org-leader', title: 'Org leader in Work', kind: 'tenant-role', tenant: 'orgiq', defaultDuration: '7d', stewardRule: 'tenant-steward', sensitive: true },
  ];
  assert.deepEqual(configurationPatch(items, {}), { items: [] });
  assert.deepEqual(configurationPatch(items, { 'role:orgiq:sme': { defaultDuration: '30d' }, 'role:orgiq:org-leader': { sensitive: true } }), { items: [] });
  assert.deepEqual(configurationPatch(items, { 'role:orgiq:sme': { defaultDuration: '7d', sensitive: false }, 'role:orgiq:org-leader': { sensitive: false } }),
    { items: [{ id: 'role:orgiq:sme', defaultDuration: '7d' }, { id: 'role:orgiq:org-leader', sensitive: false }] });
});

test('the audit says whose events it shows, as the server scopes them', () => {
  assert.match(auditScopeNotice('access-admin'), /every event/);
  assert.match(auditScopeNotice('admin'), /every event/);
  assert.match(auditScopeNotice('approver'), /requests you may open/);
  assert.match(auditScopeNotice('requester'), /requests you may open/);
});

test('the review record grammar filters and opens but never keeps or revokes', async () => {
  const g = ACCESS_GRAMMARS.review;
  assert.deepEqual(parseCollectionCommand('show undecided review items', g), { kind: 'filter', value: 'open' });
  assert.deepEqual(parseCollectionCommand('filter revoked', g), { kind: 'filter', value: 'revoke' });
  for (const text of ['keep ri-0003', 'revoke ri-0004', 'revoke all', 'close the campaign']) assert.throws(() => parseCollectionCommand(text, g), Error, text);
  const calls: string[] = [];
  const adapter = accessCollectionAdapter('review', { setQuery: (v) => { calls.push(`q:${v}`); }, setFilter: (v) => { calls.push(`f:${v}`); }, refresh: () => { calls.push('r'); } });
  assert.equal(adapter.id, 'access-review-commands');
  await adapter.execute('show kept review items');
  assert.deepEqual(calls, ['f:keep']);
  assert.deepEqual(parseCollectionCommand('show open reviews', ACCESS_GRAMMARS.reviews), { kind: 'filter', value: 'open' });
});

test('the review record is a collection record that requires the composer, in Govern', () => {
  assert.deepEqual([ACCESS_SURFACES.review.path, ACCESS_SURFACES.review.group, ACCESS_SURFACES.review.composer, ACCESS_SURFACES.review.phase],
    ['/access/reviews/:id', 'Govern', 'required', 'A2']);
});

test('a step names who may decide only while the request is open; a policy event opens the policies', async () => {
  const { eligibleLabel, eventHref } = await import('../../../lib/accessRequests.ts');
  const step = { step: 1, kind: 'manager' as const, status: 'current' as const, eligible: [person('u-priya', 'Priya Venkataraman')], escalated: 'Escalated to the access admins: the manager is a party to this request.' };
  assert.equal(eligibleLabel(step, 'submitted'), 'Priya Venkataraman');
  assert.equal(eligibleLabel({ ...step, status: 'skipped' }, 'withdrawn'), '—');
  assert.equal(eligibleLabel({ ...step, eligible: [] }, 'rejected'), '—');
  assert.equal(eligibleLabel({ ...step, eligible: [] }, 'pending'), 'No one can decide this step');
  assert.equal(eventHref({ requestId: 'req-0002' }), '/access/requests/req-0002');
  assert.equal(eventHref({ requestId: null }), '/access/policies');
});
