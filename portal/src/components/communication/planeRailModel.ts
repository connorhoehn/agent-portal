// The Communication plane's org-context rail sections, as data
// (docs/communication-plane-goal.md §1.3–§1.4): the host tenant's groups the
// signed-in user belongs to (My initiatives / My teams / My pipelines) and,
// in orgiq, the org-graph teams of the linked person (My org teams). No React,
// so `__tests__/planeRailModel.test.ts` runs under plain `node --test`.
//
// Nothing here decides authority. "Mine" is the server's (`app_users.person_id`,
// GET /api/me/groups?kind= — one shape for every kind, middleware lib/mine.ts); unread
// is the server's (GET /api/discussions/unread, re-gated per call); a group's
// bound Social channel is the server's (GET /api/social/bindings). This module
// only reads those payloads defensively and says what a row says under its
// name; the library rail model (`buildRailSection`) makes the rows, counts,
// filter and empty lines (CommunicationPlane.tsx `planeSections`).
//
// These live outside pages/social on purpose: the Social tenant's pages may not
// name another tenant's paths (validate-social-tenant.sh S0); the workspace
// receives these sections through its embedding slot.

export type PlaneTenant = 'orgiq' | 'assessment' | 'pipelines';
export type PlaneGroupKind = 'initiative' | 'team' | 'definition';

/** The conversation a group opens when it has no bound channel. */
export const GROUP_DISCUSSION_LABEL: Readonly<Record<PlaneGroupKind, string>> = {
  initiative: 'Initiative discussion', team: 'Team discussion', definition: 'Pipeline discussion',
};

/** One group the user belongs to in the host tenant. */
export interface PlaneGroup {
  kind: PlaneGroupKind;
  id: string;
  name: string;
}

/** The rail section's heading per host tenant. */
export const GROUP_SECTION_LABEL: Readonly<Record<PlaneTenant, string>> = {
  orgiq: 'My initiatives',
  assessment: 'My teams',
  pipelines: 'My pipelines',
};

/** The plural noun for the empty and error lines ("your initiatives"). */
export const GROUP_NOUN: Readonly<Record<PlaneTenant, string>> = {
  orgiq: 'initiatives', assessment: 'teams', pipelines: 'pipelines',
};

export const ORG_TEAMS_LABEL = 'My org teams';

export function planeTenant(tenant: string | null | undefined): PlaneTenant | null {
  return tenant === 'orgiq' || tenant === 'assessment' || tenant === 'pipelines' ? tenant : null;
}

/** The group kind each host tenant lists. */
export const GROUP_KIND: Readonly<Record<PlaneTenant, PlaneGroupKind>> = {
  orgiq: 'initiative', assessment: 'team', pipelines: 'definition',
};

/** The page discussion each group carries — the same chat family its own page uses (middleware lib/tenant-channels.ts). */
export function groupDiscussionChannel(group: Pick<PlaneGroup, 'kind' | 'id'>): string {
  switch (group.kind) {
    case 'initiative': return `orgiq:initiative:${group.id}`;
    case 'team': return `assessment:team:${group.id}`;
    case 'definition': return `pipelines:def:${group.id}`;
  }
}

/**
 * The `social_bindings` context a group binds under (routes/social.ts
 * BINDING_CONTEXT_TENANT): `initiative` for orgiq, `assessment-team` for an
 * assessment team, `pipeline` for a pipelines definition.
 */
export function groupBindingContext(group: Pick<PlaneGroup, 'kind' | 'id'>): string | null {
  switch (group.kind) {
    case 'initiative': return `initiative:${group.id}`;
    case 'team': return `assessment-team:${group.id}`;
    case 'definition': return `pipeline:${group.id}`;
  }
}

/** The group's own page in the host tenant ("Open page"). */
export function groupPageHref(group: Pick<PlaneGroup, 'kind' | 'id'>): string {
  const id = encodeURIComponent(group.id);
  switch (group.kind) {
    case 'initiative': return `/iq/projects/${id}`;
    case 'team': return `/assessment/teams/${id}`;
    case 'definition': return '/pipelines/definitions';
  }
}

/** The org team's binding context (`social_bindings.context_kind = 'team'`, orgiq). */
export const orgTeamBindingContext = (teamId: string): string => `team:${teamId}`;

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// ── GET /api/me/groups?kind= — the ONE "mine" shape (middleware lib/mine.ts) ──
//
//   { viewer: { userId, personId }, items: [{ kind, id, name, role, membership, counts?, members? }], limits: [] }
//
// One reader for every kind: the host tenant's groups (initiative / assessment-team / pipeline) and the org
// teams (org-team). `limits` carries the server's reason when a list is honestly empty (an unlinked account).

