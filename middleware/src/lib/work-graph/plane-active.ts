// Active-now enrichment for the Communication plane (docs/communication-plane-goal.md §1.2):
// for the people in the shell's presence roster, what THIS viewer may know
// about each — computed on the server from the same rows the Calls panes,
// the work graph and the sharing store serve the same viewer:
//
//   inCall       a live call (a call-log row answered and not ended) in a
//                lobby the viewer may read now: a Social conversation the
//                viewer belongs to, or a tenant page lobby under the lobby's
//                own authority (lib/gateway/authority.ts admitLobbyRead —
//                the family's read action, the page existing, the partition).
//                Anything else is null: the viewer is not told the person is
//                in a call they could not see.
//   activity     the person's latest work-graph node the VIEWER may read —
//                the person subject built under the viewer's own gates
//                (lib/work-graph/build.ts), so a title the viewer could not
//                open on /api/work-graph never appears here. A viewer not
//                standing in orgiq has no person graph to read: null.
//   workSharing  the sharing grants the viewer is an audience of (sharing.ts).
//   status       `busy` in a call the viewer can see, `online` otherwise —
//                presence itself stays the client's single subscription.

import type { Session } from '../session.js';
import { clock } from '../../mock/core/index.js';
import { listUsers } from '../../providers/identity.js';
import { getProject } from '../../providers/projects.js';
import { listCallRows, socialPlatformBackend, type SocialCallLogRow } from '../../providers/social-platform.js';
import { sessionGatewayContext } from '../live-principal.js';
import { tenantChannelFamily, TENANT_PARTITIONS } from '../tenant-channels.js';
import { buildViewerWorkGraph } from './build.js';
import { ownerSharingState, sharingViewerContext, todayQuery } from './shared-work.js';
import type { WorkGraphQuery } from './snapshot.js';

export interface ActivePersonView {
  userId: string;
  displayName: string;
  status: 'online' | 'busy';
  inCall: { callId: string; lobby: string; title: string | null; since: string } | null;
  activity: string | null;
  workSharing: { state: 'active' | 'historical'; fresh: boolean } | null;
}

export interface ActivePeople {
  observedAt: string;
  people: ActivePersonView[];
  counts: { people: number; inCall: number; sharing: number; withActivity: number };
  /** Why some fields could not be decided (for the record, not a reason to guess). */
  limits: string[];
}

const PEOPLE_CAP = 100;
const ACTIVITY_CAP = 25;
const isLive = (r: SocialCallLogRow) => r.outcome === 'answered' && !r.endedAt;

/**
 * Live call rows by person, from the VIEWER's own call log (providers/social-platform.ts
 * `listCallRows`: platform-api keeps a per-person log, and the mock answers the same
 * rows for the same viewer). Another person's live call is therefore known only
 * through a call the viewer is in — the row names its caller and targets — and
 * each such lobby is still asked for read authority before anyone is shown in it.
 * The rule is the same under every backend; the mock is not a second contract.
 */
async function liveCalls(viewer: Session, limits: string[]): Promise<Map<string, SocialCallLogRow>> {
  const out = new Map<string, SocialCallLogRow>();
  let rows: SocialCallLogRow[] = [];
  try {
    if (socialPlatformBackend() === 'none') { limits.push('no call log backend is configured; in-call state is unknown'); return out; }
    rows = (await listCallRows(viewer)).filter(isLive);
    limits.push('the call log is per person, so a live call is known only when the viewer is in it');
  } catch { limits.push('the call log could not be read; in-call state is unknown'); return out; }
  for (const row of rows) {
    for (const id of [row.userId, row.callerId, ...row.targetUserIds]) if (!out.has(id)) out.set(id, row);
  }
  return out;
}

/** The lobby's title as its page or conversation names it — only for a lobby the viewer may read. */
async function lobbyTitle(lobby: string, conversations: ReadonlyMap<string, string>): Promise<string | null> {
  const known = conversations.get(lobby);
  if (known) return known;
  const m = /^orgiq:initiative:(.+)$/.exec(lobby);
  if (m) { try { return (await getProject(m[1]!))?.name ?? null; } catch { return null; } }
  return null;
}

