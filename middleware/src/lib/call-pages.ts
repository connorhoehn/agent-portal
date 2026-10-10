// Pinned initiative/work references are application state, separate from media
// screen sharing. The existing authenticated call roster is the audience.
import { emitSocialWorkGraphEvent, observeCall, observeCallEnded, observedCall, socialConversationOrNull } from './work-graph/social-events.js';
import type { ActiveCallStateView, CallStateStore } from '@connorhoehnslalom/realtime-modules/call';
import type { RealtimeRouter } from '@connorhoehnslalom/realtime-modules/server';
import { AppError } from './async-handler.js';
import { currentCallAuthority, resolveConnectedCallSession, callProvenance as provenance, type CallAuthority } from './call-access.js';
import { getProject } from '../providers/projects.js';
import { getWorkItem } from '../providers/work-items.js';
import type { Session } from './session.js';

export interface CallPageDescriptor { kind: 'initiative' | 'work-item'; id: string }
export interface CallPageLink { title: string; href: string }
export interface CanonicalCallPage extends CallPageDescriptor {
  key?: string;
  title: string;
  href: string;
  project: { id: string; title: string; href: string };
  breadcrumbs: CallPageLink[];
}
export interface SharedCallPage extends CanonicalCallPage {
  presenter: { userId: string; displayName: string };
  sharedAt: string;
}
export interface CallPageSnapshot {
  type: 'call-page';
  callId: string;
  revision: number;
  page: SharedCallPage | null;
}
export interface StoredCallPage {
  revision: number;
  page: (CallPageDescriptor & { presenter: SharedCallPage['presenter']; sharedAt: string; provenance: string }) | null;
  /** Proven by the first authenticated registration, never call payloads. */
  caller?: { userId: string; provenance: string };
}
export interface CallPageStore {
  get(callId: string): Promise<StoredCallPage>;
  claimCaller(callId: string, caller: NonNullable<StoredCallPage['caller']>): Promise<StoredCallPage>;
  compareAndSet(callId: string, expectedRevision: number, page: StoredCallPage['page']): Promise<{ applied: boolean; state: StoredCallPage }>;
  forget(callId: string): Promise<void>;
}

const empty = (): StoredCallPage => ({ revision: 0, page: null });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class MemoryCallPageStore implements CallPageStore {
  private readonly pages = new Map<string, StoredCallPage>();
  async get(callId: string): Promise<StoredCallPage> { return copy(this.pages.get(callId) ?? empty()); }
  async claimCaller(callId: string, caller: NonNullable<StoredCallPage['caller']>): Promise<StoredCallPage> {
    const current = this.pages.get(callId) ?? empty();
    if (current.caller) return copy(current);
    const state = { ...current, caller: copy(caller) };
    this.pages.set(callId, state);
    return copy(state);
  }
  async compareAndSet(callId: string, expectedRevision: number, page: StoredCallPage['page']) {
    const current = this.pages.get(callId) ?? empty();
    if (current.revision !== expectedRevision) return { applied: false, state: copy(current) };
    const state = { ...current, revision: current.revision + 1, page: copy(page) };
    this.pages.set(callId, state);
    return { applied: true, state: copy(state) };
  }
  async forget(callId: string): Promise<void> { this.pages.delete(callId); }
}

