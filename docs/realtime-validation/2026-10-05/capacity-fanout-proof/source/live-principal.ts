// Current socket/embedded authority comes from the directory. The signed
// identity fixes the source tenant, role, epoch and actor; a lookup may refresh
// grants, but must never silently select another identity or role.
import { AppError } from './async-handler.js';
import { isAllowed } from './authz.js';
import { currentDocumentSessionEpoch, documentSessionId } from './document-session.js';
import { getUser, type UserInfo } from '../providers/identity.js';
import { ADMIN_ROLE, DEFAULT_ROLE, DEFAULT_TENANT, DEMO_SUB, TENANTS, demoFallbackAllowed, demoScopedGrants, permissiveGrants, type Session, type Grants } from './session.js';
import { socialChat } from './social-chat.js';

export interface LiveGatewayAuth extends Record<string, unknown> {
  userId: string; displayName: string; org: string; role: string; tenants: string[];
  epoch: number; sessionIat: number;
}
export interface LiveGatewayPrincipal { session: Session; auth: LiveGatewayAuth }
type Context = Record<string, unknown> | null;

function epoch(value: unknown): number {
  const normalized = value === undefined ? 0 : value;
  if (!Number.isSafeInteger(normalized) || Number(normalized) < 0) throw new AppError(401, 'Invalid session provenance');
  return Number(normalized);
}
function provenance(session: Session): void {
  if (typeof session.sub !== 'string' || !session.sub || typeof session.role !== 'string' || !session.role
    || !TENANTS.includes(session.tenant) || !Number.isFinite(session.iat) || session.iat < 0) {
    throw new AppError(401, 'Invalid session provenance');
  }
  epoch(session.epoch);
  if (session.act) {
    if (typeof session.act.sub !== 'string' || !session.act.sub) throw new AppError(401, 'Invalid actor provenance');
    epoch(session.act.epoch);
  }
}
const detachedGrants = (grants: Grants): Grants => Object.fromEntries(Object.entries(grants)
  .map(([tenant, roles]) => [tenant, [...roles]]));
// The provider combines only reads queued before SQL dispatch. Sharing a
// query that already captured a snapshot would let a later action reuse
// pre-revocation authority while that older query is still outstanding.
function authoritativeUser(userId: string): Promise<UserInfo | null> {
  return getUser(userId, { authoritative: true }).then(user => user ? structuredClone(user) : null);
}

/** No directory outage or missing user falls back to a seed account. */
export async function currentLiveSession(session: Session): Promise<Session> {
  provenance(session);
  try {
    const demo = session.sub === DEMO_SUB && process.env['NODE_ENV'] !== 'production' && demoFallbackAllowed();
    if (demo) {
      if (await currentDocumentSessionEpoch(session.sub, session.tenant, documentSessionId(session)) === null) {
        throw new AppError(401, 'The session is no longer current. Sign in again.');
      }
      // The built-in demo directory excludes Social and Pipelines. Never use
      // token/cookie tenant claims to expand those fixed demo grants.
      const fixed = permissiveGrants();
      const initial = session.tenant === DEFAULT_TENANT && session.role === DEFAULT_ROLE
        && (session.grants.assessment?.length ?? 0) > 0;
      const grants = session.role === ADMIN_ROLE || initial ? fixed
        : demoScopedGrants(session.sub, session.tenant, session.role, fixed);
      return { ...session, grants, epoch: epoch(session.epoch) };
    }
    const [user, actor] = await Promise.all([
      authoritativeUser(session.sub),
      session.act ? authoritativeUser(session.act.sub) : Promise.resolve(null),
    ]);
    if (!user || user.epoch !== epoch(session.epoch) || !user.grants[session.tenant]?.includes(session.role)
      || (session.act && (!actor || actor.epoch !== epoch(session.act.epoch)
        || !Object.values(actor.grants).some(roles => roles.includes('admin'))))) {
      throw new AppError(401, 'The session is no longer current. Sign in again.');
    }
    return { ...session, name: user.displayName, grants: detachedGrants(user.grants), epoch: user.epoch };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'The identity store is unavailable');
  }
}

