// The social tenant's chat state — channels, DMs, messages, membership
// (docs/social-tenant-design.md §4.3–§4.4, lane S1).
//
// Two backends behind one shape, chosen once when the gateway attaches
// (lib/realtime-gateway.ts `createSocialChatBackend`):
//
//   dynamo  the library's DynamoChatStore (realtime-modules 0.99.0,
//           `server/stores/dynamo`) over chat-messages / chat-conversations
//           (GSI channel-index) / chat-members / chat-reads — the tables
//           OrgIQ-Social creates and DynamoDB Local serves under the `social`
//           compose profile. On when SOCIAL_CHAT_STORE=dynamo, or when it is
//           unset and SOCIAL_CHAT_DYNAMODB_ENDPOINT or SOCIAL_CHAT_TABLE_PREFIX
//           is set.
//   memory  the library's in-memory stores; `social:` messages and members are
//           the registered fixture rows of mock/social-channels.ts under
//           MOCK_AURORA (so `POST /api/__mock/reset` restores them), private
//           arrays otherwise. The default — dev:mock without the social
//           profile keeps working with nothing configured.
//
// The synchronous resource guards use a process mirror. Async authority
// reads refresh that view from the durable membership store; writes commit
// there first, then invalidate pending proofs locally and on peer replicas.
// Missing invalidations do not authorize stale rows on the next protected read.
//
// The channel DIRECTORY (name, description, privacy) is not chat state; it is
// providers/social-channels.ts (Aurora `social_channels`, the fixture under
// MOCK_AURORA).

import {
  MemoryChatPinsStore,
  type ChatPinsStore,
  type ChatMember,
  type ChatMembershipStore,
  type ChatMessage,
  type ChatMessagePatch,
  type ChatReadReceipt,
  type ChatReadReceiptStore,
  type ChatStore,
} from '@connorhoehn/realtime-modules/chat';
import { dmLobbyName, dmLobbyPrefix, parseDmLobby } from '@connorhoehn/realtime-modules/call';
import { revokePublishProofs, type AuthorityScope } from '@connorhoehn/realtime-modules/server';
import { DynamoChatStore, DynamoChatPinsStore, type DynamoCommandClient } from '@connorhoehn/realtime-modules/server/stores/dynamo';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { config } from '../config.js';
import { listChannels } from '../providers/social-channels.js';
import { DynamoDispatchQueue } from './dynamo-dispatch.js';
import { socialChatIndexWrites } from './gateway/env.js';
import {
  latestMessage,
  socialChannelMembersFixture,
  socialChannelMessagesFixture,
  socialReadCursorsFixture,
  socialDmJoinsFixture,
  socialPinsFixture,
} from '../mock/social-channels.js';
import { clock } from '../mock/core/index.js';
import { TENANTS } from './session.js';
import { emitSocialWorkGraphEvent, socialConversationOrNull } from './work-graph/social-events.js';
import { ownsRecord } from './record-owner.js';
import { noteSearchWrite } from './search-index/writes.js';
import { onCloneDmCleanup } from '../mock/clone-dm-cleanup.js';

// ── Names ────────────────────────────────────────────────────────────────────

export const SOCIAL_CHANNEL_PREFIX = 'social:ch:';
// The library's own prefix rule, so it cannot drift from `dmLobbyName`.
export const SOCIAL_DM_PREFIX = dmLobbyPrefix({ prefix: 'social:' });
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function channelForSlug(slug: string): string {
  return `${SOCIAL_CHANNEL_PREFIX}${slug}`;
}

/** `social:ch:<slug>` → slug, or null for any other name. */
export function slugForChannel(channel: string): string | null {
  if (!channel.startsWith(SOCIAL_CHANNEL_PREFIX)) return null;
  const slug = channel.slice(SOCIAL_CHANNEL_PREFIX.length);
  return SLUG_RE.test(slug) ? slug : null;
}

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/** "Design Reviews!" → "design-reviews"; '' when nothing usable is left. */
export function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

/** The DM lobby for a set of users: `social:dm:<sorted, deduped ids>` (library naming). */
export function dmChannelFor(userIds: readonly string[]): string {
  return dmLobbyName(userIds.filter(Boolean), { prefix: 'social:' });
}

/** `social:dm:<a>:<b>…` → member ids, or null. */
export function dmMembers(channel: string): string[] | null {
  const parsed = parseDmLobby(channel, { prefix: 'social:' });
  return parsed?.kind === 'dm' ? parsed.members : null;
}

