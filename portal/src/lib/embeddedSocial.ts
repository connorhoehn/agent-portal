import type { SocialDm, SocialPeer, SocialPerson } from '../pages/social/socialChat.ts';
import { dmLobby, dmIds } from '../pages/social/socialPlatform.ts';
import type { CallPageDescriptor } from './callPages.ts';
import { apiFailure, reportApiFailure } from './apiFailure.ts';

export interface EmbeddedSocialScope {
  userId: string; tenant: string; role: string;
  actorId: string | null; asUserId: string | null;
}
export interface EmbeddedSocialSource {
  userId: string; tenant: string; role: string; epoch: number;
  actor: { userId: string; epoch: number } | null;
}
export interface EmbeddedSocialSnapshot {
  me: SocialPeer; canSend: boolean; people: SocialPerson[]; conversations: SocialDm[];
  authorityKey: string; source: EmbeddedSocialSource;
  peopleTotal?: number; peopleHasMore?: boolean; conversationsHasMore?: boolean;
}
export interface EmbeddedSocialClient {
  read(signal: AbortSignal): Promise<EmbeddedSocialSnapshot>;
  openDm(userId: string, signal: AbortSignal): Promise<{ channel: string; peers: SocialPeer[] }>;
  markRead(channel: string, signal: AbortSignal): Promise<void>;
}
/** Rich drafts stay local; only plain text crosses the initial DM seam. */
export interface EmbeddedSocialDraft { html: string; files: never[] }
export interface EmbeddedSocialTransport {
  channel: string; ready: boolean;
  /** Resolves only after both the persisted sent ack and matching message. */
  send(text: string, signal: AbortSignal, page?: CallPageDescriptor | null, extra?: Record<string, unknown>): Promise<void>;
}
export type EmbeddedSocialPrepare = (text: string) => Promise<{ text: string; extra?: Record<string, unknown> | undefined }>;
export interface EmbeddedSocialState {
  scopeKey: string | null; snapshot: EmbeddedSocialSnapshot | null;
  open: boolean; selected: string | null; picking: boolean; activity: boolean;
  drafts: Readonly<Record<string, EmbeddedSocialDraft>>;
  loading: boolean; opening: boolean; pending: string | null; error: string | null;
  authorityVerified: boolean;
}
export const emptyEmbeddedSocialState = (): EmbeddedSocialState => ({
  scopeKey: null, snapshot: null, open: false, selected: null, picking: false, activity: false,
  drafts: {}, loading: false, opening: false, pending: null, error: null, authorityVerified: false,
});
export const embeddedSocialScopeKey = (scope: EmbeddedSocialScope | null): string | null => scope
  ? JSON.stringify([scope.userId, scope.tenant, scope.role, scope.actorId, scope.asUserId]) : null;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const name = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const epoch = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const peer = (value: unknown): value is SocialPeer => !!object(value) && name(object(value)?.userId) && name(object(value)?.displayName);
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';

