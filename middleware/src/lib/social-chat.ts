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
// Membership is also a SYNCHRONOUS question: the router's `authorize` hook
// (the gateway's channelGuard) cannot await, and it must refuse a
// `social:ch:<slug>` subscribe/publish by a non-member. So `social:ch:` member
// rows are mirrored in process (`MirroredMembershipStore`): every write goes
// through the mirror and on to the durable store, and the Dynamo backend
// hydrates the mirror from `chat-members` for every directory channel at
// attach. One task only — a second replica's membership writes would not reach
// this mirror (the same single-process caveat the router already carries).
//
// The channel DIRECTORY (name, description, privacy) is not chat state; it is
// providers/social-channels.ts (Aurora `social_channels`, the fixture under
// MOCK_AURORA).

import {
  InMemoryChatStore,
  MemoryChatReadReceiptStore,
  type ChatMember,
  type ChatMembershipStore,
  type ChatMessage,
  type ChatMessagePatch,
  type ChatReadReceipt,
  type ChatReadReceiptStore,
  type ChatStore,
} from '@connorhoehnslalom/realtime-modules/chat';
import { config } from '../config.js';
import {
  latestMessage,
  socialChannelMembersFixture,
  socialChannelMessagesFixture,
  socialReadCursorsFixture,
} from '../mock/social-channels.js';

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

/** The DM lobby for a set of users: `social:dm:<sorted, deduped ids>`. */
export function dmChannelFor(userIds: readonly string[]): string {
  const ids = [...new Set(userIds.filter(Boolean))].sort();
  if (ids.length < 2) throw new Error('a DM needs two different people');
  for (const id of ids) if (id.includes(':')) throw new Error(`user id may not contain ':' (${id})`);
  return `${SOCIAL_DM_PREFIX}${ids.join(':')}`;
}

/** `social:dm:<a>:<b>…` → member ids, or null. */
export function dmMembers(channel: string): string[] | null {
  if (!channel.startsWith(SOCIAL_DM_PREFIX)) return null;
  const ids = channel.slice(SOCIAL_DM_PREFIX.length).split(':').filter(Boolean);
  return ids.length >= 2 ? ids : null;
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
  constructor(private readonly rows: () => ChatMessage[]) {}

  async putMessage(message: ChatMessage): Promise<void> {
    if (!isSocial(message.channel)) return this.others.putMessage(message);
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

  async updateMessage(channel: string, messageId: string, patch: ChatMessagePatch): Promise<ChatMessage | null> {
    if (!isSocial(channel)) return this.others.updateMessage(channel, messageId, patch);
    const row = this.rows().find((m) => m.channel === channel && m.id === messageId);
    if (!row) return null;
    Object.assign(row, structuredClone(patch));
    return structuredClone(row);
  }
}

/**
 * Membership with a synchronous in-process view of every `social:ch:`
 * channel (see the header). `rows()` is the mirror; `persist` the durable
 * store (Dynamo's `chat-members`), or null when the rows ARE the store.
 */
export class MirroredMembershipStore implements ChatMembershipStore {
  constructor(private readonly rows: () => ChatMember[], private readonly persist: ChatMembershipStore | null) {}

  private mirrored(channel: string): boolean {
    return !this.persist || channel.startsWith(SOCIAL_CHANNEL_PREFIX);
  }

  async listMembers(channel: string): Promise<ChatMember[]> {
    if (!this.mirrored(channel)) return this.persist!.listMembers(channel);
    return structuredClone(this.rows().filter((m) => m.channel === channel));
  }

  async getMember(channel: string, userId: string): Promise<ChatMember | null> {
    if (!this.mirrored(channel)) return this.persist!.getMember(channel, userId);
    const row = this.rows().find((m) => m.channel === channel && m.userId === userId);
    return row ? structuredClone(row) : null;
  }

  async putMember(member: ChatMember): Promise<void> {
    // Durable first: a write the store refused must not be believed here.
    if (this.persist) await this.persist.putMember(member);
    if (!this.mirrored(member.channel)) return;
    this.upsert(member);
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

  /** Replace the mirror's rows for `channel` with the durable store's. */
  async hydrate(channel: string): Promise<void> {
    if (!this.persist) return;
    const fresh = await this.persist.listMembers(channel);
    const rows = this.rows();
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.channel === channel) rows.splice(i, 1);
    rows.push(...fresh);
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
export function rowsConversations(messages: () => ChatMessage[]): SocialConversations {
  return {
    async listForUser(userId) {
      const channels = new Set<string>();
      for (const m of messages()) {
        const ids = dmMembers(m.channel);
        if (ids?.includes(userId)) channels.add(m.channel);
      }
      return [...channels].map((channel) => {
        const last = latestMessage(messages(), channel);
        return {
          channel,
          peers: dmMembers(channel) ?? [],
          lastMessageAt: last?.timestamp ?? null,
          lastMessagePreview: preview(last),
          lastMessageUserId: last?.userId ?? null,
        };
      }).sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
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
  const conversations = rowsConversations(messages);
  return {
    kind: 'memory',
    chatStore,
    membershipStore,
    readReceiptStore,
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

/** The live backend. Lazily the memory one, so the routes work with the gateway off (and in tests). */
export function socialChat(): SocialChatBackend {
  if (!backend) backend = createMemorySocialChatBackend();
  return backend;
}

/** Wired by attachRealtimeGateway; `null` resets to the lazy memory default. */
export function setSocialChatBackend(next: SocialChatBackend | null, onReset: (() => void) | null = null): void {
  backend = next;
  clearCaches = onReset;
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
