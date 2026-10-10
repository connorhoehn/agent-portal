// The Communication plane's per-viewer people data, as the BFF sends it
// (docs/communication-plane-goal.md "Wire shapes (Lane A)"): Active now's
// enrichment (GET /api/social/plane/active) and a person's shared-work
// envelope (GET /api/social/plane/people/:userId/shared-work). Every field is
// already filtered for this viewer on the server; this module only reads it
// defensively and maps it onto the library's shapes. No React, so
// `__tests__/planeSharingModel.test.ts` runs under plain `node --test`.

export interface PlaneActiveCall { callId: string; lobby: string; title: string | null }
export interface PlaneActivePerson {
  userId: string;
  status: 'online' | 'busy' | null;
  inCall: PlaneActiveCall | null;
  activity: string | null;
  workSharing: { state: 'active' | 'historical'; fresh: boolean } | null;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);

export function readPlaneActive(raw: unknown): Map<string, PlaneActivePerson> {
  const out = new Map<string, PlaneActivePerson>();
  const people = obj(raw)?.['people'];
  if (!Array.isArray(people)) return out;
  for (const row of people) {
    const r = obj(row);
    const userId = text(r?.['userId']);
    if (!r || !userId) continue;
    const call = obj(r['inCall']);
    const callId = text(call?.['callId']), lobby = text(call?.['lobby']);
    const sharing = obj(r['workSharing']);
    const state = sharing?.['state'];
    out.set(userId, {
      userId,
      status: r['status'] === 'busy' || r['status'] === 'online' ? r['status'] : null,
      inCall: callId && lobby ? { callId, lobby, title: text(call?.['title']) } : null,
      activity: text(r['activity']),
      workSharing: state === 'active' || state === 'historical' ? { state, fresh: sharing?.['fresh'] === true } : null,
    });
  }
  return out;
}

/** The roster ids the Active now read narrows to (`?users=`, ≤200), sorted so the URL is stable. */
export function activeQuery(ids: readonly string[]): string | null {
  const list = [...new Set(ids.filter((id) => /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(id)))].sort().slice(0, 200);
  return list.length ? `?users=${encodeURIComponent(list.join(','))}` : null;
}

/** A presence tile enriched for the library `ActivePerson`: presence decides online/away, a visible call makes it busy. */
export function enrichActive<T extends { userId: string; displayName: string; status: 'online' | 'away' }>(people: readonly T[], active: ReadonlyMap<string, PlaneActivePerson>) {
  return people.map((p) => {
    const a = active.get(p.userId);
    if (!a) return { ...p };
    return {
      ...p,
      ...(a.inCall ? { status: 'busy' as const, inCall: true } : {}),
      ...(a.activity ? { activity: a.activity } : {}),
      ...(a.workSharing ? { workSharing: a.workSharing } : {}),
    };
  });
}

/** Lobbies with a live call this viewer may see (the rail's live dots). */
export function liveLobbies(active: ReadonlyMap<string, PlaneActivePerson>): Set<string> {
  return new Set([...active.values()].flatMap((a) => (a.inCall ? [a.inCall.lobby] : [])));
}

// ── Shared work ──────────────────────────────────────────────────────────────

export interface SharingGrant {
  id: string;
  state: string;
  kind: string | null;
  audience: { kind: 'conversation' | 'team'; id: string } | null;
  nodeIds: string[];
  revision: number;
  updatedAt: string | null;
  expiresAt: string | null;
}
export interface SharingEnvelope {
  viewer: 'owner' | 'audience' | 'none';
  provenance: Record<string, 'active' | 'historical' | 'referenced'>;
  grants: SharingGrant[];
  referencedIn: string[];
}

export function readSharing(raw: unknown): SharingEnvelope | null {
  const s = obj(raw);
  if (!s) return null;
  const viewer = s['viewer'] === 'owner' || s['viewer'] === 'audience' || s['viewer'] === 'none' ? s['viewer'] : null;
  if (!viewer) return null;
  const provenance: SharingEnvelope['provenance'] = {};
  for (const [k, v] of Object.entries(obj(s['provenance']) ?? {})) {
    if (v === 'active' || v === 'historical' || v === 'referenced') provenance[k] = v;
  }
  const grants = (Array.isArray(s['grants']) ? s['grants'] : []).flatMap((g): SharingGrant[] => {
    const r = obj(g); const id = text(r?.['id']);
    if (!r || !id) return [];
    const aud = obj(r['audience']);
    const audKind = aud?.['kind'], audId = text(aud?.['id']);
    return [{
      id, state: text(r['state']) ?? 'unknown', kind: text(r['kind']),
      audience: (audKind === 'conversation' || audKind === 'team') && audId ? { kind: audKind, id: audId } : null,
      nodeIds: Array.isArray(r['nodeIds']) ? r['nodeIds'].filter((n): n is string => typeof n === 'string') : [],
      revision: typeof r['revision'] === 'number' ? r['revision'] : 0,
      updatedAt: text(r['updatedAt']), expiresAt: text(r['expiresAt']),
    }];
  });
  const referencedIn = Array.isArray(s['referencedIn']) ? s['referencedIn'].filter((c): c is string => typeof c === 'string') : [];
  return { viewer, provenance, grants, referencedIn };
}

/** The work-graph snapshot inside the shared-work envelope (the library `WorkGraph` renders it unchanged). */
export function sharedWorkSnapshot(raw: unknown): unknown {
  return obj(raw)?.['snapshot'] ?? raw;
}

/** The owner's grants that can still be stopped (revoke). */
export const stoppableGrants = (env: SharingEnvelope | null): SharingGrant[] =>
  env?.viewer === 'owner' ? env.grants.filter((g) => g.state === 'active' || g.state === 'paused') : [];