/**
 * Any tenant's `<tenant>:dm:<ids>` name → member ids, or null. Indexing only:
 * channel authority stays in tenant-channels.ts / live-principal.ts.
 */
export function tenantDmMembers(channel: string): string[] | null {
  const tenant = channel.split(':', 1)[0];
  if (!(TENANTS as readonly string[]).includes(tenant)) return null;
  const parsed = parseDmLobby(channel, { prefix: `${tenant}:` });
  return parsed?.kind === 'dm' ? parsed.members : null;
}

/**
 * A DM copy made for an identity clone (lib/clone-dms.ts) is named for the clone. It belongs to that clone alone: the
 * persona and the peer must not list it, index it or be offered it, so a conversation naming a clone id is hidden from
 * every viewer but that clone.
 */
export function namesForeignClone(channel: string, viewer: string): boolean {
  return (tenantDmMembers(channel) ?? []).some(id => id !== viewer && id.includes('-clone-'));
}

// ── Config ───────────────────────────────────────────────────────────────────

export interface SocialChatConfig {
  store: 'dynamo' | 'memory';
  endpoint: string | null;
  tablePrefix: string;
  region: string;
}

export function socialChatConfig(env: NodeJS.ProcessEnv = process.env): SocialChatConfig {
  const endpoint = env['SOCIAL_CHAT_DYNAMODB_ENDPOINT']?.trim() || null;
  const tablePrefix = env['SOCIAL_CHAT_TABLE_PREFIX']?.trim() ?? '';
  const explicit = (env['SOCIAL_CHAT_STORE'] ?? '').trim().toLowerCase();
  const store: SocialChatConfig['store'] = explicit === 'dynamo' ? 'dynamo'
    : explicit === 'memory' ? 'memory'
      : endpoint || tablePrefix ? 'dynamo' : 'memory';
  return { store, endpoint, tablePrefix, region: env['AWS_REGION']?.trim() || 'us-east-1' };
}

// ── Stores ───────────────────────────────────────────────────────────────────


/**
 * A ChatStore over `rows()` for EVERY channel (social, tenant discussions,
 * `<tenant>:dm:`, call chats). Under MOCK_AURORA `rows()` is the registered
 * `social.channel-messages` fixture, so `POST /api/__mock/reset` takes back a
 * message posted on any tenant's channel; otherwise a private array.
 */
export class RowsChatStore implements ChatStore {
  constructor(private readonly rows: () => ChatMessage[]) {}

  async putMessage(message: ChatMessage): Promise<void> {
    const rows = this.rows();
    const at = rows.findIndex((m) => m.channel === message.channel && m.id === message.id);
    const copy = structuredClone(message);
    if (at >= 0) rows[at] = copy; else rows.push(copy);
  }

  async listMessages(channel: string, limit: number): Promise<ChatMessage[]> {
    const mine = this.rows().filter((m) => m.channel === channel)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return structuredClone(mine.slice(Math.max(0, mine.length - limit)));
  }

  async getMessage(channel: string, messageId: string): Promise<ChatMessage | null> {
    const message = this.rows().find((m) => m.channel === channel && m.id === messageId);
    return message ? structuredClone(message) : null;
  }

  async updateMessage(channel: string, messageId: string, patch: ChatMessagePatch): Promise<ChatMessage | null> {
    const row = this.rows().find((m) => m.channel === channel && m.id === messageId);
    if (!row) return null;
    Object.assign(row, structuredClone(patch));
    return structuredClone(row);
  }
}

/**
 * Membership with a synchronous view of every `social:ch:` channel refreshed
 * by async reads. `rows()` is the mirror; `persist` the durable
 * store (Dynamo's `chat-members`), or null when the rows ARE the store.
 */
/** One operation's shared membership rows and the fence started before they were read. */
export interface ScopedMembershipRead { rows: ChatMember[]; changed: () => boolean }

export class MirroredMembershipStore implements ChatMembershipStore {
  private readonly observers = new Map<string, Set<() => void>>();
  private readonly queuedReads = new Map<string, Promise<ChatMember[]>>();
  constructor(private readonly rows: () => ChatMember[], private readonly persist: ChatMembershipStore | null,
    private readonly dispatchRead?: (read: () => Promise<ChatMember[]>) => Promise<ChatMember[]>) {}