export interface CallPageRedis { command(...args: (string | number)[]): Promise<unknown> }
// The entire compare/write is atomic. Clears retain their revision while the
// call is live; the expiry bounds leftovers after an abrupt process loss.
const PAGE_CAS = `
local current = redis.call('GET', KEYS[1])
local existing = {revision=0,page=cjson.null}
if current then existing = cjson.decode(current) end
local revision = existing.revision
if revision ~= tonumber(ARGV[1]) then return {0, current or '{"revision":0,"page":null}'} end
local state = cjson.encode({revision=revision+1,page=cjson.decode(ARGV[2]),caller=existing.caller})
redis.call('SET', KEYS[1], state, 'EX', ARGV[3])
return {1, state}
`;
const PAGE_READ = `
local value = redis.call('GET', KEYS[1])
if value then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return value
`;
const CALLER_CLAIM = `
local current = redis.call('GET', KEYS[1])
local state = {revision=0,page=cjson.null}
if current then state = cjson.decode(current) end
if not state.caller then state.caller = cjson.decode(ARGV[1]) end
local encoded = cjson.encode(state)
redis.call('SET', KEYS[1], encoded, 'EX', ARGV[2])
return encoded
`;
export class RedisCallPageStore implements CallPageStore {
  constructor(private readonly redis: CallPageRedis, private readonly ttlSeconds = 4 * 60 * 60) {}
  private key(callId: string): string { return `orgiq:call-page:${encodeURIComponent(callId)}`; }
  async get(callId: string): Promise<StoredCallPage> {
    const value = await this.redis.command('EVAL', PAGE_READ, 1, this.key(callId), this.ttlSeconds);
    if (value === null) return empty();
    // Null tombstones must live as long as the active call too; expiring one
    // would rewind revisions and permanently strand an existing client.
    return JSON.parse(String(value)) as StoredCallPage;
  }
  async claimCaller(callId: string, caller: NonNullable<StoredCallPage['caller']>): Promise<StoredCallPage> {
    const value = await this.redis.command('EVAL', CALLER_CLAIM, 1, this.key(callId), JSON.stringify(caller), this.ttlSeconds);
    return JSON.parse(String(value)) as StoredCallPage;
  }
  async compareAndSet(callId: string, expectedRevision: number, page: StoredCallPage['page']) {
    const result = await this.redis.command('EVAL', PAGE_CAS, 1, this.key(callId), expectedRevision, JSON.stringify(page), this.ttlSeconds) as [number, string];
    return { applied: Number(result[0]) === 1, state: JSON.parse(result[1]) as StoredCallPage };
  }
  async forget(callId: string): Promise<void> { await this.redis.command('DEL', this.key(callId)); }
}

export class CallPageConflict extends AppError {
  constructor(public readonly snapshot: CallPageSnapshot) { super(409, 'Shared page changed'); }
}

/** Matches the tenant-open graph read routes; no client titles or URLs. */
export async function canonicalCallPage(descriptor: CallPageDescriptor): Promise<CanonicalCallPage> {
  const item = descriptor.kind === 'work-item' ? await getWorkItem(descriptor.id) : null;
  if (descriptor.kind === 'work-item' && !item) throw new AppError(404, 'Work item not found');
  const project = await getProject(item?.projectId ?? descriptor.id);
  if (!project) throw new AppError(404, 'Initiative not found');
  const projectHref = `/iq/projects/${encodeURIComponent(project.id)}`;
  const href = item ? `${projectHref}?${new URLSearchParams({ tab: 'work', item: item.id })}` : projectHref;
  const title = item?.title ?? project.name;
  return {
    kind: descriptor.kind, id: descriptor.id, ...(item?.key ? { key: item.key } : {}), title, href, project: { id: project.id, title: project.name, href: projectHref },
    breadcrumbs: [
      { title: 'Initiatives', href: '/iq/projects' },
      { title: project.name, href: projectHref }, ...(item ? [{ title: item.key ?? item.title, href }] : []),
    ],
  };
}

export type CallPageAuthority = CallAuthority;
export const currentCallPageAuthority = currentCallAuthority;

export interface CallPageRuntimeOptions {
  calls: CallStateStore;
  pages: CallPageStore;
  router: RealtimeRouter;
  lobbyAllowed: (auth: Record<string, unknown>, lobby: string) => boolean;
  canonical?: typeof canonicalCallPage;
  authority?: typeof currentCallPageAuthority;
  presenterGraceMs?: number;
  /** Zero disables periodic TTL/presenter checks in focused tests. */
  maintenanceIntervalMs?: number;
}

/** Additive public recovery seams introduced by realtime-modules 0.100.2.
 * Optional here so the host remains compatible with the installed 0.100.1
 * while its replacement is validated and pinned. */
export interface RecoverableCallStateStore extends CallStateStore {
  resumeParticipant?(callId: string, clientId: string, authenticatedUserId: string, lobbyName: string, departedClientIds?: string[]): Promise<boolean>;
  forgetCallIfUnchanged?(callId: string, expected: ActiveCallStateView): Promise<boolean>;
}
/** Application features may observe the same authoritative public mutations. */
export interface CallLifecycleObserver {
  invalidate(callId: string, clientId?: string): void;
  registered(callId: string, clientId: string, preserveHistory?: boolean): Promise<void>;
  removed(callId: string, clientId: string): Promise<void>;
  restored(callId: string, call: ActiveCallStateView): Promise<void>;
  finish(callId: string, participantClientIds?: string[]): Promise<void>;
}

