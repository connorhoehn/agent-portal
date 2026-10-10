// The ONE "mine" reader (docs/audit/2026-10-07-audit-plan.md D4).
//
// Five routes used to answer "the groups the signed-in user belongs to" in five
// shapes — a bare project array, `{scope, personId, canSeeAll, sprints}`,
// `{personId, teams}`, `{userId, personId, teams}` and `{userId, definitions}`
// — with four membership rules, one of which matched assessment teams by
// DISPLAY NAME. This module is the contract every one of them now implements:
//
//   MineReply { viewer: { userId, personId }, items: MineItem[], limits: string[] }
//   MineItem  { kind, id, name, role, membership, counts?, members? }
//
// `viewer` is resolved ONCE from the session's directory row (`app_users.person_id`
// for the org graph), never from a query or body. An account with no linked
// person gets an honest empty list and a `limits` line naming the fix, not a
// guess. Each kind's membership source is a real link:
//
//   initiative       projects.owner_id / project_contributions (providers/projects.ts)
//   sprint           the sprints of those initiatives, keyed on the person (providers/sprints.ts)
//   org-team         team_memberships (providers/org-teams.ts)
//   assessment-team  assessment_team_members (providers/assessment-team-members.ts) — a row, never a name
//   pipeline         a definition's owner (a bot's creator) or the last recorder of its stored version
//                    (providers/pipeline-definitions.ts sources, lib/pipeline-definitions.ts derivation)
//
// Served by GET /api/me/groups?kind= (routes/me-groups.ts); the two list routes
// a page still reads in their old shape (/api/graph/projects?scope=mine,
// /api/sprints?scope=mine) resolve their viewer through `mineViewer` so the two
// never disagree about whose work is whose.

import { AppError } from './async-handler.js';
import type { Session, Tenant } from './session.js';
import { getUser, listUsers } from '../providers/identity.js';
import { listInitiativeMemberships } from '../providers/projects.js';
import { listSprints } from '../providers/sprints.js';
import { listTeamsForPerson } from '../providers/org-teams.js';
import { listAssessmentTeamMemberships, listAssessmentTeamRosters } from '../providers/assessment-team-members.js';
import { loadDefinitionSources } from '../providers/pipeline-definitions.js';
import { deriveDefinitions } from './pipeline-definitions.js';
import { config } from '../config.js';
import * as M from '../mock/assessment.js';
import * as A from '../providers/assessment-aurora.js';

export const MINE_KINDS = ['initiative', 'sprint', 'org-team', 'assessment-team', 'pipeline'] as const;
export type MineKind = (typeof MINE_KINDS)[number];
export const isMineKind = (value: unknown): value is MineKind => typeof value === 'string' && (MINE_KINDS as readonly string[]).includes(value);

/** The tenant whose data each kind is — the route refuses a session standing elsewhere (admin passes, as `requireTenant`). */
export const MINE_KIND_TENANT: Readonly<Record<MineKind, Tenant>> = {
  initiative: 'orgiq', sprint: 'orgiq', 'org-team': 'orgiq', 'assessment-team': 'assessment', pipeline: 'pipelines',
};
/** The tenant's read action a kind additionally asks (the host route's own gate); none for the org graph's tenant-open reads. */
export const MINE_KIND_ACTION: Readonly<Record<MineKind, string | null>> = {
  initiative: null, sprint: null, 'org-team': null, 'assessment-team': 'ViewAssessment', pipeline: 'ViewPipelines',
};

export type MineMembership = 'owner' | 'contributor' | 'lead' | 'member' | 'editor';
export interface MineMember { userId: string | null; personId: string | null; name: string }
export interface MineItem {
  kind: MineKind;
  id: string;
  name: string;
  /** The person's title or contribution role as the source names it; null when the source has none. */
  role: string | null;
  membership: MineMembership;
  counts?: Record<string, number>;
  /** The group's roster where the source carries one (org teams, assessment teams), app users resolved where linked. */
  members?: MineMember[];
}
export interface MineViewer { userId: string; personId: string | null }
export interface MineReply { viewer: MineViewer; items: MineItem[]; limits: string[] }

export interface MineReader {
  kind: MineKind;
  /** Reads with the viewer the route resolved; never with anything from the request. */
  read(viewer: MineViewer): Promise<{ items: MineItem[]; limits?: string[] }>;
}

export const UNLINKED_LIMIT = 'Link your account to a person to see your groups (an admin links it at /admin/identity/users)';
const MEMBER_CAP = 200;