  /** Pending-read fence only; no settled positive membership is cached. */
  observeChanges(channel: string, onChange?: () => void): { changed: () => boolean; dispose: () => void } {
    let changed = false; let disposed = false;
    const observer = () => { changed = true; onChange?.(); };
    const set = this.observers.get(channel) ?? new Set<() => void>(); set.add(observer); this.observers.set(channel, set);
    return { changed: () => changed, dispose: () => {
      if (disposed) return; disposed = true; set.delete(observer);
      if (!set.size) this.observers.delete(channel);
    } };
  }
  private changed(channel: string): void {
    this.queuedReads.delete(channel);
    for (const observer of this.observers.get(channel) ?? []) observer();
  }
  /** A trusted peer signals a committed write. Pending authority reads are
   * fenced immediately; the next read still resolves the durable rows. */
  invalidate(channel: string): void { this.changed(channel); }
  private readonly writeObservers = new Set<(channel: string) => void>();
  onCommittedWrite(observer: (channel: string) => void): () => void {
    this.writeObservers.add(observer); return () => { this.writeObservers.delete(observer); };
  }

  private mirrored(channel: string): boolean {
    return !this.persist || channel.startsWith(SOCIAL_CHANNEL_PREFIX);
  }

  /**
   * `opts.scope` (realtime-modules 0.107) is ONE library operation — a chat
   * send, a join, a fan-out. Its checks share one durable read per channel
   * (`members:<channel>`, the same key the gateway's channel authority uses).
   * Rows here are data, not a decision: when a committed write or peer hint
   * lands during the operation, this caller gets a fresh read instead.
   */
  async listMembers(channel: string, opts: { scope?: AuthorityScope } = {}): Promise<ChatMember[]> {
    const own = opts.scope?.active ? this.observeChanges(channel) : null;
    try {
      const shared = own ? this.scopedMembers(channel, opts.scope!) : null;
      if (shared) {
        const read = await shared;
        if (!read.changed() && !own!.changed()) return structuredClone(read.rows);
      }
    } finally { own?.dispose(); }
    return this.freshMembers(channel);
  }

  private async freshMembers(channel: string): Promise<ChatMember[]> {
    if (!this.mirrored(channel)) return this.readDurableMembers(channel);
    await this.hydrate(channel);
    return structuredClone(this.rows().filter((m) => m.channel === channel));
  }

  /**
   * The operation's one membership read for `channel`, or null once the scope
   * has ended (callers then read fresh, as before 0.107). The change observer
   * is registered synchronously BEFORE the read starts and stays until the
   * scope closes, so a write or peer invalidation at any point after the read
   * began marks the shared proof `changed` for every remaining check of the
   * operation. A rejected read is dropped from the scope so the next check
   * retries. Nothing outlives the operation: there is no settled answer.
   */
  scopedMembers(channel: string, scope: AuthorityScope): Promise<ScopedMembershipRead> | null {
    if (!scope.active) return null;
    return scope.share(`members:${channel}`, () => {
      // A write or peer hint during the operation also drops the operation's
      // publish proofs (realtime-modules 0.109 P4), so its next publish
      // recheck asks fresh instead of reusing a pre-revocation decision.
      const observer = this.observeChanges(channel, () => { revokePublishProofs(scope); });
      scope.onClose(observer.dispose);
      return this.freshMembers(channel).then(rows => ({ rows, changed: observer.changed }),
        (error: unknown) => { observer.dispose(); throw error; });
    });
  }

  async getMember(channel: string, userId: string): Promise<ChatMember | null> {
    if (!this.mirrored(channel)) {
      // Share only a partition read that has not started yet. A query already
      // underway may have captured authority before this caller's action.
      const pending = this.queuedReads.get(channel);
      if (!pending) return this.persist!.getMember(channel, userId);
      return structuredClone((await pending).find(row => row.userId === userId) ?? null);
    }
    await this.hydrate(channel);
    const row = this.rows().find((m) => m.channel === channel && m.userId === userId)
      ?? this.rows().find((m) => m.channel === channel && ownsRecord(m.userId, userId));
    return row ? structuredClone(row) : null;
  }

  async putMember(member: ChatMember): Promise<void> {
    // Durable first: a write the store refused must not be believed here.
    if (this.persist) await this.persist.putMember(member);
    if (this.mirrored(member.channel)) this.upsert(member);
    this.changed(member.channel);
    for (const observer of this.writeObservers) observer(member.channel);
  }

