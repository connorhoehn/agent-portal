// The call history of a tenant's page huddles, as data (the page-huddle half of
// realtime-parity matrix item 8). The rows are Social's own: platform-api's
// per-person call log (`/api/calls/log`), read through the BFF's
// `GET /api/calls?lobby=` (one page's lobby) and `GET /api/calls/tenant` (the
// actor's calls across the active tenant). This file is the pure mapping from
// those rows to the library composites' props; no React, so it runs under
// `node --test`.
//
// A page lobby is the page's realtime family name (the library's `useCallBlock(channel, { bind })`):
// `orgiq:initiative:<id>`, `assessment:team:TEAM-<id>`, `assessment:doc:<id>`,
// `pipelines:run:<id>`.

import { formatDuration, type NameOf, type SocialCall } from '../pages/social/socialPlatform.ts';

export type PageCallRow = SocialCall;
export interface PageCallsResponse { source: string; /** Set when the call log service is down: `calls` is empty because it could not be read. */ unavailable?: string; lobby?: string; tenant?: string; calls: PageCallRow[]; counts: { total: number; missed: number } }

const LOBBY = /^(orgiq:initiative|assessment:team|assessment:doc|pipelines:run):(\S{1,200})$/;

/** Is this chat channel also a call lobby the BFF will list a history for? */
export function isPageCallLobby(channel: string | null | undefined): boolean {
  const m = channel ? LOBBY.exec(channel) : null;
  if (!m) return false;
  return m[1] !== 'assessment:team' || /^TEAM-[A-Za-z0-9-]{1,120}$/.test(m[2]!);
}

const KIND: Record<string, string> = {
  'orgiq:initiative': 'Initiative', 'assessment:team': 'Team', 'assessment:doc': 'Document', 'pipelines:run': 'Run',
};

/** What a lobby is and where its page lives, or null for a name that is no page lobby. */
export function lobbyContext(lobby: string): { kind: string; id: string; label: string; href: string } | null {
  const m = LOBBY.exec(lobby);
  if (!m || !isPageCallLobby(lobby)) return null;
  const [, family, id] = m as unknown as [string, string, string];
  const enc = encodeURIComponent(id);
  const href = family === 'orgiq:initiative' ? `/iq/projects/${enc}`
    : family === 'assessment:team' ? `/assessment/teams/${enc}`
    : family === 'assessment:doc' ? `/assessment/workspace?doc=${enc}`
    : `/pipelines/runs/${enc}`;
  return { kind: KIND[family]!, id, label: `${KIND[family]} ${id}`, href };
}

/** Everyone a row names, you first, then the caller, then the rest. */
export function rowPeople(row: PageCallRow, me: string, nameOf: NameOf): Array<{ userId: string; displayName: string; avatarUrl?: string }> {
  const ids = [...new Set([me, row.callerId, ...row.targetUserIds].filter(Boolean))];
  return ids.map((userId) => {
    const avatarUrl = row.avatars?.[userId];
    return { userId, displayName: userId === me ? 'You' : userId === row.callerId && row.callerName ? row.callerName : nameOf(userId), ...(avatarUrl ? { avatarUrl } : {}) };
  });
}

/** CallActivityCard props for one ended (or missed) call in a page's history. */
export function pageCallCard(row: PageCallRow, me: string, nameOf: NameOf) {
  const missedOutcome = row.outcome === 'missed' ? 'no-answer' as const
    : row.outcome === 'declined' ? 'declined' as const
    : row.outcome === 'cancelled' ? 'cancelled' as const : undefined;
  return {
    callId: row.callId,
    // A `joined` row's caller is only whoever reported it (a place is walked into, nobody rings), so "X started the call" would be false.
    ...(row.direction === 'joined' ? {} : { startedBy: row.callerId === me ? 'You' : (row.callerName || nameOf(row.callerId)) }),
    participants: rowPeople(row, me, nameOf),
    live: false,
    startedAt: row.startedAt,
    ...(row.durationMs ? { durationMs: row.durationMs } : {}),
    ...(missedOutcome ? { outcome: missedOutcome } : {}),
    audioOnly: row.audioOnly,
    lobbyName: row.lobbyName,
  };
}

export interface TenantCallEntry {
  id: string; who: string; direction: string; outcome: string; missed: boolean; startedAt: string; duration: string;
  lobbyName: string; href: string | null;
}

const OUTCOME: Record<PageCallRow['outcome'], string> = { ringing: 'Ringing', answered: 'Answered', missed: 'Missed', declined: 'Declined', cancelled: 'Cancelled' };

/** CallLogList rows for the tenant's Calls page: the context, then who was there. */
export function tenantCallEntries(rows: readonly PageCallRow[], me: string, nameOf: NameOf): TenantCallEntry[] {
  return rows.map((row) => {
    const context = lobbyContext(row.lobbyName);
    const others = rowPeople(row, me, nameOf).filter((p) => p.userId !== me).map((p) => p.displayName);
    return {
      id: `${row.callId}:${row.startedAt}`,
      who: `${context?.label ?? row.lobbyName}${others.length ? ` · ${others.join(', ')}` : ''}`,
      direction: row.direction === 'joined' ? 'Huddle' : row.direction === 'incoming' ? 'Incoming' : 'Outgoing',
      outcome: OUTCOME[row.outcome] ?? row.outcome,
      missed: row.outcome === 'missed' && row.direction === 'incoming',
      startedAt: row.startedAt,
      duration: formatDuration(row.durationMs),
      lobbyName: row.lobbyName,
      href: context?.href ?? null,
    };
  });
}

// ── The writer: a page huddle's attendance ──────────────────────────────────
// platform-api's `joined` is one person reporting THEIR OWN attendance and
// stores the targets it is given on the row it creates, so an early joiner would
// never name a later one. The shell therefore reports a page huddle's `joined`
// when the first peer is seen (or at the end, if nobody came), with the time the
// reporter really walked in and every peer seen by then; `ended` follows.

export interface PageHuddleTracker {
  callId: string; lobbyName: string; joinedAt: string; peers: Set<string>; reported: boolean;
}

export function startPageHuddleTracker(callId: string, lobbyName: string, now: Date = new Date()): PageHuddleTracker {
  return { callId, lobbyName, joinedAt: now.toISOString(), peers: new Set(), reported: false };
}

export interface PageHuddleLogBody {
  callId: string; action: 'joined' | 'ended'; callerId: string; callerName?: string; targetUserIds: string[]; lobbyName: string; at?: string;
}

/** The bodies to report for a tracker now: `joined` once it is worth reporting, `ended` when the call is over. Mutates `reported`. */
export function pageHuddleLogBodies(t: PageHuddleTracker, who: { selfId: string; selfName?: string }, ended: boolean, endedAt: Date = new Date()): PageHuddleLogBody[] {
  const base = { callId: t.callId, lobbyName: t.lobbyName, callerId: who.selfId, ...(who.selfName ? { callerName: who.selfName } : {}) };
  const out: PageHuddleLogBody[] = [];
  if (!t.reported && (t.peers.size > 0 || ended)) {
    out.push({ ...base, action: 'joined', targetUserIds: [...t.peers], at: t.joinedAt });
    t.reported = true;
  }
  // `ended` writes a row for everyone it names, so it names nobody: each person reports their own end.
  if (ended) out.push({ ...base, action: 'ended', targetUserIds: [], at: endedAt.toISOString() });
  return out;
}
