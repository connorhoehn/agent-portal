// Calling people from a page, as data (docs/social-calls-plan.md steps 5–6).
// Pure — no React, no library — so node --test covers who is rung, who cannot
// be, why Start call is off, and where an accepted ring opens.
//
// Pages know PERSON ids (an initiative's owner + SMEs, the people selected on
// Search); a call rings USER ids (the realtime token's `sub`). GET
// /api/roster/users maps one to the other within the caller's tenant and names
// the persons with no linked user. Started from an initiative
// (pages/projects/initiativeCallModel.ts) or from Search
// (pages/search/SearchComposer.tsx); the call itself lives in the /iq shell's
// host (pages/projects/InitiativeCallHost.tsx).

export interface CallPerson { personId: string; name: string }
export interface RosterUser { personId: string; userId: string; displayName: string }
export interface CallTarget { userId: string; displayName: string }

export interface CallTargets {
  /** Rung on Start call: people with a linked user, never yourself. */
  targets: CallTarget[];
  /** People with no user in this tenant — named in the UI, not rung. */
  skipped: CallPerson[];
}

/** People in order; a person listed twice (or with no id) counts once. */
export function uniquePeople(people: CallPerson[]): CallPerson[] {
  const seen = new Set<string>();
  const out: CallPerson[] = [];
  for (const p of people) {
    if (!p.personId || seen.has(p.personId)) continue;
    seen.add(p.personId);
    out.push(p);
  }
  return out;
}

export function callTargets(
  people: CallPerson[],
  users: RosterUser[] | null,
  selfUserId: string | null,
): CallTargets {
  if (!users) return { targets: [], skipped: [] };
  const byPerson = new Map(users.map((u) => [u.personId, u]));
  const targets: CallTarget[] = [];
  const skipped: CallPerson[] = [];
  const rung = new Set<string>();
  for (const p of people) {
    const u = byPerson.get(p.personId);
    if (!u) { skipped.push(p); continue; }
    if (u.userId === selfUserId || rung.has(u.userId)) continue;
    rung.add(u.userId);
    targets.push({ userId: u.userId, displayName: u.displayName || p.name });
  }
  return { targets, skipped };
}

/** "Maya Patel has no OrgIQ sign-in, so the call will not ring them." */
export function skippedNotice(skipped: CallPerson[]): string | null {
  if (skipped.length === 0) return null;
  const names = skipped.map((p) => p.name || p.personId);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list} ${names.length === 1 ? 'has' : 'have'} no OrgIQ sign-in in this workspace, so the call will not ring them.`;
}

export type CallAvailability = { ok: true } | { ok: false; reason: string };

export function callAvailability(input: {
  gatewayConfigured: boolean;
  connectionState: string;
  platformApiUrl: string | null;
  signedIn: boolean;
  usersLoaded: boolean;
  targets: CallTarget[];
  /** Why nobody can be rung, in the page's words. */
  nobodyReason?: string;
}): CallAvailability {
  if (!input.gatewayConfigured) return { ok: false, reason: 'Calls need the realtime gateway — the middleware returned no gatewayUrl and VITE_GATEWAY_URL is not set' };
  if (!input.platformApiUrl) return { ok: false, reason: 'Calls need platform-api — the middleware returned no platformApiUrl (REALTIME_PLATFORM_PUBLIC_URL) and VITE_PLATFORM_API_URL is not set' };
  if (!input.signedIn) return { ok: false, reason: 'Sign in to start a call' };
  if (input.connectionState !== 'connected') return { ok: false, reason: 'Connecting to the realtime gateway…' };
  if (!input.usersLoaded) return { ok: false, reason: 'Finding who to call…' };
  if (input.targets.length === 0) return { ok: false, reason: input.nobodyReason ?? 'Nobody here has an OrgIQ sign-in to call' };
  return { ok: true };
}

/** "Call Nora DaSilva" / "Call Nora DaSilva and Theo Ruiz" / "Call Nora DaSilva and 2 others". */
export function callLabel(targets: CallTarget[]): string {
  const names = targets.map((t) => t.displayName);
  if (names.length === 0) return 'Call';
  if (names.length === 1) return `Call ${names[0]}`;
  if (names.length === 2) return `Call ${names[0]} and ${names[1]}`;
  return `Call ${names[0]} and ${names.length - 1} others`;
}

/** Lobby names carry the tenant (`orgiq:dm:u-a:u-b`); dmLobbyName prepends this verbatim. */
export function lobbyPrefix(tenant: string): string {
  return `${tenant}:`;
}

// The invite carries `channel`: what the call is about, so the callee's
// Accept can open it. `initiative:<id>` opens the initiative;
// `search:<person ids>` opens Search's connections tab on those people.
const INITIATIVE = 'initiative:';
const SEARCH = 'search:';

export function initiativeCallChannel(initiativeId: string): string {
  return `${INITIATIVE}${initiativeId}`;
}
export function initiativeFromChannel(channel: string | null | undefined): string | null {
  if (!channel || !channel.startsWith(INITIATIVE)) return null;
  return channel.slice(INITIATIVE.length) || null;
}

/** The same people give the same channel, in any order. Null with nobody. */
export function searchCallChannel(personIds: string[]): string | null {
  const ids = [...new Set(personIds.filter(Boolean))].sort();
  return ids.length ? `${SEARCH}${ids.join(',')}` : null;
}
export function peopleFromSearchChannel(channel: string | null | undefined): string[] {
  if (!channel || !channel.startsWith(SEARCH)) return [];
  return channel.slice(SEARCH.length).split(',').filter(Boolean);
}

/** Where Accept takes the callee, or null to stay on the page they are on. */
export function callChannelHref(channel: string | null | undefined): string | null {
  const initiative = initiativeFromChannel(channel);
  if (initiative) return `/iq/projects/${encodeURIComponent(initiative)}`;
  const people = peopleFromSearchChannel(channel);
  if (people.length) {
    const q = new URLSearchParams({ tab: 'connections', selection: people.map((id) => `person:${id}`).join(',') });
    return `/iq/search?${q.toString()}`;
  }
  return null;
}

/**
 * The people in Search's selection (`person:<id>` record keys, from the URL)
 * and attached context, in that order, named from the records when known.
 */
export function peopleFromRecordKeys(
  keys: string[],
  records: { type: string; id: string; title: string }[],
): CallPerson[] {
  const names = new Map(records.filter((r) => r.type === 'person').map((r) => [r.id, r.title]));
  const ids = [
    ...keys.filter((k) => k.startsWith('person:')).map((k) => k.slice('person:'.length)),
    ...records.filter((r) => r.type === 'person').map((r) => r.id),
  ];
  return uniquePeople(ids.map((id) => ({ personId: id, name: names.get(id) ?? id })));
}