  private upsert(member: ChatMember): void {
    const rows = this.rows();
    const at = rows.findIndex((m) => m.channel === member.channel && m.userId === member.userId);
    const copy = structuredClone(member);
    if (at >= 0) rows[at] = copy; else rows.push(copy);
  }

  /** The guard's question. Synchronous; false for anything not mirrored. */
  isActiveMember(channel: string, userId: string): boolean {
    return this.rows().some((m) => m.channel === channel && ownsRecord(m.userId, userId) && !m.removedAt);
  }

  /** Active members, from the mirror. */
  activeMembers(channel: string): ChatMember[] {
    return this.rows().filter((m) => m.channel === channel && !m.removedAt);
  }

  private async readDurableMembers(channel: string): Promise<ChatMember[]> {
    let pending = this.queuedReads.get(channel);
    if (!pending) {
      if (this.queuedReads.size >= 2048) throw new Error('Membership authority queue is full');
      let resolve!: (rows: ChatMember[]) => void, reject!: (error: unknown) => void;
      pending = new Promise<ChatMember[]>((yes, no) => { resolve = yes; reject = no; });
      this.queuedReads.set(channel, pending);
      const captured = pending;
      setImmediate(() => {
        const read = () => {
          if (this.queuedReads.get(channel) === captured) this.queuedReads.delete(channel);
          // Collected callers predate SDK dispatch, including time waiting
          // for a free transport slot. Later callers get a new snapshot even
          // while this dispatched read remains outstanding.
          return this.persist!.listMembers(channel);
        };
        const failed = (error: unknown) => {
          if (this.queuedReads.get(channel) === captured) this.queuedReads.delete(channel);
          reject(error);
        };
        try { void (this.dispatchRead ? this.dispatchRead(read) : read()).then(resolve, failed); }
        catch (error) { failed(error); }
      });
    }
    return structuredClone(await pending);
  }

  /** Replace the mirror's rows for `channel` with the durable store's. */
  async hydrate(channel: string): Promise<void> {
    if (!this.persist) return;
    const fence = this.observeChanges(channel);
    try {
      const fresh = await this.readDurableMembers(channel);
      if (fence.changed()) return; // A newer successful write owns the mirror.
      const rows = this.rows();
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.channel === channel) rows.splice(i, 1);
      rows.push(...fresh);
      // A read refreshes the synchronous view. Only committed local writes
      // or peer invalidations fence an authority proof already in progress.
    } finally { fence.dispose(); }
  }
}

/**
 * Read cursors whose `social:` rows are `rows()` (the fixture under
 * MOCK_AURORA); every other channel keeps the library's memory store. A cursor
 * only moves forward — the library's own rule (`advance` answers null otherwise).
 */
export class RowsReadReceiptStore implements ChatReadReceiptStore {
  constructor(private readonly rows: () => ChatReadReceipt[]) {}

  async advance(receipt: ChatReadReceipt): Promise<ChatReadReceipt | null> {
    const rows = this.rows();
    const at = rows.findIndex((r) => r.channel === receipt.channel && r.userId === receipt.userId);
    if (at >= 0 && !(receipt.readAt > rows[at]!.readAt)) return null;
    const copy = structuredClone(receipt);
    if (at >= 0) rows[at] = copy; else rows.push(copy);
    return structuredClone(copy);
  }

  async listReceipts(channel: string): Promise<ChatReadReceipt[]> {
    return structuredClone(this.rows().filter((r) => r.channel === channel)).sort((a, b) => b.readAt.localeCompare(a.readAt));
  }

  async deleteReceipt(channel: string, userId: string): Promise<void> {
    const rows = this.rows();
    const at = rows.findIndex((r) => r.channel === channel && r.userId === userId);
    if (at >= 0) rows.splice(at, 1);
  }
}

// ── The conversations index (what GET /api/social/dms reads) ─────────────────

export interface SocialConversationRow {
  channel: string;
  peers: string[];
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageUserId: string | null;
}

export interface SocialConversations {
  /** The user's conversations, newest activity first. */
  listForUser(userId: string): Promise<SocialConversationRow[]>;
  /** Make sure `userId` has a row for `channel` (a DM opened, a channel joined). */
  recordJoin(channel: string, userId: string): Promise<void>;
  /** A `social:dm:` message the library did not index (it only knows `chat:dm:`). */
  recordDmMessage(channel: string, members: string[], message: ChatMessage): Promise<void>;
}