export type MineKind = 'initiative' | 'sprint' | 'org-team' | 'assessment-team' | 'pipeline';
export interface MineMember { userId: string | null; personId: string | null; name: string }
export interface MineItem { kind: MineKind; id: string; name: string; role: string | null; membership: string; counts: Record<string, number>; members: MineMember[] }
export interface MineReply { viewer: { userId: string; personId: string | null }; items: MineItem[]; limits: string[] }

/** The wire kind each host tenant's groups section reads. */
export const MINE_KIND: Readonly<Record<PlaneTenant, MineKind>> = { orgiq: 'initiative', assessment: 'assessment-team', pipelines: 'pipeline' };
export const mineGroupsUrl = (kind: MineKind): string => `/api/me/groups?kind=${kind}`;

const MINE_KINDS = new Set<string>(['initiative', 'sprint', 'org-team', 'assessment-team', 'pipeline']);

export function readMineGroups(raw: unknown): MineReply | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const viewer = r['viewer'] && typeof r['viewer'] === 'object' ? r['viewer'] as Record<string, unknown> : null;
  const userId = text(viewer?.['userId']);
  if (!userId || !Array.isArray(r['items'])) return null;
  const items = r['items'].flatMap((row): MineItem[] => {
    if (!row || typeof row !== 'object') return [];
    const it = row as Record<string, unknown>;
    const kind = text(it['kind']), id = text(it['id']), name = text(it['name']), membership = text(it['membership']);
    if (!kind || !MINE_KINDS.has(kind) || !id || !name || !membership || !ID.test(id)) return [];
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(it['counts'] && typeof it['counts'] === 'object' ? it['counts'] as Record<string, unknown> : {})) {
      if (typeof v === 'number' && Number.isFinite(v)) counts[k] = v;
    }
    const members = (Array.isArray(it['members']) ? it['members'] : []).flatMap((m): MineMember[] => {
      if (!m || typeof m !== 'object') return [];
      const mm = m as Record<string, unknown>;
      const memberName = text(mm['name']);
      return memberName ? [{ userId: text(mm['userId']), personId: text(mm['personId']), name: memberName }] : [];
    });
    return [{ kind: kind as MineKind, id, name, role: text(it['role']), membership, counts, members }];
  });
  return { viewer: { userId, personId: text(viewer?.['personId']) }, items, limits: Array.isArray(r['limits']) ? r['limits'].filter((l): l is string => typeof l === 'string') : [] };
}

/** The host tenant's groups section rows from the reply (its kind decides the row's family and binding context). */
export function mineGroups(reply: MineReply | null): PlaneGroup[] {
  if (!reply) return [];
  return reply.items.flatMap((it): PlaneGroup[] => {
    const kind: PlaneGroupKind | null = it.kind === 'initiative' ? 'initiative' : it.kind === 'assessment-team' ? 'team' : it.kind === 'pipeline' ? 'definition' : null;
    return kind ? [{ kind, id: it.id, name: it.name }] : [];
  });
}

/** GET /api/session/person → whether the account is linked to an org-graph person (null while unknown). */
export function readPersonLink(raw: unknown): { linked: boolean; personId: string | null } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['linked'] !== 'boolean') return null;
  return { linked: r['linked'], personId: text(r['personId']) };
}

/** The bound channel as the rail needs it (`ChannelBindingView.binding`, routes/social.ts). */
export interface GroupBinding {
  channel: string;
  slug: string | null;
  name: string;
}

export function readBinding(raw: unknown): { binding: GroupBinding | null; canManage: boolean; joined: boolean } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const b = r['binding'];
  let binding: GroupBinding | null = null;
  if (b && typeof b === 'object') {
    const row = b as Record<string, unknown>;
    const channel = text(row['channel']);
    if (channel) binding = { channel, slug: text(row['slug']), name: text(row['name']) ?? channel };
  }
  return { binding, canManage: r['canManage'] === true, joined: r['joined'] === true };
}

/** One row key, handed back verbatim by the library list's `onSelect`. */
export const GROUP_ROW_PREFIX = 'plane-group:';
export const groupRowKey = (group: Pick<PlaneGroup, 'kind' | 'id'>): string => `${GROUP_ROW_PREFIX}${group.kind}:${group.id}`;

/** `?group=<kind>:<id>` (and a row key) → the group it names, or null. */
export function parseGroupRef(value: string | null | undefined): { kind: PlaneGroupKind; id: string } | null {
  if (!value) return null;
  const bare = value.startsWith(GROUP_ROW_PREFIX) ? value.slice(GROUP_ROW_PREFIX.length) : value;
  const cut = bare.indexOf(':');
  if (cut <= 0) return null;
  const kind = bare.slice(0, cut), id = bare.slice(cut + 1);
  if (kind !== 'initiative' && kind !== 'team' && kind !== 'definition') return null;
  return ID.test(id) ? { kind, id } : null;
}
export const groupRef = (group: Pick<PlaneGroup, 'kind' | 'id'>): string => `${group.kind}:${group.id}`;