/** The session's viewer: its user id and the directory's person link. A directory outage is 503, an unknown user is unlinked. */
export async function mineViewer(session: Session): Promise<MineViewer> {
  let user;
  try { user = await getUser(session.sub); }
  catch { throw new AppError(503, 'The identity store is unavailable'); }
  return { userId: session.sub, personId: user?.personId ?? null };
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

const initiativeReader: MineReader = {
  kind: 'initiative',
  async read(viewer) {
    if (!viewer.personId) return { items: [], limits: [UNLINKED_LIMIT] };
    const rows = await listInitiativeMemberships(viewer.personId);
    return { items: rows.map((r) => ({ kind: 'initiative' as const, id: r.id, name: r.name, role: r.role, membership: r.membership })) };
  },
};

const sprintReader: MineReader = {
  kind: 'sprint',
  async read(viewer) {
    if (!viewer.personId) return { items: [], limits: [UNLINKED_LIMIT] };
    const rows = await listSprints({ personId: viewer.personId, mineOnly: true, limit: 100 });
    return {
      items: rows.map((s) => ({
        kind: 'sprint' as const, id: s.id, name: s.name, role: s.isSteward ? 'steward' : s.isGrantee ? 'grantee' : null,
        membership: s.isSteward ? 'owner' as const : s.isGrantee ? 'contributor' as const : 'member' as const,
        counts: { items: s.itemCount, mine: s.myItemCount, openMine: s.myOpenItemCount },
      })),
    };
  },
};

const orgTeamReader: MineReader = {
  kind: 'org-team',
  async read(viewer) {
    if (!viewer.personId) return { items: [], limits: [UNLINKED_LIMIT] };
    const teams = await listTeamsForPerson(viewer.personId);
    return {
      items: teams.map((t) => ({
        kind: 'org-team' as const, id: t.id, name: t.name, role: t.role, membership: 'member' as const,
        counts: { members: t.members.length },
        members: t.members.slice(0, MEMBER_CAP).map((m) => ({ userId: m.userId, personId: m.personId, name: m.name })),
      })),
    };
  },
};

const assessmentTeamReader: MineReader = {
  kind: 'assessment-team',
  async read(viewer) {
    let memberships;
    try { memberships = await listAssessmentTeamMemberships(viewer.userId); }
    catch { throw new AppError(503, 'The assessment teams are unavailable'); }
    const limits = memberships.limit ? [memberships.limit] : [];
    if (!memberships.rows.length) return { items: [], limits };
    let teams: Array<{ id: string; name: string }>;
    let rosters; let users;
    try {
      teams = config.mock.aurora ? M.teams() : await A.fetchAllTeams();
      rosters = await listAssessmentTeamRosters(memberships.rows.map((m) => m.teamId));
      users = new Map((await listUsers()).map((u) => [u.id, u]));
    } catch { throw new AppError(503, 'The assessment teams are unavailable'); }
    const names = new Map(teams.map((t) => [t.id, t.name]));
    const items = memberships.rows.flatMap((m): MineItem[] => {
      const name = names.get(m.teamId);
      if (!name) return []; // a membership row for a team that no longer exists is nothing to show
      const roster = rosters.get(m.teamId) ?? [];
      return [{
        kind: 'assessment-team', id: m.teamId, name, role: null, membership: m.role,
        counts: { members: roster.length },
        members: roster.slice(0, MEMBER_CAP).map((r) => {
          const u = users.get(r.userId);
          return { userId: r.userId, personId: u?.personId ?? null, name: u?.displayName ?? r.userId };
        }),
      }];
    }).sort(byName);
    return { items, limits };
  },
};

const pipelineReader: MineReader = {
  kind: 'pipeline',
  async read(viewer) {
    let sources;
    try { ({ sources } = await loadDefinitionSources()); }
    catch { throw new AppError(503, 'The pipeline definitions are unavailable'); }
    // `owner` is a user id for a bot (its creator) and an agent/command name elsewhere; a recorded version names `updatedBy`.
    const editedBy = new Set(sources.stored.filter((s) => s.updatedBy === viewer.userId).map((s) => s.id));
    const items = deriveDefinitions(sources).flatMap((d): MineItem[] => {
      const membership = d.owner === viewer.userId ? 'owner' as const : editedBy.has(d.id) ? 'editor' as const : null;
      return membership ? [{ kind: 'pipeline', id: d.id, name: d.title, role: d.orphaned ? 'orphaned' : d.enabled ? 'active' : 'paused', membership }] : [];
    }).sort(byName);
    return { items };
  },
};

const READERS: Readonly<Record<MineKind, MineReader>> = {
  initiative: initiativeReader, sprint: sprintReader, 'org-team': orgTeamReader, 'assessment-team': assessmentTeamReader, pipeline: pipelineReader,
};

/** The one reply shape for any kind, with the viewer resolved once from the session. */
export async function readMine(session: Session, kind: MineKind): Promise<MineReply> {
  const viewer = await mineViewer(session);
  const { items, limits = [] } = await READERS[kind].read(viewer);
  return { viewer, items, limits };
}