function socketSession(ctx: Context): Session {
  if (!ctx || typeof ctx.userId !== 'string' || typeof ctx.org !== 'string' || typeof ctx.role !== 'string') {
    throw new AppError(401, 'Unauthenticated');
  }
  const actor = ctx.act;
  if (actor !== undefined && (!actor || typeof actor !== 'object' || Array.isArray(actor))) {
    throw new AppError(401, 'Invalid actor provenance');
  }
  const act = actor as { sub?: unknown; epoch?: unknown } | undefined;
  // Only the fixed local demo uses signed tenant keys to distinguish its
  // initial browser persona from a deliberately narrowed selected persona.
  const fixedDemo = permissiveGrants();
  const demoGrants = ctx.userId === DEMO_SUB && Array.isArray(ctx.tenants)
    ? Object.fromEntries(Object.entries(fixedDemo).filter(([tenant]) => (ctx.tenants as unknown[]).includes(tenant))) : {};
  return {
    sub: ctx.userId, tenant: ctx.org as Session['tenant'], role: ctx.role as Session['role'],
    epoch: epoch(ctx.epoch), grants: demoGrants, iat: ctx.sessionIat === undefined ? 0 : Number(ctx.sessionIat),
    ...(act ? { act: { sub: act.sub as string, epoch: epoch(act.epoch), role: 'admin', tenant: 'orgiq', grants: {} } } : {}),
  };
}
export async function getLivePrincipal(ctx: Context): Promise<LiveGatewayPrincipal> {
  const session = await currentLiveSession(socketSession(ctx));
  return { session, auth: {
    ...ctx, userId: session.sub, displayName: session.name ?? session.sub, org: session.tenant, role: session.role,
    epoch: epoch(session.epoch), sessionIat: session.iat,
    tenants: Object.entries(session.grants).filter(([, roles]) => roles.length > 0).map(([tenant]) => tenant),
    ...(session.act ? { act: { sub: session.act.sub, epoch: epoch(session.act.epoch) } } : {}),
  } };
}

/** Evaluate the actual granted Social roles, keeping the source role intact. */
export async function currentSocialActionSession(session: Session, action: string): Promise<Session> {
  const current = await currentLiveSession(session);
  return socialActionSession(current, action);
}
async function socialActionSession(current: Session, action: string): Promise<Session> {
  const allowedRole = await socialActionRole(current, action);
  if (allowedRole === null) throw new AppError(403, 'Your Social grants do not allow this action');
  // A policy call can outlive directory revocation. Recheck provenance and
  // the exact role whose policy allowed the action after that await.
  const latest = await currentLiveSession(current);
  if (!latest.grants.social?.includes(allowedRole)) throw new AppError(403, 'Your Social grants do not allow this action');
  return latest;
}
async function socialActionRole(current: Session, action: string): Promise<string | null> {
  let allowedRole: string | null = null;
  for (const role of current.grants.social ?? []) {
    if (await isAllowed({ sub: current.sub, tenant: 'social', role }, action)) { allowedRole = role; break; }
  }
  return allowedRole;
}

/** Explicit conversation rows can close a DM/team even when its name admits it. */
export async function currentSocialMembership(channel: string, userId: string): Promise<boolean> {
  const proof = await currentSocialMembershipProof(channel, userId);
  try { return proof.allows(); } finally { proof.dispose(); }
}
export interface SocialMembershipProof { channel: string; allows: () => boolean; dispose: () => void }
export async function currentSocialMembershipProof(channel: string, userId: string): Promise<SocialMembershipProof> {
  const chat = socialChat(); await chat.ready;
  const observer = chat.membershipStore.observeChanges(channel);
  try {
    const rows = await chat.membershipStore.listMembers(channel);
    const allowed = rows.length === 0 || rows.some(row => row.userId === userId && row.removedAt == null);
    return { channel, allows: () => allowed && !observer.changed(), dispose: observer.dispose };
  } catch (error) { observer.dispose(); throw error; }
}

// Fan-out shares one durable read only while it is still queued. Recipients of
// one router pass call the authorizer in one synchronous map, but each used to
// await directory reads first and therefore reached the membership store in
// different ticks, each paying its own strongly consistent Query. Starting the
// proof before those awaits lets MirroredMembershipStore combine the reads that
// have not yet dispatched. The proof's change observer is registered at that
// earlier start, so the fence window only grows; the result is still gated by
// the fresh directory principal, policy and the final observer check.
function signedSubject(ctx: Context): string | null {
  return ctx && typeof ctx.userId === 'string' && ctx.userId ? ctx.userId : null;
}
function startSocialMembershipProof(channel: string, userId: string): Promise<SocialMembershipProof> {
  const proof = currentSocialMembershipProof(channel, userId);
  // Every early proof may be abandoned on a denial path; its rejection is
  // observed here and still reaches any caller that awaits it.
  proof.catch(() => undefined);
  return proof;
}
function releaseSocialMembershipProof(proof: Promise<SocialMembershipProof> | null): void {
  void proof?.then(settled => settled.dispose(), () => undefined);
}

