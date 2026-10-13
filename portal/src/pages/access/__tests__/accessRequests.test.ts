import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EMPTY_DRAFT, JUSTIFICATION_MIN, chainSteps, currentStep, draftProblem, filterCatalog, filterRequests, matchesStatusFilter,
  requestHref, requestTitle, submitBody, type AccessRequest, type CatalogItem, type RequestStatus,
} from '../../../lib/accessRequests.ts';

const item = (over: Partial<CatalogItem> = {}): CatalogItem => ({
  id: 'role:orgiq:sme', kind: 'tenant-role', tenant: 'orgiq', role: 'sme', title: 'SME in Work', description: 'Dispatch agent runs',
  sensitive: false, defaultDuration: '7d', stewardRule: 'tenant-steward', heldByActor: false, sodConflicts: [], ...over,
});
const person = (id: string, displayName: string) => ({ id, displayName });
const request = (over: Partial<AccessRequest> = {}): AccessRequest => ({
  id: 'req-0001', requester: person('u-rhea', 'Rhea Castellanos'), beneficiary: person('u-rhea', 'Rhea Castellanos'), item: item(),
  justification: 'Need to dispatch the auth migration agents', duration: '7d', status: 'pending',
  steps: [
    { step: 1, kind: 'manager', status: 'approved', decidedBy: person('u-omar', 'Omar Haddad'), eligible: [] },
    { step: 2, kind: 'steward', status: 'current', eligible: [person('u-rachel', 'Rachel')] },
    { step: 3, kind: 'access-admin', status: 'waiting', eligible: [] },
  ],
  submittedAt: '2026-10-12T09:00:00.000Z', sod: { verdict: 'clear', conflicts: [] },
  can: { decide: false, withdraw: true, viewAudit: true }, thread: 'access:req:req-0001', ...over,
});

test('status filter buckets: open, approved, active, closed', () => {
  const cases: Array<[RequestStatus, string]> = [['submitted', 'open'], ['pending', 'open'], ['approved', 'approved'],
    ['provisioned', 'active'], ['active', 'active'], ['rejected', 'closed'], ['withdrawn', 'closed'], ['expired', 'closed'], ['revoked', 'closed']];
  for (const [status, bucket] of cases) {
    assert.equal(matchesStatusFilter(status, bucket), true, `${status} in ${bucket}`);
    assert.equal(matchesStatusFilter(status, ''), true);
  }
  assert.equal(matchesStatusFilter('pending', 'closed'), false);
  assert.equal(matchesStatusFilter('pending', 'nonsense'), false);
});

test('search reaches ids, people and items; the tenant filter is exact', () => {
  const rows = [request(), request({ id: 'req-0002', beneficiary: person('u-theo', 'Theo'), status: 'rejected' })];
  assert.deepEqual(filterRequests(rows, 'theo', '').map(r => r.id), ['req-0002']);
  assert.deepEqual(filterRequests(rows, '', 'open').map(r => r.id), ['req-0001']);
  assert.deepEqual(filterRequests(rows, 'REQ-0001', '').map(r => r.id), ['req-0001']);
  const catalog = [item(), item({ id: 'role:pipelines:operator', tenant: 'pipelines', role: 'operator', title: 'Operator in Pipelines' })];
  assert.deepEqual(filterCatalog(catalog, '', 'pipelines').map(i => i.id), ['role:pipelines:operator']);
  assert.deepEqual(filterCatalog(catalog, 'sme', '').map(i => i.id), ['role:orgiq:sme']);
});

test('the chain: the current step is active, decided steps are done, a rejection stays visible', () => {
  const r = request();
  assert.equal(currentStep(r)?.step, 2);
  assert.deepEqual(chainSteps(r.steps).map(s => [s.done, s.active]), [[true, false], [false, true], [false, false]]);
  const rejected = chainSteps([{ step: 1, kind: 'manager', status: 'rejected', eligible: [] }]);
  assert.equal(rejected[0].active, true);
  assert.match(rejected[0].label, /rejected/);
  assert.equal(currentStep(request({ steps: [] })), null);
});

test('titles name the beneficiary only when it is someone else', () => {
  assert.equal(requestTitle(request()), 'SME in Work');
  assert.equal(requestTitle(request({ beneficiary: person('u-theo', 'Theo') })), 'SME in Work for Theo');
  assert.equal(requestHref('req 1'), '/access/requests/req%201');
});

test('wizard: each step names what blocks it; a blocking SoD conflict stops step two', () => {
  const draft = { ...EMPTY_DRAFT };
  assert.match(draftProblem(0, draft, null)!, /who/);
  assert.equal(draftProblem(0, { ...draft, beneficiaryId: 'u-rhea' }, null), null);
  assert.match(draftProblem(1, draft, null)!, /catalog/);
  assert.match(draftProblem(1, draft, item({ sodConflicts: [{ policyId: 'sod-1', reason: 'x', severity: 'block' }] }))!, /separation-of-duties/);
  assert.equal(draftProblem(1, draft, item({ sodConflicts: [{ policyId: 'sod-1', reason: 'x', severity: 'warn' }] })), null);
  assert.match(draftProblem(2, { ...draft, justification: 'too short' }, item())!, new RegExp(String(JUSTIFICATION_MIN)));
  assert.equal(draftProblem(2, { ...draft, justification: 'x'.repeat(JUSTIFICATION_MIN) }, item()), null);
  assert.match(draftProblem(3, draft, item())!, /how long/);
  assert.match(draftProblem(3, { ...draft, duration: 'standing' }, item())!, /Standing/);
  assert.equal(draftProblem(3, { ...draft, duration: 'standing', standingReason: 'y'.repeat(JUSTIFICATION_MIN) }, item()), null);
});

test('submit body carries only the route\'s keys, and a beneficiary only on behalf of someone else', () => {
  const base = { ...EMPTY_DRAFT, itemId: 'role:orgiq:sme', justification: '  Need to dispatch the auth migration agents  ', duration: '7d' as const };
  assert.deepEqual(submitBody({ ...base, beneficiaryId: 'u-rhea' }, 'u-rhea'), { itemId: 'role:orgiq:sme', justification: 'Need to dispatch the auth migration agents', duration: '7d' });
  assert.equal(submitBody({ ...base, beneficiaryId: 'u-theo' }, 'u-omar').beneficiaryId, 'u-theo');
  assert.match(submitBody({ ...base, beneficiaryId: 'u-rhea', duration: 'standing', standingReason: 'Permanent on-call rotation owner' }, 'u-rhea').justification, /Standing access: Permanent/);
  assert.throws(() => submitBody({ ...base, duration: '' }, 'u-rhea'));
});
