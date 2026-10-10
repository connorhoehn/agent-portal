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
  InMemoryChatStore,
  MemoryChatReadReceiptStore,
  MemoryChatPinsStore,
  type ChatPinsStore,
  type ChatMember,
  type ChatMembershipStore,
  type ChatMessage,
  type ChatMessagePatch,
  type ChatReadReceipt,
  type ChatReadReceiptStore,
  type ChatStore,
} from '@connorhoehnslalom/realtime-modules/chat';
import { dmLobbyMembers, dmLobbyName } from '@connorhoehnslalom/realtime-modules/call';
import { config } from '../config.js';
import {
  latestMessage,
  socialChannelMembersFixture,
  socialChannelMessagesFixture,
  socialReadCursorsFixture,
  socialPinsFixture,
} from '../mock/social-channels.js';
import { clock } from '../mock/core/index.js';
import { TENANTS } from './session.js';

// ── Names ────────────────────────────────────────────────────────────────────

export const SOCIAL_CHANNEL_PREFIX = 'social:ch:';
export const SOCIAL_DM_PREFIX = 'social:dm:';
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
  if (!channel.startsWith(SOCIAL_DM_PREFIX)) return null;
  return dmLobbyMembers(channel);
}

/**
 * Any tenant's `<tenant>:dm:<ids>` name → member ids, or null. Indexing only:
 * channel authority stays in tenant-channels.ts / live-principal.ts.
 */