export class CallPageRuntime {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly ended = new Map<string, number>();
  private readonly absence = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly tracked = new Set<string>();
  private readonly maintenance: ReturnType<typeof setInterval> | null;
  private disposed = false;
  constructor(private readonly opts: CallPageRuntimeOptions) {
    const interval = opts.maintenanceIntervalMs ?? 60_000;
    this.maintenance = interval > 0 ? setInterval(() => {
      for (const id of this.tracked) void this.checkPresenter(id).catch(() => undefined);
    }, interval) : null;
    this.maintenance?.unref?.();
  }
  private hasEnded(callId: string): boolean {
    const until = this.ended.get(callId);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    this.ended.delete(callId);
    return false;
  }
  private canonical = (page: CallPageDescriptor) => (this.opts.canonical ?? canonicalCallPage)(page);
  private authority = (session: Session) => (this.opts.authority ?? currentCallPageAuthority)(session);
  private enqueue<T>(callId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(callId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.queues.set(callId, next);
    void next.finally(() => { if (this.queues.get(callId) === next) this.queues.delete(callId); }).catch(() => undefined);
    return next;
  }
  private async liveCall(callId: string): Promise<ActiveCallStateView> {
    if (this.disposed || this.hasEnded(callId)) throw new AppError(404, 'Call is no longer active');
    const call = await this.opts.calls.getCall(callId);
    if (!call || this.disposed || this.hasEnded(callId)) throw new AppError(404, 'Call is no longer active');
    if (!call.lobbyName.startsWith('orgiq:')) throw new AppError(403, 'This call cannot share initiative pages');
    return call;
  }
  private connectedSession(clientId: string): Promise<Session | null> {
    return resolveConnectedCallSession(this.opts.router, clientId);
  }
  /** Preserve actual initial ownership even if an unsolicited accepted frame
   * seeds the library's callerId with somebody else's id. */
  async captureCaller(callId: string, clientId: string): Promise<void> {
    const session = await this.connectedSession(clientId);
    if (!session) return;
    await this.enqueue(callId, async () => {
      if (this.disposed || this.hasEnded(callId)) throw new AppError(404, 'Call is no longer active');
      await this.opts.pages.claimCaller(callId, { userId: session.sub, provenance: provenance(session) });
      this.tracked.add(callId);
    });
  }
  private async participant(callId: string, session: Session): Promise<{ call: ActiveCallStateView; authority: CallPageAuthority }> {
    const authority = await this.authority(session);
    const call = await this.liveCall(callId);
    const key = provenance(session);
    const connections = await Promise.all(call.participantClientIds.map(id => this.connectedSession(id)));
    const registered = connections.some(connected => connected && provenance(connected) === key);
    const auth = { userId: session.sub, org: session.tenant, role: session.role, tenants: Object.keys(authority.grants) };
    if (!registered || !this.opts.lobbyAllowed(auth, call.lobbyName)) throw new AppError(403, 'Join this call before sharing its page');
    return { call, authority };
  }
  private async snapshot(callId: string, state: StoredCallPage): Promise<CallPageSnapshot> {
    const page = state.page ? { ...await this.canonical(state.page), presenter: state.page.presenter, sharedAt: state.page.sharedAt } : null;
    return { type: 'call-page', callId, revision: state.revision, page };
  }
  async get(callId: string, session: Session): Promise<CallPageSnapshot> {
    await this.participant(callId, session);
    const state = await this.opts.pages.get(callId);
    if (state.revision > 0 || state.caller) this.tracked.add(callId);
    const snapshot = await this.snapshot(callId, state);
    // Resource/directory reads may finish after a leave/end. Recheck before
    // any metadata escapes, including the request's own response.
    await this.participant(callId, session);
    return snapshot;
  }
  async put(callId: string, session: Session, expectedRevision: number, descriptor: CallPageDescriptor): Promise<CallPageSnapshot> {
    return this.enqueue(callId, async () => {
      await this.participant(callId, session);
      const canonical = await this.canonical(descriptor);
      const { authority } = await this.participant(callId, session);
      const previous = await this.opts.pages.get(callId);
      await this.participant(callId, session);
      const page = { kind: descriptor.kind, id: descriptor.id, presenter: { userId: session.sub, displayName: authority.displayName }, sharedAt: new Date().toISOString(), provenance: provenance(session) };
      const result = await this.opts.pages.compareAndSet(callId, expectedRevision, page);
      if (result.state.revision > 0) this.tracked.add(callId);
      try { await this.participant(callId, session); }
      catch (error) { if (result.applied) await this.rollback(callId, result.state.revision, previous.page); throw error; }
      if (!result.applied) {
        const snapshot = await this.snapshot(callId, result.state);
        await this.participant(callId, session);
        throw new CallPageConflict(snapshot);
      }
      const snapshot: CallPageSnapshot = { type: 'call-page', callId, revision: result.state.revision, page: { ...canonical, presenter: page.presenter, sharedAt: page.sharedAt } };
      await this.broadcast(snapshot);
      await this.participant(callId, session);
      return snapshot;
    });
  }
  async clear(callId: string, session: Session, expectedRevision: number): Promise<CallPageSnapshot> {
    return this.enqueue(callId, async () => {
      await this.participant(callId, session);
      const state = await this.opts.pages.get(callId);
      const isCaller = state.caller?.userId === session.sub && state.caller.provenance === provenance(session);
      if (state.page?.presenter.userId !== session.sub && !isCaller) {
        throw new AppError(403, 'Only the presenter or caller may stop sharing');
      }
      await this.participant(callId, session);
      const result = await this.opts.pages.compareAndSet(callId, expectedRevision, null);
      if (result.state.revision > 0) this.tracked.add(callId);
      try { await this.participant(callId, session); }
      catch (error) { if (result.applied) await this.rollback(callId, result.state.revision, state.page); throw error; }
      if (!result.applied) {
        const snapshot = await this.snapshot(callId, result.state);
        await this.participant(callId, session);
        throw new CallPageConflict(snapshot);
      }
      const snapshot = await this.snapshot(callId, result.state);
      await this.broadcast(snapshot);
      await this.participant(callId, session);
      return snapshot;
    });
  }
  /** A membership/authority change during Redis I/O must not leave its write
   * published. Restore the earlier page with a new revision, never rewind. */
  private async rollback(callId: string, revision: number, page: StoredCallPage['page']): Promise<void> {
    if (this.hasEnded(callId) || this.disposed) return; // terminal cleanup owns it
    const restored = await this.opts.pages.compareAndSet(callId, revision, page);
    if (restored.applied) {
      try { await this.broadcast(await this.snapshot(callId, restored.state)); }
      catch { /* A concurrent terminal cleanup will forget it. */ }
    }
  }
  private async broadcast(snapshot: CallPageSnapshot): Promise<void> {
    const call = await this.liveCall(snapshot.callId);
    await Promise.allSettled(call.participantClientIds.map(async clientId => {
      const session = await this.connectedSession(clientId);
      if (!session) return;
      try {
        await this.participant(snapshot.callId, session);
        if (snapshot.page) await this.canonical(snapshot.page);
        await this.participant(snapshot.callId, session);
        const current = await this.liveCall(snapshot.callId);
        if (!current.participantClientIds.includes(clientId)) return;
        const connected = await this.connectedSession(clientId);
        if (!connected || provenance(connected) !== provenance(session)) return;
        await this.opts.router.sendToClient(clientId, snapshot);
      } catch { /* Departed, revoked, unavailable, or another tenant: fail closed. */ }
    }));
  }
  /** Peer transport can outlive the producer's checks. Resolve the stored
   * selection and current resource metadata again at the destination. */
  async filterSnapshot(clientId: string, snapshot: CallPageSnapshot): Promise<CallPageSnapshot | null> {
    if (this.disposed) return null;
    const session = await this.connectedSession(clientId);
    if (!session) return null;
    if (snapshot.page === null) {
      // Terminal tombstones arrive after the call roster has been removed.
      // Their empty contents still require current recipient authority.
      await this.authority(session);
      const state = await this.opts.pages.get(snapshot.callId);
      const call = await this.opts.calls.getCall(snapshot.callId);
      if (call && !this.hasEnded(snapshot.callId)) return this.get(snapshot.callId, session);
      if (state.revision > 0 && !state.page) return this.snapshot(snapshot.callId, state);
      if (!call && Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0) {
        return { type: 'call-page', callId: snapshot.callId, revision: snapshot.revision, page: null };
      }
      return null;
    }
    return this.get(snapshot.callId, session);
  }
  async replay(callId: string, clientId: string): Promise<void> {
    const session = await this.connectedSession(clientId);
    if (!session) return;
    try {
      const snapshot = await this.get(callId, session);
      const call = await this.liveCall(callId);
      const current = await this.connectedSession(clientId);
      if (call.participantClientIds.includes(clientId) && current && provenance(current) === provenance(session)) {
        await this.opts.router.sendToClient(clientId, snapshot);
      }
    } catch { /* GET remains the explicit retry/error path on registration/reconnect. */ }
    await this.checkPresenter(callId);
  }
  /** A lost socket retains the pinned reference for the normal rejoin grace. */
  async checkPresenter(callId: string): Promise<void> {
    if (this.disposed || this.hasEnded(callId)) return;
    // Renew page/owner TTL only while the authoritative call still exists.
    // Its getCall also renews the call TTL, including an idle revision-zero
    // caller proof restored before anybody has shared a page.
    if (!await this.opts.calls.getCall(callId)) return;
    const state = await this.opts.pages.get(callId);
    if (!state.page) return;
    const present = await this.presenterPresent(callId, state.page);
    if (present) { this.cancelAbsence(callId); return; }
    if (this.absence.has(callId)) return;
    const timer = setTimeout(() => {
      this.absence.delete(callId);
      void this.clearAbsentPresenter(callId).catch(() => undefined);
    }, this.opts.presenterGraceMs ?? 30_000);
    timer.unref?.();
    this.absence.set(callId, timer);
  }
  private async presenterPresent(callId: string, page: NonNullable<StoredCallPage['page']>): Promise<boolean> {
    const call = await this.opts.calls.getCall(callId);
    const ids = call?.participantClientIds ?? [];
    const connections = await Promise.all(ids.map(id => this.connectedSession(id)));
    const candidates = ids.filter((_, index) => {
      const session = connections[index];
      return session && session.sub === page.presenter.userId && provenance(session) === page.provenance;
    });
    const allowed = await Promise.allSettled(candidates.map(async id => {
      const session = await this.connectedSession(id);
      if (!session) return false;
      await this.participant(callId, session);
      const current = await this.opts.calls.getCall(callId);
      const connected = await this.connectedSession(id);
      return !!current?.participantClientIds.includes(id) && !!connected && provenance(connected) === page.provenance;
    }));
    return allowed.some(result => result.status === 'fulfilled' && result.value);
  }
  private cancelAbsence(callId: string): void {
    const timer = this.absence.get(callId);
    if (timer) clearTimeout(timer);
    this.absence.delete(callId);
  }
  private async clearAbsentPresenter(callId: string): Promise<void> {
    await this.enqueue(callId, async () => {
      await this.liveCall(callId);
      const state = await this.opts.pages.get(callId);
      if (!state.page || await this.presenterPresent(callId, state.page)) return;
      const result = await this.opts.pages.compareAndSet(callId, state.revision, null);
      if (result.applied) await this.broadcast(await this.snapshot(callId, result.state));
    });
  }
  /** Mark synchronously so pending canonical/auth reads cannot resurrect it. */
  finish(callId: string, participantClientIds?: string[]): Promise<void> {
    if (this.hasEnded(callId)) return Promise.resolve();
    const now = Date.now();
    for (const [id, until] of this.ended) if (until <= now) this.ended.delete(id);
    this.ended.set(callId, now + 4 * 60 * 60 * 1000);
    this.tracked.delete(callId);
    this.cancelAbsence(callId);
    return this.enqueue(callId, async () => {
      const clients = participantClientIds ?? (await this.opts.calls.getCall(callId))?.participantClientIds ?? [];
      try {
        const state = await this.opts.pages.get(callId);
        if (state.page) {
          const result = await this.opts.pages.compareAndSet(callId, state.revision, null);
          const snapshot = { type: 'call-page' as const, callId, revision: result.state.revision, page: null };
          await Promise.allSettled(clients.map(async id => {
            if (await this.connectedSession(id)) await this.opts.router.sendToClient(id, snapshot);
          }));
        }
      } finally { await this.opts.pages.forget(callId); }
    });
  }
  dispose(): void {
    this.disposed = true;
    if (this.maintenance) clearInterval(this.maintenance);
    for (const timer of this.absence.values()) clearTimeout(timer);
    this.absence.clear();
    this.ended.clear();
    this.tracked.clear();
  }
}

/** Decorate only public lifecycle seams; all other methods retain their receiver. The returned store also tells the
 * social work graph (lib/work-graph/social-events.ts) that a call moved: a content-free event naming the lobby. */
export function observeCallPageLifecycle(store: RecoverableCallStateStore, runtime: () => CallPageRuntime | null,
  observer: () => CallLifecycleObserver | null = () => null): RecoverableCallStateStore {
  return watchCallStateForWorkGraph(decorateCallPageLifecycle(store, runtime, observer));
}

const WATCHED_CALL_MUTATIONS = new Set(['registerParticipant', 'removeParticipant', 'forgetCall', 'forgetCallIfUnchanged', 'claimAcceptedSeat', 'resumeParticipant', 'setCall']);
function watchCallStateForWorkGraph(store: RecoverableCallStateStore): RecoverableCallStateStore {
  const tell = async (callId: unknown, ended: boolean): Promise<void> => {
    if (typeof callId !== 'string') return;
    try {
      const view = ended ? null : await store.getCall(callId);
      if (view) observeCall({ callId, lobbyName: view.lobbyName, callerId: view.callerId, targetUserIds: view.targetUserIds, participants: view.participantClientIds.length });
      // A call the store no longer holds (the last seat left, or it was forgotten) is over.
      const call = ended || !view ? observeCallEnded(callId) : observedCall(callId);
      const conversationId = socialConversationOrNull(call?.lobbyName);
      if (conversationId) {
        emitSocialWorkGraphEvent({ conversationId, cause: 'call' });
        // The call log and the recording land in platform-api a moment after the call moves.
        if (ended) setTimeout(() => emitSocialWorkGraphEvent({ conversationId, cause: 'recording' }), 4_000).unref?.();
      }
    } catch { /* a missed hint is repaired by the next reload; never fail the call */ }
  };
  return new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof key !== 'string' || !WATCHED_CALL_MUTATIONS.has(key) || typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        // The lobby of a call that is about to be forgotten is known only before it goes.
        const ended = key === 'forgetCall' || key === 'forgetCallIfUnchanged';
        if (ended && typeof args[0] === 'string') {
          const view = await target.getCall(args[0]).catch(() => null);
          if (view) observeCall({ callId: args[0], lobbyName: view.lobbyName, callerId: view.callerId, targetUserIds: view.targetUserIds, participants: view.participantClientIds.length });
        }
        const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        // A mutation that changed nothing (a refused resume, a lost accept race, a stale prune) tells the graph nothing.
        if ((key === 'forgetCallIfUnchanged' || key === 'resumeParticipant') && result !== true) return result;
        if (key === 'claimAcceptedSeat' && !(result as { accepted?: boolean } | null)?.accepted) return result;
        await tell(args[0], ended);
        return result;
      };
    },
  });
}