/** Never adopt a directory or conversation for another actor/source context. */
export function readEmbeddedSocialSnapshot(value: unknown): EmbeddedSocialSnapshot | null {
  const row = object(value), source = object(row?.source), actor = source?.actor === null ? null : object(source?.actor);
  if (!row || !source || !peer(row.me) || typeof row.canSend !== 'boolean' || !name(row.authorityKey)
    || !name(source.userId) || !name(source.tenant) || !name(source.role) || !epoch(source.epoch)
    || (source.actor !== null && (!actor || !name(actor.userId) || !epoch(actor.epoch)))
    || row.me.userId !== source.userId || !Array.isArray(row.people) || !Array.isArray(row.conversations)) return null;
  if (!row.people.every(value => peer(value) && Array.isArray(object(value)?.roles)
    && (object(value)!.roles as unknown[]).every(name))) return null;
  if ((row.peopleTotal !== undefined && !epoch(row.peopleTotal))
    || (row.peopleHasMore !== undefined && typeof row.peopleHasMore !== 'boolean')
    || (row.conversationsHasMore !== undefined && typeof row.conversationsHasMore !== 'boolean')) return null;
  if (!row.conversations.every(value => {
    const dm = object(value), ids = dmIds(typeof dm?.channel === 'string' ? dm.channel : null);
    return !!dm && !!ids && ids.length === 2 && new Set(ids).size === 2 && ids.includes(source.userId as string)
      && dm.channel === dmLobby(ids) && Array.isArray(dm.peers) && dm.peers.length === 1 && dm.peers.every(peer)
      && dm.peers[0].userId === ids.find(id => id !== source.userId)
      && nullableString(dm.lastMessageAt) && nullableString(dm.lastMessagePreview) && nullableString(dm.lastMessageUserId)
      && (dm.unreadCount === undefined || (epoch(dm.unreadCount)));
  })) return null;
  return row as unknown as EmbeddedSocialSnapshot;
}
export function embeddedSourceMatches(scope: EmbeddedSocialScope, snapshot: EmbeddedSocialSnapshot): boolean {
  const source = snapshot.source;
  return scope.userId === source.userId && scope.tenant === source.tenant && scope.role === source.role
    && scope.actorId === (source.actor?.userId ?? null)
    && (scope.asUserId === null || scope.asUserId === source.userId);
}
/** Client transport fence only; the gateway remains the authority verifier. */
export function embeddedTokenMatchesSource(token: string | undefined, source: EmbeddedSocialSource): boolean {
  if (!token) return false;
  try {
    const claims = object(JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))));
    const actor = object(claims?.act);
    return claims?.sub === source.userId && claims.org === source.tenant && claims.role === source.role
      && (claims.epoch ?? 0) === source.epoch && (actor?.sub ?? null) === (source.actor?.userId ?? null)
      && (source.actor === null || (actor?.epoch ?? 0) === source.actor.epoch);
  } catch { return false; }
}
export class EmbeddedSocialRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function createEmbeddedSocialClient(fetchImpl: typeof fetch = (...args) => fetch(...args)): EmbeddedSocialClient {
  async function request(path: string, signal: AbortSignal, body?: unknown) {
    const response = await fetchImpl(path, { credentials: 'include', signal, ...(body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }) });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (!signal.aborted) reportApiFailure(apiFailure(response.status, response.statusText, value));
      throw new EmbeddedSocialRequestError(response.status,
        typeof object(value)?.error === 'string' ? String(object(value)?.error) : 'Social is unavailable. Try again.');
    }
    return value;
  }
  return {
    async read(signal) {
      const snapshot = readEmbeddedSocialSnapshot(await request('/api/social/embedded', signal));
      if (!snapshot) throw new EmbeddedSocialRequestError(502, 'The Social response was invalid.');
      return snapshot;
    },
    async openDm(userId, signal) {
      const value = object(await request('/api/social/dms', signal, { userId }));
      if (!value || !name(value.channel) || !Array.isArray(value.peers) || !value.peers.every(peer)) {
        throw new EmbeddedSocialRequestError(502, 'The direct message destination was not confirmed.');
      }
      return value as unknown as { channel: string; peers: SocialPeer[] };
    },
    async markRead(channel, signal) { await request('/api/social/dms/read', signal, { channel }); },
  };
}

