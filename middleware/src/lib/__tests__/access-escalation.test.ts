// lib/access-escalation.ts: which steps are due, when a step escalates next,
// and the SLA as a person reads it. The sweep itself (claims, bell, two
// replicas, escalated deciders deciding) runs through the routes in
// routes/__tests__/access-escalation-delegation.test.ts.
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', aurora: {}, auth: { policyStoreId: undefined, sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));

import { dueSteps, escalatesAt, escalationSlaMs, slaLabel } from '../access-escalation.js';
import type { AccessRequestRow, AccessStepRow } from '../../mock/access-requests.js';

const T = '2026-10-14T00:00:00.000Z';
const H = (h: number) => new Date(Date.parse(T) + h * 3_600_000).toISOString();
const step = (over: Partial<AccessStepRow> = {}): AccessStepRow => ({
  requestId: 'req-1', step: 1, kind: 'manager', status: 'current', decidedBy: null, decidedAt: null, comment: null,
  currentSince: T, escalationLevel: 0, escalatedAt: null, delegatedFrom: null, ...over,
});
const req = (over: Partial<AccessRequestRow> = {}): AccessRequestRow => ({
  id: 'req-1', kind: 'grant', reviewId: null, requesterId: 'u-rhea', beneficiaryId: 'u-rhea', itemId: 'role:orgiq:sme', justification: 'x'.repeat(20),
  duration: '7d', requestedUsd: null, forecast: null, status: 'submitted', sodVerdict: 'clear', sodOverriddenBy: null, sodOverrideReason: null, submittedAt: T,
  decidedAt: null, provisionedAt: null, expiresAt: null, revokedAt: null, expiryWarnedAt: null, ...over,
});
const SLA = 48 * 3_600_000;

afterEach(() => { delete process.env['ACCESS_ESCALATION_SLA_MS']; });

it('the SLA defaults to 48 hours and is configured by ACCESS_ESCALATION_SLA_MS', () => {
  expect(escalationSlaMs()).toBe(SLA);
  process.env['ACCESS_ESCALATION_SLA_MS'] = '3600000';
  expect(escalationSlaMs()).toBe(3_600_000);
  process.env['ACCESS_ESCALATION_SLA_MS'] = 'nonsense';
  expect(escalationSlaMs()).toBe(SLA);
  expect([slaLabel(SLA), slaLabel(24 * 3_600_000), slaLabel(3_600_000), slaLabel(90_000)]).toEqual(['2 days', '24 h', '1 h', '2 min']);
});

it('escalatesAt counts from currentSince, then from the last escalation; null when not current or at the top', () => {
  expect(escalatesAt(step(), SLA)).toBe(H(48));
  expect(escalatesAt(step({ escalationLevel: 1, escalatedAt: H(50) }), SLA)).toBe(H(98));
  expect(escalatesAt(step({ escalationLevel: 2, escalatedAt: H(50) }), SLA)).toBeNull();
  expect(escalatesAt(step({ status: 'waiting' }), SLA)).toBeNull();
  expect(escalatesAt(step({ status: 'info-requested' }), SLA)).toBeNull();
  expect(escalatesAt(step({ currentSince: null }), SLA)).toBeNull();
});

it('dueSteps: current steps of open grant requests whose SLA has run out', () => {
  expect(dueSteps([req()], [step()], H(47.9), SLA)).toEqual([]);
  expect(dueSteps([req()], [step()], H(48), SLA).map((d) => d.step.step)).toEqual([1]);
  // A closed request, a revocation, or a decided step never escalates.
  expect(dueSteps([req({ status: 'approved' })], [step()], H(100), SLA)).toEqual([]);
  expect(dueSteps([req({ kind: 'revocation' })], [step()], H(100), SLA)).toEqual([]);
  expect(dueSteps([req()], [step({ status: 'approved' })], H(100), SLA)).toEqual([]);
});