export function tenantDmMembers(channel: string): string[] | null {
  const tenant = channel.split(':', 1)[0];
  if (!(TENANTS as readonly string[]).includes(tenant)) return null;
  if (!channel.startsWith(`${tenant}:dm:`)) return null;
  return dmLobbyMembers(channel);
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

const isSocial = (channel: string) => channel.startsWith('social:');

/**
 * A ChatStore whose `social:` messages are `rows()` (the fixture under
 * MOCK_AURORA) and whose other channels — the assessment document chats,
 * initiative threads — stay in the library's InMemoryChatStore, as before.
 */
export class RowsChatStore implements ChatStore {
  private readonly others = new InMemoryChatStore();
  /** Non-social `<tenant>:dm:` channels that have a message (the conversations index). */
  readonly otherDmChannels = new Set<string>();
  constructor(private readonly rows: () => ChatMessage[]) {}

  async putMessage(message: ChatMessage): Promise<void> {
    if (!isSocial(message.channel)) {
      if (tenantDmMembers(message.channel)) this.otherDmChannels.add(message.channel);
      return this.others.putMessage(message);
    }
    const rows = this.rows();
    const at = rows.findIndex((m) => m.channel === message.channel && m.id === message.id);
    const copy = structuredClone(message);
    if (at >= 0) rows[at] = copy; else rows.push(copy);
  }

  async listMessages(channel: string, limit: number): Promise<ChatMessage[]> {
    if (!isSocial(channel)) return this.others.listMessages(channel, limit);
    const mine = this.rows().filter((m) => m.channel === channel)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return structuredClone(mine.slice(Math.max(0, mine.length - limit)));
  }

  async getMessage(channel: string, messageId: string): Promise<ChatMessage | null> {
    if (!isSocial(channel)) return this.others.getMessage(channel, messageId);
    const message = this.rows().find((m) => m.channel === channel && m.id === messageId);
    return message ? structuredClone(message) : null;
  }

  async updateMessage(channel: string, messageId: string, patch: ChatMessagePatch): Promise<ChatMessage | null> {
    if (!isSocial(channel)) return this.others.updateMessage(channel, messageId, patch);
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
export class MirroredMembershipStore implements ChatMembershipStore {
  private readonly observers = new Map<string, Set<() => void>>();
  private readonly queuedReads = new Map<string, Promise<ChatMember[]>>();
  constructor(private readonly rows: () => ChatMember[], private readonly persist: ChatMembershipStore | null,
    private readonly dispatchRead?: (read: () => Promise<ChatMember[]>) => Promise<ChatMember[]>) {}

  /** Pending-read fence only; no settled positive membership is cached. */
  observeChanges(channel: string): { changed: () => boolean; dispose: () => void } {
    let changed = false; let disposed = false;
    const observer = () => { changed = true; };
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

  async listMembers(channel: string): Promise<ChatMember[]> {
    if (!this.mirrored(channel)) return this.readDurableMembers(channel);
    await this.hydrate(channel);
    return structuredClone(this.rows().filter((m) => m.channel === channel));
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
    const row = this.rows().find((m) => m.channel === channel && m.userId === userId);
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
    return this.rows().some((m) => m.channel === channel && m.userId === userId && !m.removedAt);
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
  private readonly others = new MemoryChatReadReceiptStore();
  constructor(private readonly rows: () => ChatReadReceipt[]) {}

  async advance(receipt: ChatReadReceipt): Promise<ChatReadReceipt | null> {
    if (!isSocial(receipt.channel)) return this.others.advance(receipt);
    const rows = this.rows();
    const at = rows.findIndex((r) => r.channel === receipt.channel && r.userId === receipt.userId);
    if (at >= 0 && !(receipt.readAt > rows[at]!.readAt)) return null;
    const copy = structuredClone(receipt);
    if (at >= 0) rows[at] = copy; else rows.push(copy);
    return structuredClone(copy);
  }

  async listReceipts(channel: string): Promise<ChatReadReceipt[]> {
    if (!isSocial(channel)) return this.others.listReceipts(channel);
    return structuredClone(this.rows().filter((r) => r.channel === channel)).sort((a, b) => b.readAt.localeCompare(a.readAt));
  }

  async deleteReceipt(channel: string, userId: string): Promise<void> {
    if (!isSocial(channel)) return this.others.deleteReceipt(channel, userId);
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
export function rowsConversations(messages: () => ChatMessage[], others?: RowsChatStore): SocialConversations {
  return {
    async listForUser(userId) {
      const extra: SocialConversationRow[] = [];
      for (const channel of others?.otherDmChannels ?? []) {
        const ids = tenantDmMembers(channel);
        if (!ids?.includes(userId)) continue;
        const last = (await others!.listMessages(channel, 1))[0] ?? null;
        extra.push({ channel, peers: ids, lastMessageAt: last?.timestamp ?? null,
          lastMessagePreview: preview(last), lastMessageUserId: last?.userId ?? null });
      }
      const channels = new Set<string>();
      for (const m of messages()) {
        const ids = dmMembers(m.channel);
        if (ids?.includes(userId)) channels.add(m.channel);
      }
      return [...extra, ...[...channels].map((channel) => {
        const last = latestMessage(messages(), channel);
        return {
          channel,
          peers: dmMembers(channel) ?? [],
          lastMessageAt: last?.timestamp ?? null,
          lastMessagePreview: preview(last),
          lastMessageUserId: last?.userId ?? null,
        };
      })].sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
    },
    async recordJoin() { /* the rows are the index; a DM with no message lists once it has one */ },
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
  const conversations = rowsConversations(messages, chatStore);
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

/** The live backend. Lazily the memory one, so the routes work with the gateway off (and in tests). */
export function socialChat(): SocialChatBackend {
  if (!backend) backend = createMemorySocialChatBackend();
  return backend;
}

/** Wired by attachRealtimeGateway; `null` resets to the lazy memory default. */
export function setSocialChatBackend(next: SocialChatBackend | null, onReset: (() => void) | null = null,
  onPinsChanged: ((channel: string) => void) | null = null): void {
  backend = next;
  clearCaches = onReset;
  publishPins = onPinsChanged;
}

/** A durable write has succeeded; a missed live hint is repaired on reload/reconnect. */
export function notifySocialPinsChanged(channel: string): void {
  try { publishPins?.(channel); } catch (error) { console.warn('[social-pins] live refresh failed', error); }
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