const PREVIEW_MAX = 140;
const preview = (m: ChatMessage | null) => {
  if (!m) return null;
  const flat = (m.deletedAt ? 'Message deleted' : m.message).replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_MAX ? flat.slice(0, PREVIEW_MAX) : flat;
};

/** Memory: a selector over the message rows (contract rule 1 — counted, not kept). */
export function rowsConversations(
  messages: () => ChatMessage[],
  joins: { rows: () => { channel: string; userId: string }[]; add: (channel: string, userId: string) => void } = (() => {
    const own: { channel: string; userId: string }[] = [];
    return { rows: () => own, add: (channel, userId) => { own.push({ channel, userId }); } };
  })(),
): SocialConversations {
  return {
    async listForUser(userId) {
      const channels = new Set<string>();
      for (const m of messages()) {
        const ids = tenantDmMembers(m.channel);
        if (ids?.includes(userId)) channels.add(m.channel);
      }
      // A DM opened but not yet written to still lists (Dynamo's recordJoin row).
      for (const j of joins.rows()) if (j.userId === userId && tenantDmMembers(j.channel)?.includes(userId)) channels.add(j.channel);
      return [...channels].filter((channel) => !namesForeignClone(channel, userId)).map((channel) => {
        const last = latestMessage(messages(), channel);
        return {
          channel,
          peers: tenantDmMembers(channel) ?? [],
          lastMessageAt: last?.timestamp ?? null,
          lastMessagePreview: preview(last),
          lastMessageUserId: last?.userId ?? null,
        };
      }).sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
    },
    async recordJoin(channel, userId) {
      if (!tenantDmMembers(channel)?.includes(userId)) return;
      if (!joins.rows().some((j) => j.channel === channel && j.userId === userId)) joins.add(channel, userId);
    },
    async recordDmMessage() { /* the message row itself is the index */ },
  };
}

// ── The backend ──────────────────────────────────────────────────────────────

/** ChatService hooks this module may add beside the store's own. */
export interface SocialChatHooks {
  onChannelMessage?: (info: { channel: string; members: string[]; message: ChatMessage }) => void;
}

export interface SocialChatBackend {
  kind: 'dynamo' | 'memory';
  chatStore: ChatStore;
  membershipStore: MirroredMembershipStore;
  readReceiptStore: ChatReadReceiptStore;
  pinsStore: ChatPinsStore;
  conversations: SocialConversations;
  /**
   * Everything `chat({...})` takes from the store: the three stores plus the
   * index hooks (Dynamo's `chatOptions`), with `extra` run beside them.
   */
  chatOptions(extra?: SocialChatHooks): Record<string, unknown> & { chatStore: ChatStore; membershipStore: ChatMembershipStore };
  /** Last message on a channel (the directory's preview). */
  lastMessage(channel: string): Promise<ChatMessage | null>;
  /** Recent messages on a channel, oldest first (the DM unread count reads these). */
  recentMessages(channel: string, limit: number): Promise<ChatMessage[]>;
  /** Resolves once the membership mirror holds every directory channel. */
  ready: Promise<void>;
  /** The Dynamo client and table prefix behind a `dynamo` backend, for sibling stores kept in the same
   * namespace (lib/work-graph/sharing.ts `work-sharing`). Absent on the memory backend. */
  dynamo?: { client: { send(command: unknown): Promise<unknown> }; tablePrefix: string };
}

