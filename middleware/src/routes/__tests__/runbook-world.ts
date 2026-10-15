// Shared fixtures for the runbook route suites: a private store, a handful of
// people, and the identity/project providers that make them stewards (or not).
// Not a test file (jest only runs *.test.ts).
import { RowsRunbookStore, privateRowSources, versionOf, renderRunbook, type Runbook, type RunbookStore } from '../../lib/runbooks/index.js';
import { flakyRerunDiff, ssoNewOrigin, tenantCutoverV1, tenantCutoverV2 } from '../../lib/runbooks/__tests__/fixtures/good.js';

export interface TestUser { sub: string; role: string; tenant: string; personId: string }

/** sub → who they are. `sub` is the account; `personId` the linked person. */
export const USERS: Record<string, TestUser> = {
  member:    { sub: 'u-mem',    role: 'member',        tenant: 'orgiq', personId: 'p-300' },
  owner:     { sub: 'u-own',    role: 'sme',           tenant: 'orgiq', personId: 'p-100' }, // owns rb-tenant-cutover
  smeAuth:   { sub: 'u-sme-a',  role: 'sme',           tenant: 'orgiq', personId: 'p-101' }, // contributes to p-auth
  smeOther:  { sub: 'u-sme-o',  role: 'sme',           tenant: 'orgiq', personId: 'p-102' }, // contributes to p-other only
  proposer:  { sub: 'u-prop',   role: 'sme',           tenant: 'orgiq', personId: 'p-103' }, // contributes to p-auth AND proposes
  leader:    { sub: 'u-lead',   role: 'org-leader',    tenant: 'orgiq', personId: 'p-400' },
  programOwner: { sub: 'u-po',  role: 'program-owner', tenant: 'orgiq', personId: 'p-500' }, // on neither initiative
  hr:        { sub: 'u-hr',     role: 'hr-admin',      tenant: 'orgiq', personId: 'p-600' },
  admin:     { sub: 'u-admin',  role: 'admin',         tenant: 'orgiq', personId: 'p-700' },
  assessor:  { sub: 'u-asr',    role: 'assessor',      tenant: 'assessment', personId: 'p-800' }, // parked in another tenant
  strayAssessor: { sub: 'u-asr2', role: 'assessor',   tenant: 'orgiq', personId: 'p-801' }, // in orgiq but holding no orgiq action (not a state a real cookie reaches)
};

export const personOf = (sub: string): string | null => Object.values(USERS).find((u) => u.sub === sub)?.personId ?? null;

export const PROJECTS: Record<string, { id: string; name: string; ownerId: string; contributors: Array<{ personId: string }>; repoFullName: string | null }> = {
  'p-auth': { id: 'p-auth', name: 'Auth Migration', ownerId: 'p-100', contributors: [{ personId: 'p-101' }, { personId: 'p-103' }], repoFullName: 'connorhoehnslalom/orgiq-auth-service' },
  'p-other': { id: 'p-other', name: 'Other Initiative', ownerId: 'p-200', contributors: [{ personId: 'p-102' }], repoFullName: 'connorhoehnslalom/orgiq-other' },
};

const AT = '2026-10-01T00:00:00.000Z';

/** Two published runbooks on different initiatives, one org-wide, each at v1 (cutover) or v1. */
export function seededStore(): RunbookStore {
  const src = privateRowSources();
  const store = new RowsRunbookStore(src);
  const add = async (r: Runbook, doc: Parameters<typeof versionOf>[0]['doc']) => {
    await store.createRunbook(r, versionOf({ runbook_id: r.id, version: 1, doc, author: { kind: 'person', id: r.owner_person_id }, accepted_by: r.owner_person_id, accepted_at: AT }));
  };
  const base = { status: 'published' as const, current_version: 1, created_at: AT, updated_at: AT };
  // Seeded synchronously through the private arrays so a suite can build the world in beforeEach without awaiting.
  const rb = (id: string, scope: Runbook['scope'], owner: string, doc: Parameters<typeof versionOf>[0]['doc']) => {
    src.runbooks().push({ id, scope, owner_person_id: owner, ...base });
    src.versions().push(versionOf({ runbook_id: id, version: 1, doc, author: { kind: 'person', id: owner }, accepted_by: owner, accepted_at: AT }));
  };
  void add;
  rb('rb-tenant-cutover', { kind: 'initiative', ref: 'p-auth' }, 'p-100', tenantCutoverV1);
  rb('rb-sso-new-origin', { kind: 'initiative', ref: 'p-other' }, 'p-200', ssoNewOrigin);
  rb('rb-flaky-test-rerun-diff', { kind: 'org', ref: null }, 'p-001', flakyRerunDiff);
  return store;
}

/** Canonical markdown of the v2 edit, and a second, different edit of the same base. */
export const EDIT_MD = renderRunbook(tenantCutoverV2);
export const EDIT_MD_ALT = renderRunbook({ ...tenantCutoverV2, summary: 'Move one tenant from the SAML shim to Cognito in the order that keeps everyone signed in, with a five-minute way back.' });
export const NEW_MD = renderRunbook({
  ...flakyRerunDiff,
  title: 'Rerun a flaky test against its own diff',
  summary: 'Rerun a flaky test with the diff that introduced it applied so you can tell a flake from a regression.',
});