/** Route-independent actor state. A panel selection can never redirect a send. */
export class EmbeddedSocialSession {
  private state = emptyEmbeddedSocialState();
  private listeners = new Set<() => void>();
  private scope: EmbeddedSocialScope | null = null;
  private scopeGeneration = 0;
  private readGeneration = 0;
  private destinationGeneration = 0;
  private openGeneration = 0;
  private scopeAbort = new AbortController();
  private sendAbort: AbortController | null = null;
  private transport: EmbeddedSocialTransport | null = null;
  private client: EmbeddedSocialClient;
  private joinTimeoutMs: number;
  constructor(client: EmbeddedSocialClient, joinTimeoutMs = 10_000) { this.client = client; this.joinTimeoutMs = joinTimeoutMs; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  private publish(patch: Partial<EmbeddedSocialState>) {
    this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener());
  }
  setScope(scope: EmbeddedSocialScope | null) {
    const key = embeddedSocialScopeKey(scope); if (key === this.state.scopeKey) return;
    this.scopeAbort.abort(); this.sendAbort?.abort(); this.scopeAbort = new AbortController();
    this.scopeGeneration++; this.readGeneration++; this.destinationGeneration++; this.openGeneration++; this.scope = scope;
    this.transport = null; this.state = { ...emptyEmbeddedSocialState(), scopeKey: key };
    this.listeners.forEach(listener => listener());
  }
  async refresh(): Promise<boolean> {
    if (!this.scope) return false;
    const scope = this.scope, generation = this.scopeGeneration, read = ++this.readGeneration;
    const current = () => generation === this.scopeGeneration && read === this.readGeneration;
    this.publish({ loading: true });
    try {
      let snapshot = await this.client.read(this.scopeAbort.signal);
      if (!current()) return false;
      if (!embeddedSourceMatches(scope, snapshot)) throw new EmbeddedSocialRequestError(403, 'Social authority changed. Refresh your session.');
      this.publish({ authorityVerified: true });
      const previous = this.state.snapshot;
      // Bounded directory/history omission is not a revocation. Preserve at
      // most the one selected DM/peer; every subsequent action reauthorizes.
      if (previous?.authorityKey === snapshot.authorityKey && this.state.selected) {
        const selected = previous.conversations.find(dm => dm.channel === this.state.selected);
        if (selected && snapshot.conversationsHasMore && !snapshot.conversations.some(dm => dm.channel === selected.channel)) {
          snapshot = { ...snapshot, conversations: [selected, ...snapshot.conversations] };
        }
        const selectedPeer = selected?.peers[0]?.userId;
        const person = previous.people.find(person => person.userId === selectedPeer);
        if (person && snapshot.peopleHasMore && !snapshot.people.some(value => value.userId === person.userId)) {
          snapshot = { ...snapshot, people: [...snapshot.people, person] };
        }
      }
      if (previous && previous.authorityKey !== snapshot.authorityKey) {
        this.sendAbort?.abort(); this.transport = null; this.destinationGeneration++;
        this.publish({ snapshot, open: false, selected: null, picking: false, activity: false, drafts: {}, pending: null, opening: false, error: null });
      } else {
        const eligible = new Set(snapshot.people.map(person => person.userId));
        const selected = this.state.selected;
        const selectedPeers = dmIds(selected)?.filter(id => id !== scope.userId) ?? [];
        if (selected && !snapshot.peopleHasMore && selectedPeers.some(id => !eligible.has(id))) {
          this.sendAbort?.abort(); this.transport = null; this.destinationGeneration++;
          this.publish({ snapshot, selected: null, pending: null, error: 'This direct message is no longer available.' });
        } else this.publish({ snapshot, error: null });
      }
      return true;
    } catch (cause) {
      if (!current()) return false;
      this.sendAbort?.abort();
      this.publish({ authorityVerified: false });
      if (cause instanceof EmbeddedSocialRequestError && [401, 403].includes(cause.status)) {
        this.sendAbort?.abort(); this.transport = null; this.destinationGeneration++;
        this.publish({ snapshot: null, selected: null, open: false, drafts: {}, pending: null });
      }
      this.publish({ error: cause instanceof Error ? cause.message : 'Social is unavailable.' }); return false;
    } finally { if (current()) this.publish({ loading: false }); }
  }
  openMessage() { if (this.scope) this.publish({ open: true }); }
  closeMessage() { this.publish({ open: false }); }
  showPicker() { if (this.state.snapshot) this.publish({ open: true, picking: true, activity: false }); }
  showActivity() { if (this.state.snapshot) this.publish({ open: true, picking: false, activity: true }); }
  cancelPicker() { this.publish({ picking: false }); }
  private choose(channel: string, open: boolean) {
    if (channel !== this.state.selected) {
      this.sendAbort?.abort(); this.transport = null; this.destinationGeneration++;
    }
    this.publish({ selected: channel, open: open || this.state.open, picking: false, activity: false, error: null,
      drafts: this.state.drafts[channel] ? this.state.drafts : { ...this.state.drafts, [channel]: { html: '', files: [] } } });
  }
  selectDm(channel: string) {
    const conversation = this.state.snapshot?.conversations.find(dm => dm.channel === channel);
    if (conversation) this.choose(channel, true);
  }
  async openDm(userId: string, open = true): Promise<string | null> {
    const snapshot = this.state.snapshot, scope = this.scope;
    if (!snapshot || !scope || userId === scope.userId || !snapshot.people.some(person => person.userId === userId)) {
      this.publish({ error: 'This person is not available for direct messages.' }); return null;
    }
    const generation = this.scopeGeneration, destination = ++this.destinationGeneration, authority = snapshot.authorityKey,
      opening = ++this.openGeneration;
    this.sendAbort?.abort();
    const current = () => generation === this.scopeGeneration && destination === this.destinationGeneration
      && this.state.snapshot?.authorityKey === authority;
    this.publish({ opening: true, error: null });
    try {
      const receipt = await this.client.openDm(userId, this.scopeAbort.signal);
      if (!current()) return null;
      const expected = dmLobby([scope.userId, userId]);
      if (receipt.channel !== expected || receipt.peers.length !== 1 || receipt.peers[0]?.userId !== userId) {
        throw new EmbeddedSocialRequestError(502, 'The direct message destination was not confirmed.');
      }
      if (!this.state.snapshot!.conversations.some(dm => dm.channel === receipt.channel)) {
        this.publish({ snapshot: { ...this.state.snapshot!, conversations: [{ channel: receipt.channel, peers: receipt.peers,
          lastMessageAt: null, lastMessagePreview: null, lastMessageUserId: null, unreadCount: 0 }, ...this.state.snapshot!.conversations] } });
      }
      this.choose(receipt.channel, open); return receipt.channel;
    } catch (cause) {
      if (current()) this.publish({ error: cause instanceof Error ? cause.message : 'The conversation could not be opened.' });
      return null;
    } finally { if (generation === this.scopeGeneration && opening === this.openGeneration) this.publish({ opening: false }); }
  }
  setDraft(channel: string, draft: EmbeddedSocialDraft, previous?: EmbeddedSocialDraft) {
    if (!this.state.snapshot || !dmIds(channel)?.includes(this.scope?.userId ?? '')) return;
    if (previous !== undefined && this.state.drafts[channel] !== previous) return;
    this.publish({ drafts: { ...this.state.drafts, [channel]: draft } });
  }
  bindTransport(authorityKey: string, transport: EmbeddedSocialTransport) {
    if (authorityKey !== this.state.snapshot?.authorityKey || transport.channel !== this.state.selected) return () => {};
    this.transport = transport; this.publish({});
    return () => {
      if (this.transport !== transport) return;
      this.transport = null;
      // Replacing the initial not-ready binding with its joined binding is
      // the transition an explicit send is waiting for. Scope/destination
      // changes already cancel it; losing a ready transport cancels delivery.
      if (transport.ready) this.sendAbort?.abort();
      this.publish({});
    };
  }
  canSend = () => this.state.authorityVerified && !!this.state.snapshot?.canSend && !!this.transport?.ready && !this.state.pending;
  private waitForReady(channel: string, valid: () => boolean): Promise<EmbeddedSocialTransport> {
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const finish = (error?: Error, transport?: EmbeddedSocialTransport) => {
        clearTimeout(timer); unsubscribe(); if (error) reject(error); else resolve(transport!);
      };
      const check = () => {
        if (!valid()) finish(new Error('The direct message destination changed before sending.'));
        else if (this.transport?.channel === channel && this.transport.ready) finish(undefined, this.transport);
      };
      const timer = setTimeout(() => finish(new Error('The direct message is not connected. Your draft has been kept.')), this.joinTimeoutMs);
      unsubscribe = this.subscribe(check); check();
    });
  }
  /**
   * `prepare` runs once the DM is open and its transport joined — files must land on a joined channel
   * (the gateway answers an upload only to its subscribers) — and returns the final text plus the
   * message metadata citing what landed. It may reject: the send fails and the draft is kept.
   */
  async sendToPerson(userId: string, text: string, page?: CallPageDescriptor | null, prepare?: EmbeddedSocialPrepare): Promise<boolean> {
    if ((!text.trim() && !prepare) || this.state.pending || !this.state.authorityVerified || !this.state.snapshot?.canSend) return false;
    const submittedPage = page ? { kind: page.kind, id: page.id } : null;
    const generation = this.scopeGeneration, authority = this.state.snapshot.authorityKey;
    const channel = await this.openDm(userId, false); if (!channel) return false;
    const destination = this.destinationGeneration;
    const current = () => generation === this.scopeGeneration && destination === this.destinationGeneration
      && this.state.snapshot?.authorityKey === authority && this.state.selected === channel;
    return this.deliver(channel, text, current, submittedPage, prepare);
  }
  async sendSelected(text: string): Promise<boolean> {
    const channel = this.state.selected, generation = this.scopeGeneration, destination = this.destinationGeneration,
      authority = this.state.snapshot?.authorityKey;
    if (!channel || !text.trim() || this.state.pending || !this.state.authorityVerified || !this.state.snapshot?.canSend) return false;
    return this.deliver(channel, text, () => generation === this.scopeGeneration && destination === this.destinationGeneration
      && this.state.selected === channel && this.state.snapshot?.authorityKey === authority);
  }
  private async deliver(channel: string, text: string, current: () => boolean, page?: CallPageDescriptor | null, prepare?: EmbeddedSocialPrepare): Promise<boolean> {
    const abort = new AbortController(); this.sendAbort = abort; this.publish({ pending: channel, error: null });
    try {
      const transport = await this.waitForReady(channel, current);
      if (!current() || !this.state.authorityVerified || !this.state.snapshot?.canSend || abort.signal.aborted) return false;
      const prepared = prepare ? await prepare(text) : { text, extra: undefined };
      if (!current() || abort.signal.aborted) return false;
      await transport.send(prepared.text.trim(), abort.signal, page, prepared.extra);
      if (!current() || abort.signal.aborted) return false;
      this.publish({ error: null }); return true;
    } catch (cause) {
      if (current()) this.publish({ error: cause instanceof Error ? cause.message : 'The message receipt was not confirmed. Your draft has been kept.' });
      return false;
    } finally {
      if (this.sendAbort === abort) { this.sendAbort = null; this.publish({ pending: null }); }
    }
  }
  async markRead(channel: string) {
    const generation = this.scopeGeneration, authority = this.state.snapshot?.authorityKey;
    if (!authority || channel !== this.state.selected) return;
    try {
      await this.client.markRead(channel, this.scopeAbort.signal);
      if (generation !== this.scopeGeneration || authority !== this.state.snapshot?.authorityKey) return;
      this.publish({ snapshot: { ...this.state.snapshot, conversations: this.state.snapshot.conversations.map(dm => dm.channel === channel ? { ...dm, unreadCount: 0 } : dm) } });
    } catch { /* The next directory refresh keeps the unread count honest. */ }
  }
}