/** The memory backend. Under MOCK_AURORA the `social:` rows are the registered fixtures. */
export function createMemorySocialChatBackend(opts: { fixtures?: boolean } = {}): SocialChatBackend {
  const fixtures = opts.fixtures ?? config.mock.aurora === true;
  const privateMessages: ChatMessage[] = [];
  const privateMembers: ChatMember[] = [];
  const privateReads: ChatReadReceipt[] = [];
  const messages = fixtures ? () => socialChannelMessagesFixture.rows() : () => privateMessages;
  const members = fixtures ? () => socialChannelMembersFixture.rows() : () => privateMembers;
  const chatStore = new RowsChatStore(messages);
  const membershipStore = new MirroredMembershipStore(members, null);
  const readReceiptStore = new RowsReadReceiptStore(fixtures ? () => socialReadCursorsFixture.rows() : () => privateReads);
  const privateJoins: { channel: string; userId: string }[] = [];
  const conversations = rowsConversations(messages, fixtures
    ? { rows: () => socialDmJoinsFixture.rows(), add: (channel, userId) => { socialDmJoinsFixture.rows().push({ channel, userId }); } }
    : { rows: () => privateJoins, add: (channel, userId) => { privateJoins.push({ channel, userId }); } });
  const pinsStore = new MemoryChatPinsStore(fixtures ? {
    rows: () => socialPinsFixture.rows(), now: () => clock.now().getTime(),
  } : {});
  return {
    kind: 'memory',
    chatStore,
    membershipStore,
    readReceiptStore,
    pinsStore,
    conversations,
    chatOptions: (extra = {}) => ({
      chatStore,
      membershipStore,
      readReceiptStore,
      ...(extra.onChannelMessage ? { onChannelMessage: extra.onChannelMessage } : {}),
    }),
    lastMessage: async (channel) => latestMessage(messages(), channel),
    recentMessages: (channel, limit) => chatStore.listMessages(channel, limit),
    ready: Promise.resolve(),
  };
}

let backend: SocialChatBackend | null = null;
let clearCaches: (() => void) | null = null;
let publishPins: ((channel: string) => void) | null = null;
onCloneDmCleanup(() => { clearCaches?.(); });

/** The live backend. Lazily the memory one, so the routes work with the gateway off (and in tests). */
export function socialChat(): SocialChatBackend {
  if (!backend) { backend = createMemorySocialChatBackend(); watchChatForWorkGraph(backend); }
  return backend;
}

const WATCHED = Symbol.for('orgiq.socialWorkGraphWatched');
/**
 * The social work graph hears of a message or a membership change here, at the one seam every writer shares
 * (the ChatService, the REST routes and the call-chat mirror all go through this store instance). The store
 * object is patched in place, once: the ChatService already holds it. The event names the conversation and a
 * cause, never the message (lib/work-graph/social-events.ts).
 */
function watchChatForWorkGraph(next: SocialChatBackend): void {
  // A test double may hand over a partial backend; the graph only listens to what is really a store.
  const store = next.chatStore as (ChatStore & { [WATCHED]?: boolean }) | undefined;
  if (store && typeof store.putMessage === 'function' && !store[WATCHED]) {
    store[WATCHED] = true;
    const put = store.putMessage.bind(store);
    store.putMessage = async (message) => {
      await put(message);
      void noteSocialChatWrite(message.channel, message.id);
      const conversationId = socialConversationOrNull(message.channel);
      if (conversationId) emitSocialWorkGraphEvent({ conversationId, cause: 'message' });
    };
    if (store.updateMessage) {
      const update = store.updateMessage.bind(store);
      store.updateMessage = async (channel, id, patch) => {
        const result = await update(channel, id, patch);
        void noteSocialChatWrite(channel, id);
        const conversationId = socialConversationOrNull(channel);
        if (conversationId) emitSocialWorkGraphEvent({ conversationId, cause: 'message' });
        return result;
      };
    }
  }
  const members = next.membershipStore as (MirroredMembershipStore & { [WATCHED]?: boolean }) | undefined;
  if (members && typeof members.onCommittedWrite === 'function' && !members[WATCHED]) {
    members[WATCHED] = true;
    members.onCommittedWrite(channel => {
      void noteSocialChatWrite(channel);
      const conversationId = socialConversationOrNull(channel);
      if (conversationId) emitSocialWorkGraphEvent({ conversationId, cause: 'membership' });
    });
  }
}

/**
 * Search (docs/user-search-goal.md, S2): a chat write on a Social channel or DM updates the index after it
 * committed — the message, and the conversation row (its members or its last message). Never fails the write.
 */
function noteSocialChatWrite(channel: string, messageId?: string): Promise<void> {
  return import('./search-index/social.js').then(m => m.noteChatWrite(channel, messageId)).catch(() => undefined);
}

/** Wired by attachRealtimeGateway; `null` resets to the lazy memory default. */
export function setSocialChatBackend(next: SocialChatBackend | null, onReset: (() => void) | null = null,
  onPinsChanged: ((channel: string) => void) | null = null): void {
  backend = next;
  if (next) watchChatForWorkGraph(next);
  clearCaches = onReset;
  publishPins = onPinsChanged;
}

