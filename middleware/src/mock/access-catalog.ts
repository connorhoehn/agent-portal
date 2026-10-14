// The access tenant's catalog — what can be requested (docs/access-tenant-design.md §3).
//
// Live: `access_catalog_items` (schema/access_schema.sql, additive, NOT applied
// to Aurora — lane E). This registered fixture is its offline mirror under
// MOCK_AURORA, row for row with the seed (the parity harness's `access catalog`
// entity compares them by id); `POST /api/__mock/reset` restores it.
//
// Rows only. Whether the actor already holds an item and which SoD policies it
// conflicts with are computed per request from the actor's current grants
// (lib/access/), never stored here.

import { defineFixture } from './core/index.js';
import type { AccessDuration, AccessKind, AccessTenant, StewardRule } from '../lib/access/types.js';

export interface AccessCatalogRow {
  id: string;
  kind: AccessKind;
  tenant: AccessTenant;
  role: string | null;
  projectId: string | null;
  title: string;
  description: string;
  sensitive: boolean;
  defaultDuration: AccessDuration;
  stewardRule: StewardRule;
}

const role = (tenant: AccessTenant, r: string, title: string, description: string, sensitive: boolean, defaultDuration: AccessDuration): AccessCatalogRow =>
  ({ id: `role:${tenant}:${r}`, kind: 'tenant-role', tenant, role: r, projectId: null, title, description, sensitive, defaultDuration, stewardRule: 'tenant-steward' });
const initiative = (projectId: string, title: string, description: string): AccessCatalogRow =>
  ({ id: `initiative:${projectId}`, kind: 'initiative-membership', tenant: 'orgiq', role: null, projectId, title, description, sensitive: false, defaultDuration: '30d', stewardRule: 'initiative-owner' });

export const accessCatalogFixture = defineFixture<AccessCatalogRow>({
  key: 'access.catalog',
  scenarios: {
    default: () => [
      role('orgiq', 'sme', 'SME in Work', 'Dispatch agent work against a granted sprint envelope on the initiatives you contribute to.', false, '30d'),
      role('orgiq', 'org-leader', 'Org leader in Work', 'Full org visibility, leaderboards, budget allocation and transaction approval over $10k.', true, '7d'),
      role('assessment', 'assessor', 'Assessor in Assessment', 'Score dimensions and manage submission intake.', false, '30d'),
      role('assessment', 'lead-assessor', 'Lead assessor in Assessment', 'Approve N/A exceptions and publish team reports.', true, '7d'),
      role('social', 'moderator', 'Moderator in Social', 'Manage channels, teams and recordings.', false, '30d'),
      role('pipelines', 'operator', 'Operator in Pipelines', 'Run pipelines, approve steps waiting on a person and cancel runs.', false, '7d'),
      // Budget visibility (decided 2026-10-13): the narrowest grant that opens the
      // budgets read tier — the orgiq capability grant `budgets-reader`
      // (lib/session.ts CAPABILITY_GRANTS), recognised only by
      // lib/budget-read-tier.ts. Stewarded by the orgiq budget owner (org-leader).
      {
        id: 'capability:orgiq:budgets-read', kind: 'capability', tenant: 'orgiq', role: 'budgets-reader', projectId: null,
        title: 'Budget visibility in Work',
        description: 'See month-to-date spend and allocations on the Initiatives table, the detail header and budget answers. Grants no role and no budget authority.',
        sensitive: false, defaultDuration: '30d', stewardRule: 'budget-owner',
      },
      initiative('p-auth-migration', 'Member of Auth Migration', 'Contribute to the Auth Migration initiative: its board, discussion and dispatched work.'),
      initiative('p-observability', 'Member of Observability Platform', 'Contribute to the Observability Platform initiative: its board, discussion and dispatched work.'),
    ],
    empty: () => [],
  },
});

/** One catalog item by id, or undefined. */
export function findCatalogItem(id: string): AccessCatalogRow | undefined {
  return accessCatalogFixture.rows().find((i) => i.id === id);
}