/** The server's unread count for a page discussion (GET /api/discussions/unread's threads). */
export function unreadFor(channel: string, threads: ReadonlyArray<{ channel: string; unreadCount: number }>): number {
  return threads.find((t) => t.channel === channel)?.unreadCount ?? 0;
}

export interface GroupRowFacts {
  binding?: GroupBinding | null;
  /** The binding read failed or has not answered; the fallback names the group's discussion. */
  bindingUnknown?: boolean;
}

/** What a group row says under its name: the bound channel, else that its page discussion opens here. */
export function groupRowPreview(group: PlaneGroup, facts: GroupRowFacts): string {
  if (facts.binding) return `#${facts.binding.slug ?? facts.binding.name}`;
  return GROUP_DISCUSSION_LABEL[group.kind];
}

// ── My org teams (orgiq) ────────────────────────────────────────────────────

export interface OrgTeamMember { personId: string; name: string; userId: string | null }
export interface OrgTeam { id: string; name: string; role: string | null; members: OrgTeamMember[] }
export interface OrgTeams { personId: string | null; teams: OrgTeam[] }

/** GET /api/me/groups?kind=org-team → the linked person's org-graph teams with their rosters (members resolved to users where linked). */
export function mineOrgTeams(reply: MineReply | null): OrgTeams | null {
  if (!reply) return null;
  const teams = reply.items.flatMap((it): OrgTeam[] => (it.kind === 'org-team' ? [{
    id: it.id, name: it.name, role: it.role,
    members: it.members.flatMap((m): OrgTeamMember[] => (m.personId ? [{ personId: m.personId, name: m.name, userId: m.userId }] : [])),
  }] : []));
  return { personId: reply.viewer.personId, teams };
}

export const ORG_TEAM_ROW_PREFIX = 'plane-org-team:';
export const orgTeamRowKey = (teamId: string): string => `${ORG_TEAM_ROW_PREFIX}${teamId}`;
export function orgTeamFromRow(key: string): string | null {
  return key.startsWith(ORG_TEAM_ROW_PREFIX) && key.length > ORG_TEAM_ROW_PREFIX.length ? key.slice(ORG_TEAM_ROW_PREFIX.length) : null;
}

/** Members who are online now, by their linked app user (presence knows users, not people). */
export function onlineMembers(team: OrgTeam, online: ReadonlySet<string>): number {
  return team.members.filter((m) => m.userId && online.has(m.userId)).length;
}

/** What an org team row says under its name: its bound channel (else its size), and who is online now. */
export function orgTeamRowPreview(team: OrgTeam, online: ReadonlySet<string>, binding: GroupBinding | null): string {
  const here = onlineMembers(team, online);
  const size = `${team.members.length} ${team.members.length === 1 ? 'member' : 'members'}`;
  return [binding ? `#${binding.slug ?? binding.name}` : size, here ? `${here} online` : ''].filter(Boolean).join(' · ');
}

/** The team view's people: everyone but the viewer, with presence where they are linked to an app user. */
export function orgTeamPeople(team: OrgTeam, here: ReadonlyArray<{ id: string; idle?: boolean }>, selfId: string) {
  const status = new Map(here.map((p) => [p.id, p.idle ? 'away' as const : 'online' as const]));
  const rank = { online: 0, away: 1, offline: 2 } as const;
  return team.members
    .filter((m) => m.userId !== selfId)
    .map((m) => ({
      userId: m.userId ?? `person:${m.personId}`, displayName: m.name,
      // The whole roster shows: someone not in the workspace now (or with no app account) is offline, not "online".
      status: (m.userId ? status.get(m.userId) : undefined) ?? 'offline' as const,
    }))
    .sort((a, b) => rank[a.status] - rank[b.status] || a.displayName.localeCompare(b.displayName));
}

/** Which plane view the content column shows, from the URL (`?group=`, `?orgTeam=`, `?person=`). */
export type PlaneView =
  | { kind: 'group'; group: { kind: PlaneGroupKind; id: string } }
  | { kind: 'org-team'; teamId: string }
  | { kind: 'person'; userId: string }
  | null;

const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
export function planeView(params: URLSearchParams): PlaneView {
  const group = parseGroupRef(params.get('group'));
  if (group) return { kind: 'group', group };
  const team = params.get('orgTeam');
  if (team && ID.test(team)) return { kind: 'org-team', teamId: team };
  const person = params.get('person');
  if (person && USER_ID.test(person)) return { kind: 'person', userId: person };
  return null;
}

/** The URL of a plane view under the page's base route. */
export function planeViewHref(base: string, view: Exclude<PlaneView, null>): string {
  const p = new URLSearchParams();
  if (view.kind === 'group') p.set('group', groupRef(view.group));
  else if (view.kind === 'org-team') p.set('orgTeam', view.teamId);
  else p.set('person', view.userId);
  return `${base}?${p}`;
}