/** A durable write has succeeded; a missed live hint is repaired on reload/reconnect. */
export function notifySocialPinsChanged(channel: string): void {
  // The pin rows the index holds for this channel follow the store (a pin, an unpin).
  void import('./search-index/social.js').then(async m => noteSearchWrite(...await m.pinWriteRefs(channel))).catch(() => undefined);
  try { publishPins?.(channel); } catch (error) { console.warn('[social-pins] live refresh failed', error); }
}

let liveAppend: ((message: ChatMessage) => Promise<void>) | null = null;

/** The gateway's live half of a server-side post (its ChatService cache + broadcast); null when the gateway is off. */
export function setThreadLiveAppend(next: ((message: ChatMessage) => Promise<void>) | null): void {
  liveAppend = next;
}

/**
 * A server-side message on a thread (the REST comment write): persisted in the
 * live chat store first — the one store the thread lives in — then handed to
 * the gateway so connected readers and the ChatService's per-channel cache see
 * it. A failed live hand-off is logged; the reload reads the stored row.
 */
export async function postThreadMessage(message: ChatMessage): Promise<void> {
  const chat = socialChat(); await chat.ready;
  await chat.chatStore.putMessage(message);
  try { await liveAppend?.(message); } catch (error) { console.warn('[social-chat] live thread append failed', error); }
}

/**
 * After `POST /api/__mock/reset` / a scenario switch: the fixture rows are
 * rebuilt, but the ChatService keeps a per-channel LRU in front of the store,
 * so a message posted before the reset would still come back from its cache.
 * Drop the caches; the next join reads the (reset) rows.
 */
export function rehydrateMockSocialChat(): void {
  if (!config.mock.aurora) return;
  clearCaches?.();
}

// ── The Dynamo backend (design §4.4, lane S1) ────────────────────────────────
//
// Both store factories live here (audit D3): the memory one above, the
// library's DynamoChatStore below. lib/realtime-gateway.ts only chooses.

const dynamoLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (...args: unknown[]) => console.warn('[realtime-gateway]', ...args),
  error: (...args: unknown[]) => console.error('[realtime-gateway]', ...args),
};