function decorateCallPageLifecycle(store: RecoverableCallStateStore, runtime: () => CallPageRuntime | null,
  observer: () => CallLifecycleObserver | null = () => null): RecoverableCallStateStore {
  const observe = async (operation: () => Promise<void> | undefined) => {
    try { await operation(); } catch (error) { console.warn('[call-lifecycle] feature reconciliation failed', error); }
  };
  return new Proxy(store, {
    get(target, key) {
      if (key === 'claimAcceptedSeat' && target.claimAcceptedSeat) return async (...args: Parameters<NonNullable<CallStateStore['claimAcceptedSeat']>>) => {
        const alreadySeated = (await target.getCall(args[0]))?.participantClientIds.includes(args[1]) ?? false;
        const claim = await target.claimAcceptedSeat!(...args);
        if (claim.accepted) {
          // Accepted-seat admission changes the roster atomically and skips
          // registerParticipant. Reconcile the huddle join/page replay before
          // signaling acceptance; this never transfers the original caller.
          await observe(() => observer()?.registered(args[0], args[1], alreadySeated));
          void runtime()?.replay(args[0], args[1]).catch(() => undefined);
        }
        return claim;
      };
      if (key === 'resumeParticipant' && target.resumeParticipant) return async (...args: Parameters<NonNullable<RecoverableCallStateStore['resumeParticipant']>>) => {
        const resumed = await target.resumeParticipant!(...args);
        if (resumed) {
          // The atomic operation changes membership without calling the
          // creating registerParticipant path. Never claim a new caller on
          // resume; the existing page record already owns that provenance.
          try {
            const current = await target.getCall(args[0]);
            if (current?.participantClientIds.includes(args[1])) {
              await observe(() => observer()?.registered(args[0], args[1], true));
              void runtime()?.replay(args[0], args[1]).catch(() => undefined);
            }
          } catch { /* Replay is best-effort; preserve the store's true result. */ }
        }
        return resumed;
      };
      if (key === 'forgetCallIfUnchanged' && target.forgetCallIfUnchanged) return async (...args: Parameters<NonNullable<RecoverableCallStateStore['forgetCallIfUnchanged']>>) => {
        const forgotten = await target.forgetCallIfUnchanged!(...args);
        if (forgotten) {
          await observe(() => observer()?.finish(args[0], args[1].participantClientIds));
          // A false stale-roster CAS must have no terminal/page effects.
          // On true the authoritative call is already gone; use the exact
          // successfully pruned audience for the final null tombstone.
          try { await runtime()?.finish(args[0], args[1].participantClientIds); }
          catch (error) { console.warn('[call-page] conditional prune cleanup failed', error); }
        }
        return forgotten;
      };
      if (key === 'forgetCall') return async (callId: string) => {
        const cleanup = runtime()?.finish(callId);
        const chatCleanup = observer()?.finish(callId);
        try { await cleanup; await observe(() => chatCleanup); }
        finally { await target.forgetCall(callId); }
      };
      if (key === 'registerParticipant') return async (...args: Parameters<CallStateStore['registerParticipant']>) => {
        const alreadySeated = (await target.getCall(args[0]))?.participantClientIds.includes(args[1]) ?? false;
        await runtime()?.captureCaller(args[0], args[1]);
        await target.registerParticipant(...args);
        await observe(() => observer()?.registered(args[0], args[1], alreadySeated));
        void runtime()?.replay(args[0], args[1]).catch(() => undefined);
      };
      if (key === 'removeParticipant') return async (...args: Parameters<CallStateStore['removeParticipant']>) => {
        observer()?.invalidate(args[0], args[1]);
        const result = await target.removeParticipant(...args);
        await observe(() => observer()?.removed(args[0], args[1]));
        // Zero connected seats can still be inside the library's rejoin
        // grace. Only forgetCall / onCallEnded proves terminal closure.
        void runtime()?.checkPresenter(args[0]).catch(() => undefined);
        return result;
      };
      if (key === 'setCall' && target.setCall) return async (...args: Parameters<NonNullable<CallStateStore['setCall']>>) => {
        observer()?.invalidate(args[0]);
        // A restored record already retains its proof; a legacy call without
        // one can only claim an actually connected authenticated seat.
        for (const id of args[1].participantClientIds) await runtime()?.captureCaller(args[0], id);
        await target.setCall!(...args);
        await observe(() => observer()?.restored(args[0], args[1]));
        for (const id of args[1].participantClientIds) void runtime()?.replay(args[0], id).catch(() => undefined);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

let runtime: CallPageRuntime | null = null;
export function setCallPageRuntime(value: CallPageRuntime | null): void { runtime = value; }
export function callPageRuntime(): CallPageRuntime {
  if (!runtime) throw new AppError(503, 'Realtime calls are unavailable');
  return runtime;
}
