// Current socket/embedded authority comes from the directory. The signed
// identity fixes the source tenant, role, epoch and actor; a lookup may refresh
// grants, but must never silently select another identity or role.
import { AppError } from './async-handler.js';
import { isAllowed } from './authz.js';
import { currentDocumentSessionEpoch, documentSessionId } from './document-session.js';
import { getUser, type UserInfo } from '../providers/identity.js';
import { ADMIN_ROLE, DEFAULT_ROLE, DEFAULT_TENANT, DEMO_SUB, TENANTS, demoFallbackAllowed, demoScopedGrants, permissiveGrants, type Session, type Grants } from './session.js';
import type { AuthorityScope } from '@connorhoehnslalom/realtime-modules/server';
import { socialChat } from './social-chat.js';
import { channelAuthorityFor, tenantChannelFamily, type ChannelAuthority } from './tenant-channels.js';

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
/**
 * Fresh membership for one check. With an active library `scope` (0.107: one
 * chat action or one fan-out) every check of that operation shares ONE durable
 * read per channel (MirroredMembershipStore.scopedMembers, key
 * `members:<channel>`). Fences, per check:
 *   - its own observer, registered before it asks, held until `dispose`;
 *   - the shared read's observer, registered before that read began and held
 *     until the scope closes. Once either fires the proof denies, and because
 *     the shared flag is sticky every remaining check of the operation on that
 *     channel denies too — a removal or peer hint mid-fan-out refuses the
 *     recipients still waiting. A closed scope is never consulted.
 */
export async function currentSocialMembershipProof(channel: string, userId: string, scope?: AuthorityScope): Promise<SocialMembershipProof> {
  const chat = socialChat(); await chat.ready;
  const observer = chat.membershipStore.observeChanges(channel);
  try {
    const shared = scope?.active ? chat.membershipStore.scopedMembers(channel, scope) : null;
    const read = shared ? await shared : null;
    const rows = read ? read.rows : await chat.membershipStore.listMembers(channel);
    const allowed = rows.length === 0 || rows.some(row => row.userId === userId && row.removedAt == null);
    return { channel, allows: () => allowed && !observer.changed() && !(read?.changed() ?? false), dispose: observer.dispose };
  } catch (error) { observer.dispose(); throw error; }
}

/** The active (signed) source tenant, or the cross-tenant admin — the same
 * rule as `requireTenant` — and a current grant in the family's tenant. */
function sessionMeets(session: Session, authority: ChannelAuthority): boolean {
  const granted = Object.entries(session.grants).some(([tenant, roles]) => tenant === authority.tenant && roles.length > 0);
  if (!authority.activeTenant) return granted || session.role === ADMIN_ROLE;
  return session.tenant === authority.tenant || session.role === ADMIN_ROLE;
}
/** Fresh per call: the policy decision is the REST route's own `isAllowed`. */
export async function holdsChannelAuthority(session: Session, authority: ChannelAuthority): Promise<boolean> {
  if (!sessionMeets(session, authority)) return false;
  if (!authority.action) return true;
  return isAllowed({ sub: session.sub, tenant: session.tenant, role: session.role }, authority.action);
}

export interface LiveChannelAuthorization {
  kind: 'subscribe' | 'publish'; clientId: string; channel: string; ctx: Context;
  /** The library operation this check belongs to (0.107). Shares only the
   * Social membership read; directory, actor and policy are asked per check. */
  scope?: AuthorityScope;
}
export interface LiveChannelGuards {
  baseChannel: (channel: string) => string;
  guard: (auth: LiveGatewayAuth, channel: string, kind: 'subscribe' | 'publish') => boolean;
}
/** Requires the async-aware public router; never pass to a boolean-only hook. */
export async function authorizeLiveGatewayChannel(args: LiveChannelAuthorization, guards: LiveChannelGuards): Promise<boolean> {
  let membership: SocialMembershipProof | null = null;
  try {
    let principal = await getLivePrincipal(args.ctx);
    const base = guards.baseChannel(args.channel);
    if (base.startsWith('social:')) {
      const allowedRole = await socialActionRole(principal.session, args.kind === 'subscribe' ? 'ViewSocial' : 'PostMessage');
      if (allowedRole === null) return false;
      membership = await currentSocialMembershipProof(base, principal.session.sub, args.scope);
      if (!membership.allows()) return false;
      principal = await getLivePrincipal(args.ctx);
      if (!principal.session.grants.social?.includes(allowedRole) || !membership.allows()) return false;
    }
    // A non-Social tenant family asks the same authority its REST read/write
    // route asks, against this freshly loaded session (lib/tenant-channels.ts).
    // A family the shape table refuses never reaches the policy call.
    const family = tenantChannelFamily(base);
    if (family) {
      const authority = channelAuthorityFor(family, args.channel, args.kind);
      if (!authority || !await holdsChannelAuthority(principal.session, authority)) return false;
      // The policy call can outlive a revocation: reload once more and decide
      // the shape with only the grants that are current after it.
      principal = await getLivePrincipal(args.ctx);
      if (!sessionMeets(principal.session, authority)) return false;
    }
    // Existing namespace, DM, channel/team membership and distillation rules
    // still decide the resource, using only refreshed tenant grant keys.
    return guards.guard(principal.auth, args.channel, args.kind);
  } catch { return false; }
  finally { membership?.dispose(); }
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
  try {
    let principal = await getLivePrincipal(ctx);
    let payload = data ?? {};
    const nested = payload.data;
    if (payload.callId == null && payload.lobbyName == null && nested && typeof nested === 'object' && !Array.isArray(nested)) {
      payload = { ...(nested as Record<string, unknown>), ...payload };
    }
    if (action === 'invite' && payload.callerId !== principal.session.sub) return false;
    const explicit = typeof payload.lobbyName === 'string' && payload.lobbyName ? payload.lobbyName : null;
    const callId = typeof payload.callId === 'string' && payload.callId ? payload.callId : null;
    const stored = callId ? await guards.getLobby(callId) : null;
    // A frame cannot rename an existing Social call into a less restricted
    // source lobby to bypass its current action or membership authority.
    if (stored && explicit && stored !== explicit) return false;
    const lobby = stored ?? explicit;
    if (receiving && !lobby) return false;
    let socialRole: string | null = null;
    if (lobby?.startsWith('social:')) {
      socialRole = await socialActionRole(principal.session, receiving ? 'ViewSocial' : 'StartCall');
      if (socialRole === null) return false;
      membership = await currentSocialMembershipProof(lobby, principal.session.sub);
      if (!membership.allows()) return false;
    }
    // A tenant family lobby (`orgiq:initiative:<id>`, `assessment:doc:<id>`)
    // asks its REST read authority for every action, ringing included.
    const family = lobby ? tenantChannelFamily(lobby) : null;
    if (family && (!family.lobby || !await holdsChannelAuthority(principal.session, family.read))) return false;
    // Both the public call lookup and policy/membership I/O may outlive a
    // source switch. The signed source role never changes during this check.
    principal = await getLivePrincipal(ctx);
    if (socialRole && !principal.session.grants.social?.includes(socialRole)) return false;
    if (family && !sessionMeets(principal.session, family.read)) return false;
    return (!membership || membership.allows()) && (!lobby || guards.guard(principal.auth, lobby));
  } catch { return false; }
  finally { membership?.dispose(); }
}