function socialChatClient(cfg: SocialChatConfig): DynamoCommandClient {
  // DynamoDB Local accepts any key; never send the operator's real
  // credentials to a loopback emulator (the comment importer's rule).
  const local = !!cfg.endpoint && process.env['NODE_ENV'] !== 'production';
  // Default 50 is the SDK's own NodeHttpHandler cap. The 2026-10-06 sizing run
  // queued ~1,200 Dynamo requests behind it at every CPU size, so load
  // profiles may raise it explicitly (capacity-sockets evidence); keep-alive
  // stays on (the SDK default, spelled out so a raised cap reuses sockets).
  const maxSockets = Number(process.env['SOCIAL_CHAT_MAX_SOCKETS'] ?? 50);
  if (!Number.isSafeInteger(maxSockets) || maxSockets < 1 || maxSockets > 1024) throw new Error('SOCIAL_CHAT_MAX_SOCKETS must be an integer from 1 to 1024');
  const agent = { keepAlive: true, maxSockets };
  const sdk = new DynamoDBClient({
    region: cfg.region,
    // Stalled replies have a deadline whatever the pool size.
    requestHandler: { httpAgent: agent, httpsAgent: agent,
      connectionTimeout: 2000, requestTimeout: 5000, throwOnRequestTimeout: true },
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    ...(local ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
  });
  // Opt-in only: the dispatch queue regressed the unchanged burst profile.
  return process.env['SOCIAL_DYNAMO_DISPATCH_QUEUE'] === '1' ? new DynamoDispatchQueue(sdk, maxSockets) : sdk;
}

/**
 * The chat backend for `cfg`: the library's DynamoChatStore, or the memory one.
 * Dynamo's membership is mirrored in process for the synchronous guard and
 * hydrated from `chat-members` for every directory channel; under MOCK_AURORA a
 * directory channel with no rows in DynamoDB yet is seeded once from the
 * fixtures, so DynamoDB Local (in-memory, emptied on every restart) opens on
 * the same world as the memory store.
 */
export function createSocialChatBackend(cfg: SocialChatConfig = socialChatConfig(), opts: { client?: DynamoCommandClient } = {}): SocialChatBackend {
  if (cfg.store !== 'dynamo') return createMemorySocialChatBackend();
  const client = opts.client ?? socialChatClient(cfg);
  const store = new DynamoChatStore({ client, tablePrefix: cfg.tablePrefix, logger: dynamoLogger, messageIndexWrites: socialChatIndexWrites() });
  const pinsStore = new DynamoChatPinsStore({ client, tableName: `${cfg.tablePrefix}chat-pins` });
  const mirror: ChatMember[] = [];
  const membershipStore = new MirroredMembershipStore(() => mirror, store.members,
    client instanceof DynamoDispatchQueue ? read => client.dispatchMembershipRead(read) : undefined);
  const conversations: SocialConversations = {
    listForUser: async (userId) => (await store.conversations.listForUser(userId)).filter((r) => !namesForeignClone(r.channel, userId)).map((r) => ({
      channel: r.channel, peers: r.peers, lastMessageAt: r.lastMessageAt || null,
      lastMessagePreview: r.lastMessagePreview || null, lastMessageUserId: r.lastMessageUserId,
    })),
    recordJoin: (channel, userId) => store.conversations.recordJoin(channel, userId),
    recordDmMessage: (channel, members, message) => store.conversations.recordMessage({ channel, members, message }),
  };
  const seedIfEmpty = async (channel: string): Promise<void> => {
    if (!config.mock.aurora || (await store.members.listMembers(channel)).length) return;
    for (const m of socialChannelMembersFixture.rows().filter((r) => r.channel === channel)) await store.members.putMember(m);
    for (const m of socialChannelMessagesFixture.rows().filter((r) => r.channel === channel)) await store.putMessage(m);
  };
  const seedDms = async (): Promise<void> => {
    if (!config.mock.aurora) return;
    const byChannel = new Map<string, ChatMessage[]>();
    for (const m of socialChannelMessagesFixture.rows()) {
      // DMs, and the work-item threads' seeded history (mock/social-channels.ts workThreadMessages).
      if (dmMembers(m.channel) || m.channel.startsWith('orgiq:work:')) byChannel.set(m.channel, [...(byChannel.get(m.channel) ?? []), m]);
    }
    for (const [channel, msgs] of byChannel) {
      if ((await store.listMessages(channel, 1)).length) continue;
      const members = dmMembers(channel);
      for (const m of msgs) {
        await store.putMessage(m);
        if (members) await conversations.recordDmMessage(channel, members, m);
      }
    }
  };
  const ready = (async () => {
    for (const row of await listChannels()) {
      const channel = `${SOCIAL_CHANNEL_PREFIX}${row.slug}`;
      await seedIfEmpty(channel);
      await membershipStore.hydrate(channel);
    }
    await seedDms();
  })().catch((err: unknown) => {
    console.warn(`[realtime-gateway] social chat store did not hydrate (${(err as Error).message}); social channels refuse every subscribe until it does`);
  });
  return {
    kind: 'dynamo',
    chatStore: store,
    membershipStore,
    readReceiptStore: store.reads,
    pinsStore,
    conversations,
    chatOptions: (extra = {}) => {
      const library = store.chatOptions({ onChannelMessage: (info) => extra.onChannelMessage?.(info) });
      return {
        ...library,
        // The library indexes `chat:dm:` names itself; a `social:dm:` DM reaches
        // it as a channel message, so its members (from the name) are indexed
        // here INSTEAD of by the library's channel hook. Both used to run, so
        // every DM send wrote the same two conversation rows twice (4 UpdateItems
        // per send in the 2026-10-06 capacity-real-send profile).
        onChannelMessage(this: unknown, info: Parameters<NonNullable<typeof library.onChannelMessage>>[0]) {
          const ids = tenantDmMembers(info.channel);
          if (!ids) return library.onChannelMessage?.call(this, info);
          void conversations.recordDmMessage(info.channel, ids, info.message).catch(() => undefined);
          extra.onChannelMessage?.(info);
        },
        // A tenant DM's audience is its name: only named members can join it
        // (the guard), and its index rows are written for exactly them. The
        // library's default asks the conversations GSI — one Query per send
        // that could only return those same members.
        channelAudience: (channel: string) => tenantDmMembers(channel) ?? library.channelAudience(channel),
        membershipStore,
      };
    },
    lastMessage: async (channel) => (await store.listMessages(channel, 1))[0] ?? null,
    recentMessages: (channel, limit) => store.listMessages(channel, limit),
    ready,
    dynamo: { client, tablePrefix: cfg.tablePrefix },
  };
}