export interface LiveChannelAuthorization {
  kind: 'subscribe' | 'publish'; clientId: string; channel: string; ctx: Context;
}
export interface LiveChannelGuards {
  baseChannel: (channel: string) => string;
  guard: (auth: LiveGatewayAuth, channel: string, kind: 'subscribe' | 'publish') => boolean;
}
/** Requires the async-aware public router; never pass to a boolean-only hook. */
export async function authorizeLiveGatewayChannel(args: LiveChannelAuthorization, guards: LiveChannelGuards): Promise<boolean> {
  let membership: SocialMembershipProof | null = null;
  let early: Promise<SocialMembershipProof> | null = null;
  try {
    const base = guards.baseChannel(args.channel);
    const signed = signedSubject(args.ctx);
    if (base.startsWith('social:') && signed) early = startSocialMembershipProof(base, signed);
    let principal = await getLivePrincipal(args.ctx);
    if (base.startsWith('social:')) {
      const allowedRole = await socialActionRole(principal.session, args.kind === 'subscribe' ? 'ViewSocial' : 'PostMessage');
      if (allowedRole === null) return false;
      // The proof answers for the signed subject; the directory must confirm
      // that exact subject is current before its answer can count.
      if (!early || principal.session.sub !== signed) return false;
      const pending = early; early = null;
      membership = await pending;
      if (!membership.allows()) return false;
      principal = await getLivePrincipal(args.ctx);
      if (!principal.session.grants.social?.includes(allowedRole) || !membership.allows()) return false;
    }
    // Existing namespace, DM, channel/team membership and distillation rules
    // still decide the resource, using only refreshed tenant grant keys.
    return guards.guard(principal.auth, args.channel, args.kind);
  } catch { return false; }
  finally { membership?.dispose(); releaseSocialMembershipProof(early); }
}

export interface LiveCallGuards {
  guard: (auth: LiveGatewayAuth, lobby: string) => boolean;
  /** Public call state resolves legacy accepted/status frames without a lobby. */
  getLobby: (callId: string) => Promise<string | null>;
}
/** Fresh action admission; recipient reads use their own ViewSocial policy. */
export async function authorizeLiveGatewayCall(ctx: Context, action: string, data: Record<string, unknown>, guards: LiveCallGuards): Promise<boolean> {
  return liveCallDecision(ctx, action, data, guards, false);
}
export async function authorizeLiveGatewayCallRecipient(ctx: Context, data: Record<string, unknown>, guards: LiveCallGuards): Promise<boolean> {
  return liveCallDecision(ctx, 'receive', data, guards, true);
}
async function liveCallDecision(ctx: Context, action: string, data: Record<string, unknown>, guards: LiveCallGuards, receiving: boolean): Promise<boolean> {
  let membership: SocialMembershipProof | null = null;
  const early: { current: { lobby: string; proof: Promise<SocialMembershipProof> } | null } = { current: null };
  try {
    let payload = data ?? {};
    const nested = payload.data;
    if (payload.callId == null && payload.lobbyName == null && nested && typeof nested === 'object' && !Array.isArray(nested)) {
      payload = { ...(nested as Record<string, unknown>), ...payload };
    }
    const explicit = typeof payload.lobbyName === 'string' && payload.lobbyName ? payload.lobbyName : null;
    const callId = typeof payload.callId === 'string' && payload.callId ? payload.callId : null;
    const signed = signedSubject(ctx);
    // Start the lobby lookup and, once the lobby is known, its membership
    // proof before the directory awaits, so every recipient socket of one
    // call frame joins the same not-yet-dispatched read (see above).
    const begin = (lobby: string | null): void => {
      if (!early.current && signed && lobby?.startsWith('social:')) early.current = { lobby, proof: startSocialMembershipProof(lobby, signed) };
    };
    begin(explicit);
    const lookup = callId ? guards.getLobby(callId) : Promise.resolve(null);
    lookup.then(stored => { if (!explicit) begin(stored); }, () => undefined);
    let principal = await getLivePrincipal(ctx);
    if (action === 'invite' && payload.callerId !== principal.session.sub) return false;
    const stored = await lookup;
    // A frame cannot rename an existing Social call into a less restricted
    // source lobby to bypass its current action or membership authority.
    if (stored && explicit && stored !== explicit) return false;
    const lobby = stored ?? explicit;
    if (receiving && !lobby) return false;
    let socialRole: string | null = null;
    if (lobby?.startsWith('social:')) {
      socialRole = await socialActionRole(principal.session, receiving ? 'ViewSocial' : 'StartCall');
      if (socialRole === null) return false;
      const started = early.current;
      if (!started || started.lobby !== lobby || principal.session.sub !== signed) return false;
      early.current = null;
      membership = await started.proof;
      if (!membership.allows()) return false;
    }
    // Both the public call lookup and policy/membership I/O may outlive a
    // source switch. The signed source role never changes during this check.
    principal = await getLivePrincipal(ctx);
    if (socialRole && !principal.session.grants.social?.includes(socialRole)) return false;
    return (!membership || membership.allows()) && (!lobby || guards.guard(principal.auth, lobby));
  } catch { return false; }
  finally {
    membership?.dispose();
    releaseSocialMembershipProof(early.current?.proof ?? null);
  }
}
