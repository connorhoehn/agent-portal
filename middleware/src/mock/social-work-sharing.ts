// Work-sharing grants under dev:mock (docs/communication-plane-goal.md §3):
// a person's decision to show part of their work graph to a conversation or a
// Social team. The grant is realtime-modules' own `WorkSharingGrant` /
// `WorkHistoryGrant` (work-graph `createSharingGrant` /
// `transitionSharingGrant`), wrapped with the audience the plane resolves at
// read time — a conversation (its CURRENT members) or a Social team (its
// CURRENT roster) — because the library's audience type knows people and
// conversation ids, not teams.
//
// Live: DynamoDB `work-sharing` beside the chat tables when the chat store is
// Dynamo (lib/work-graph/sharing.ts DynamoWorkSharingStore); this registered
// fixture under MOCK_AURORA, so `POST /api/__mock/reset` undoes a share. Every
// timestamp comes from the mock clock at read time (contract rule 3); every
// state the plane reports is derived from these rows (rule 1).
//
// The seed: Vera (u-vera, person p-002, owner of #auth-migration) shares her
// Auth Migration work into `social:ch:auth-migration` — one active grant, and
// one she has since stopped whose history grant keeps what was shared before
// as `historical`. Theo and Mia, members of that channel, see both; Sana, who
// is not, sees nothing of it.

import type { WorkHistoryGrant, WorkSharingGrant } from '@connorhoehn/realtime-modules/work-graph';
import { WORK_GRAPH_SCHEMA_VERSION } from '@connorhoehn/realtime-modules/work-graph';
import { clock, defineFixture } from './core/index.js';

/** Who a grant is for, resolved fresh at read time. */
export type WorkSharingAudienceRef = { kind: 'conversation'; id: string } | { kind: 'team'; id: string };

export interface StoredWorkSharing {
  /** The work graph's tenant (`orgiq` today — the person subject is orgiq's). */
  organizationId: string;
  ownerId: string;
  grantId: string;
  kind: 'current' | 'history';
  audience: WorkSharingAudienceRef;
  grant: WorkSharingGrant | WorkHistoryGrant;
}

const AUTH_CHANNEL: WorkSharingAudienceRef = { kind: 'conversation', id: 'social:ch:auth-migration' };
const libraryAudience = (ref: WorkSharingAudienceRef) =>
  ref.kind === 'conversation' ? { kind: 'conversation' as const, conversationIds: [ref.id] } : { kind: 'people' as const, personIds: [] };

function seed(): StoredWorkSharing[] {
  const createdAt = clock.hoursAgo(3);
  const stoppedAt = clock.hoursAgo(1);
  // Sharing lasts at most a day (the library's maximumSharingMs); history up to a week.
  const expiresAt = new Date(Date.parse(clock.nowIso()) + 21 * 3_600_000).toISOString();
  const historyExpiresAt = new Date(Date.parse(clock.nowIso()) + 5 * 86_400_000).toISOString();
  const day = (iso: string) => iso.slice(0, 10);
  const active: WorkSharingGrant = {
    schemaVersion: WORK_GRAPH_SCHEMA_VERSION, id: 'wsg-vera-auth-current', organizationId: 'orgiq', ownerId: 'u-vera',
    audience: libraryAudience(AUTH_CHANNEL),
    selection: { nodeIds: ['initiative:p-auth-migration', 'work:wi-auth-e1', 'work:wi-auth-e1-b4'], edgeIds: [], disclosure: 'summary' },
    state: 'active', createdAt, updatedAt: createdAt, expiresAt, revision: 1,
  };
  const stopped: WorkSharingGrant = {
    schemaVersion: WORK_GRAPH_SCHEMA_VERSION, id: 'wsg-vera-auth-stopped', organizationId: 'orgiq', ownerId: 'u-vera',
    audience: libraryAudience(AUTH_CHANNEL),
    selection: { nodeIds: ['work:wi-auth-e2'], edgeIds: [], disclosure: 'summary' },
    state: 'stopped', createdAt: clock.daysAgo(1), updatedAt: stoppedAt, expiresAt, revision: 2, historyGrantId: 'wsg-vera-auth-history',
  };
  const history: WorkHistoryGrant = {
    schemaVersion: WORK_GRAPH_SCHEMA_VERSION, id: 'wsg-vera-auth-history', organizationId: 'orgiq', ownerId: 'u-vera',
    audience: libraryAudience(AUTH_CHANNEL),
    selection: { nodeIds: ['work:wi-auth-e2'], edgeIds: [], disclosure: 'summary' },
    state: 'active', createdAt: clock.daysAgo(1), updatedAt: clock.daysAgo(1), expiresAt: historyExpiresAt, revision: 1,
    dayFrom: day(clock.daysAgo(1)), dayThrough: day(clock.nowIso()),
  };
  return [
    { organizationId: 'orgiq', ownerId: 'u-vera', grantId: active.id, kind: 'current', audience: AUTH_CHANNEL, grant: active },
    { organizationId: 'orgiq', ownerId: 'u-vera', grantId: stopped.id, kind: 'current', audience: AUTH_CHANNEL, grant: stopped },
    { organizationId: 'orgiq', ownerId: 'u-vera', grantId: history.id, kind: 'history', audience: AUTH_CHANNEL, grant: history },
  ];
}

export const socialWorkSharingFixture = defineFixture<StoredWorkSharing>({
  // The goal names the fixture `social-work-sharing` (docs/communication-plane-goal.md §3, §6); its judge greps for it.
  key: 'social-work-sharing',
  scenarios: {
    default: seed,
    empty: () => [],
  },
});
