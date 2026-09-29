// The initiative call, as data (docs/social-calls-plan.md step 5). Pure — no
// React, no library — so node --test covers who is rung, who cannot be, and
// why the Start call button is off.
//
// An initiative's people are PERSON ids (owner + SMEs); a call rings USER
// ids (the realtime token's `sub`). GET /api/roster/users maps one to the
// other within the caller's tenant and names the persons with no linked user.

export interface InitiativeCallPerson { personId: string; name: string }
export interface RosterUser { personId: string; userId: string; displayName: string }
export interface CallTarget { userId: string; displayName: string }

export interface InitiativeCallTargets {
  /** Rung on Start call: owner + SMEs with a linked user, never yourself. */
  targets: CallTarget[];
  /** Owner/SMEs with no user in this tenant — named in the UI, not rung. */
  skipped: InitiativeCallPerson[];
}

/** The owner first, then SMEs; a person listed twice counts once. */
export function initiativeCallPeople(
  owner: InitiativeCallPerson | null,
  smes: InitiativeCallPerson[],
): InitiativeCallPerson[] {
  const seen = new Set<string>();
  const out: InitiativeCallPerson[] = [];
  for (const p of [...(owner ? [owner] : []), ...smes]) {
    if (!p.personId || seen.has(p.personId)) continue;
    seen.add(p.personId);
    out.push(p);
  }
  return out;
}

export function initiativeCallTargets(
  people: InitiativeCallPerson[],
  users: RosterUser[] | null,
  selfUserId: string | null,
): InitiativeCallTargets {
  if (!users) return { targets: [], skipped: [] };
  const byPerson = new Map(users.map((u) => [u.personId, u]));
  const targets: CallTarget[] = [];
  const skipped: InitiativeCallPerson[] = [];
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
export function skippedNotice(skipped: InitiativeCallPerson[]): string | null {
  if (skipped.length === 0) return null;
  const names = skipped.map((p) => p.name || p.personId);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list} ${names.length === 1 ? 'has' : 'have'} no OrgIQ sign-in in this workspace, so the call will not ring them.`;
}

export type CallAvailability = { ok: true } | { ok: false; reason: string };

export function initiativeCallAvailability(input: {
  gatewayConfigured: boolean;
  connectionState: string;
  platformApiUrl: string | null;
  signedIn: boolean;
  usersLoaded: boolean;
  targets: CallTarget[];
}): CallAvailability {
  if (!input.gatewayConfigured) return { ok: false, reason: 'Calls need the realtime gateway — VITE_GATEWAY_URL is not set' };
  if (!input.platformApiUrl) return { ok: false, reason: 'Calls need platform-api — set VITE_PLATFORM_API_URL (or PLATFORM_API_URL on the middleware)' };
  if (!input.signedIn) return { ok: false, reason: 'Sign in to start a call' };
  if (input.connectionState !== 'connected') return { ok: false, reason: 'Connecting to the realtime gateway…' };
  if (!input.usersLoaded) return { ok: false, reason: 'Finding who to call…' };
  if (input.targets.length === 0) return { ok: false, reason: 'Nobody else on this initiative has an OrgIQ sign-in to call' };
  return { ok: true };
}

/** Lobby names carry the tenant (`orgiq:dm:u-a:u-b`); dmLobbyName prepends this verbatim. */
export function lobbyPrefix(tenant: string): string {
  return `${tenant}:`;
}

// The invite carries `channel`; the initiative's id rides it so the incoming
// toast can open the initiative the call is about.
const CHANNEL_PREFIX = 'initiative:';
export function initiativeCallChannel(initiativeId: string): string {
  return `${CHANNEL_PREFIX}${initiativeId}`;
}
export function initiativeFromChannel(channel: string | null | undefined): string | null {
  if (!channel || !channel.startsWith(CHANNEL_PREFIX)) return null;
  return channel.slice(CHANNEL_PREFIX.length) || null;
}
