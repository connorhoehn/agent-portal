import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAssessmentDimensionReference, resolveAssessmentDimensionReference } from '../assessmentPageReferences.ts';

const available = {
  kind: 'assessment-dimension', id: 'TEAM-005:7', status: 'available', title: '7. Testing',
  href: '/assessment/teams/TEAM-005?dimension=7', team: { id: 'TEAM-005', name: 'Team Five', href: '/assessment/teams/TEAM-005' },
  breadcrumbs: [{ title: 'Teams', href: '/assessment/teams' }, { title: 'Team Five', href: '/assessment/teams/TEAM-005' },
    { title: '7. Testing', href: '/assessment/teams/TEAM-005?dimension=7' }],
};

test('reads a canonical available reference and an unavailable one', () => {
  assert.deepEqual(readAssessmentDimensionReference(available), available);
  assert.deepEqual(readAssessmentDimensionReference({ kind: 'assessment-dimension', id: 'TEAM-005:7', status: 'unavailable', title: 'x' }),
    { kind: 'assessment-dimension', id: 'TEAM-005:7', status: 'unavailable' });
});

test('rejects forged kinds, ids, routes, teams and breadcrumbs', () => {
  for (const forged of [
    { ...available, kind: 'work-item' }, { ...available, id: 'team-005:7' }, { ...available, id: 'TEAM-005:../x' },
    { ...available, href: '//evil.invalid' }, { ...available, href: '/assessment/teams/TEAM-001?dimension=7' },
    { ...available, team: { ...available.team, id: 'TEAM-001' } }, { ...available, team: { ...available.team, href: '/iq' } },
    { ...available, breadcrumbs: [{ title: 'Evil', href: 'https://evil.invalid' }] }, { ...available, title: '' },
    { ...available, status: 'maybe' }, null, 'TEAM-005:7',
  ]) assert.equal(readAssessmentDimensionReference(forged), null, JSON.stringify(forged));
});

test('resolves through the BFF route and refuses a mismatched or failed answer', async () => {
  let url = '', init: RequestInit | undefined;
  const ok = (body: unknown, status = 200) => (async (input: RequestInfo | URL, options?: RequestInit) => {
    url = String(input); init = options; return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  assert.deepEqual(await resolveAssessmentDimensionReference('TEAM-005:7', undefined, ok({ pageReference: available })), available);
  assert.equal(url, '/api/page-references/resolve?kind=assessment-dimension&id=TEAM-005%3A7');
  assert.equal(init?.credentials, 'include'); assert.equal(init?.cache, 'no-store');
  await assert.rejects(resolveAssessmentDimensionReference('TEAM-005:8', undefined, ok({ pageReference: available })));
  await assert.rejects(resolveAssessmentDimensionReference('TEAM-005:7', undefined, ok({ error: 'nope' }, 400)));
});