/** Text for the latest node of a person's day the viewer may read. */
export function activityText(node: { kind: string; title: string; status: string }): string {
  const t = node.title;
  switch (node.kind) {
    case 'document': return `Editing ${t}`;
    case 'run': return node.status === 'running' || node.status === 'waiting' ? `Running ${t}` : `Ran ${t}`;
    case 'meeting': return `In a huddle on ${t}`;
    case 'conversation': return `Discussing ${t}`;
    case 'change': return `Deciding ${t}`;
    case 'project': return `On ${t}`;
    case 'agent': return `Operating ${t}`;
    default: return `Working on ${t}`;
  }
}

export interface ActivePeopleOptions {
  /** Narrow to these user ids (the client's presence roster); everyone with a Social grant otherwise. */
  users?: readonly string[] | null;
  query?: WorkGraphQuery;
}

export async function buildActivePeople(viewer: Session, opts: ActivePeopleOptions = {}): Promise<ActivePeople> {
  const observedAt = clock.nowIso();
  const limits: string[] = [];
  const directory = await listUsers({ authoritative: true });
  const wanted = opts.users ? new Set(opts.users) : null;
  const roster = directory
    .filter(u => (u.grants['social']?.length ?? 0) > 0 && (!wanted || wanted.has(u.id)))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id))
    .slice(0, PEOPLE_CAP);

  // The viewer's conversations and teams (membership proven now) and the titles their rail shows for them.
  const context = await sharingViewerContext(viewer);
  const titles = context.titles;

  const calls = await liveCalls(viewer, limits);
  const lobbyVerdicts = new Map<string, boolean>();
  const canSeeLobby = async (lobby: string): Promise<boolean> => {
    const cached = lobbyVerdicts.get(lobby);
    if (cached !== undefined) return cached;
    let ok = false;
    if (lobby.startsWith('social:')) ok = context.conversationIds.has(lobby);
    else {
      const family = tenantChannelFamily(lobby);
      if (family?.lobby && TENANT_PARTITIONS.has(family.tenant) && (family.tenant === viewer.tenant || viewer.role === 'admin')) {
        try { const { admitLobbyRead } = await import('../gateway/authority.js'); ok = await admitLobbyRead(sessionGatewayContext(viewer), lobby) === 'ok'; }
        catch { ok = false; }
      }
    }
    lobbyVerdicts.set(lobby, ok);
    return ok;
  };

  const query = opts.query ?? todayQuery();
  const canReadPeople = viewer.tenant === 'orgiq' || viewer.role === 'admin';
  if (!canReadPeople) limits.push('activity is the orgiq work graph; a viewer standing elsewhere reads none of it');
  let activityBudget = ACTIVITY_CAP;

  const people: ActivePersonView[] = [];
  for (const u of roster) {
    let inCall: ActivePersonView['inCall'] = null;
    const call = calls.get(u.id);
    if (call && await canSeeLobby(call.lobbyName)) {
      inCall = { callId: call.callId, lobby: call.lobbyName, title: await lobbyTitle(call.lobbyName, titles), since: call.answeredAt ?? call.startedAt };
    }
    let activity: string | null = inCall ? `In a huddle${inCall.title ? ` on ${inCall.title}` : ''}` : null;
    if (!activity && canReadPeople && u.personId && activityBudget > 0) {
      activityBudget -= 1;
      try {
        const built = await buildViewerWorkGraph(viewer, { kind: 'person', id: u.personId }, query);
        const latest = built?.snapshot.nodes.filter(n => n.kind !== 'project').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
          ?? built?.snapshot.nodes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        if (latest) activity = activityText(latest);
      } catch (error) {
        // The viewer's own authority failing is the viewer's problem to hear about once, not a reason to show nothing silently.
        const status = (error as { status?: number })?.status;
        if (status !== 401 && status !== 403 && status !== 404) limits.push(`activity for ${u.id} could not be read`);
      }
    }
    // The one grant derivation (shared-work.ts ownerSharingState): the owner's own active grants, else the ones reaching this viewer.
    let workSharing: ActivePersonView['workSharing'] = null;
    try { workSharing = (await ownerSharingState(u.id, viewer, context, observedAt)).summary; }
    catch { limits.push('the sharing store could not be read'); }
    people.push({ userId: u.id, displayName: u.displayName, status: inCall ? 'busy' : 'online', inCall, activity, workSharing });
  }
  return {
    observedAt, people,
    counts: { people: people.length, inCall: people.filter(p => p.inCall).length, sharing: people.filter(p => p.workSharing).length, withActivity: people.filter(p => p.activity).length },
    limits: [...new Set(limits)],
  };
}
