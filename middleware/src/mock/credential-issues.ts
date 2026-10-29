// Credential issues, offline — the `credential_issues` rows (DE-45).
//
// One row per repository token the BFF minted for a run: run, repo,
// provider, permissions, expiry, caller. NEVER the token — the row is what
// answers "which runs could push to repo X yesterday". Starts empty (nothing
// has been minted on a fresh stack); a mint pushes a row and a reset clears
// them.

import { clock, defineFixture } from './core/index.js';

export interface CredentialIssueRow {
  id: string;
  run_ref: string;
  repo: string;
  provider: 'github-app' | 'pat' | 'local';
  permissions: { contents: 'read' | 'write'; pull_requests?: 'write' };
  expires_at: string | null;
  caller_sub: string | null;
  created_at: string;
}

export const credentialIssues = defineFixture<CredentialIssueRow>({
  key: 'credential-issues',
  scenarios: {
    default: () => [],
  },
});

export function mockInsertCredentialIssue(row: Omit<CredentialIssueRow, 'id' | 'created_at'>): CredentialIssueRow {
  const rows = credentialIssues.rows();
  const full: CredentialIssueRow = {
    ...row,
    permissions: { ...row.permissions },
    id: `ci-${String(rows.length + 1).padStart(4, '0')}`,
    created_at: clock.nowIso(),
  };
  rows.push(full);
  return { ...full, permissions: { ...full.permissions } };
}

export function mockListCredentialIssues(filter: { repo?: string; runRef?: string } = {}): CredentialIssueRow[] {
  return credentialIssues.rows()
    .filter((r) => (!filter.repo || r.repo === filter.repo) && (!filter.runRef || r.run_ref === filter.runRef))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((r) => ({ ...r, permissions: { ...r.permissions } }));
}
