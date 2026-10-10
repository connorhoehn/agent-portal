// Bounded application state for call chat: who is a member of a huddle and
// from when they may read it. Messages themselves are ordinary gateway chat
// on `orgiq:huddle:<callId>` (the library ChatService and its ChatStore); this
// state is the membership mirror the chat service reads through
// HuddleMembershipStore (call-chat.ts), never a second message store.
import { AppError } from './async-handler.js';
import type { CallPageRedis } from './call-pages.js';

/** `historyFrom`: ISO join boundary; the chat service shows strictly later messages. */
export interface CallChatMember { historyFrom: string; active: boolean }
export interface CallChatState { revision: number; ended: boolean; members: Record<string, CallChatMember> }
export interface CallChatStateStore {
  get(callId: string): Promise<CallChatState>;
  /** `preserveHistory`: a reconnect or another actual seat keeps the existing boundary. */
  join(callId: string, userId: string, now: string, preserveHistory: boolean): Promise<CallChatState>;
  leave(callId: string, userId: string): Promise<CallChatState>;
  finish(callId: string): Promise<CallChatState>;
  keepAlive(callId: string): Promise<void>;
  dispose?(): void;
}
const empty = (): CallChatState => ({ revision: 0, ended: false, members: {} });
const clone = <T>(value: T): T => structuredClone(value);
const MAX_MEMBERS = 512;
const TTL_SECONDS = 4 * 60 * 60;
const active = (state: CallChatState) => { if (state.ended) throw new AppError(404, 'Call conversation has ended'); };

export class MemoryCallChatStateStore implements CallChatStateStore {
  private readonly states = new Map<string, { state: CallChatState; until: number }>();
  private readonly sweep: ReturnType<typeof setInterval>;
  constructor(private readonly ttlSeconds = TTL_SECONDS, private readonly now = Date.now) {
    this.sweep = setInterval(() => this.prune(), 60_000); this.sweep.unref?.();
  }
  private prune() { for (const [key, row] of this.states) if (row.until <= this.now()) this.states.delete(key); }
  private read(callId: string) { this.prune(); return this.states.get(callId)?.state ?? empty(); }
  private save(callId: string, state: CallChatState) {
    this.states.set(callId, { state, until: this.now() + this.ttlSeconds * 1000 }); return clone(state);
  }
  async get(callId: string) {
    const value = this.read(callId);
    return this.states.has(callId) ? this.save(callId, value) : clone(value);
  }
  async join(callId: string, userId: string, now: string, preserveHistory: boolean) {
    const state = this.read(callId); active(state);
    // Membership TTL is shorter than durable message retention. Expired state
    // starts from an empty roster, so every later joiner gets a fresh boundary
    // and an older transcript under a reused call id stays before it.
    const old = Object.hasOwn(state.members, userId) ? state.members[userId] : undefined;
    if (!old && Object.keys(state.members).length >= MAX_MEMBERS) throw new AppError(409, 'Call conversation membership limit reached');
    if (!old || !old.active || !preserveHistory) {
      state.members = { ...state.members, [userId]: { historyFrom: old && preserveHistory ? old.historyFrom : now, active: true } };
      state.revision += 1;
    }
    return this.save(callId, state);
  }
  async leave(callId: string, userId: string) {
    const state = this.read(callId); const member = Object.hasOwn(state.members, userId) ? state.members[userId] : undefined;
    if (member?.active) { member.active = false; state.revision += 1; }
    return this.save(callId, state);
  }
  async finish(callId: string) {
    const state = this.read(callId);
    if (!state.ended) { state.ended = true; state.revision += 1; state.members = {}; }
    return this.save(callId, state);
  }
  async keepAlive(callId: string) { await this.get(callId); }
  dispose() { clearInterval(this.sweep); }
}

const READ = `local s=redis.call('GET',KEYS[1]); if s then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return s`;
const UPDATE = `
local raw=redis.call('GET',KEYS[1])
local s={revision=0,ended=false,members={}}
if raw then s=cjson.decode(raw) end
local action=ARGV[1]; local uid=ARGV[2]
if action=='finish' then
  if not s.ended then s.ended=true; s.revision=s.revision+1; s.members={} end
elseif action=='join' then
  if s.ended then return {0,'ended'} end
  local old=s.members[uid]
  if not old then
    local count=0; for _ in pairs(s.members) do count=count+1 end
    if count>=tonumber(ARGV[6]) then return {0,'limit'} end
  end
  if not old or not old.active or ARGV[4]~='1' then
    local floor=ARGV[3]; if old and ARGV[4]=='1' then floor=old.historyFrom end
    s.members[uid]={historyFrom=floor,active=true}; s.revision=s.revision+1
  end
elseif action=='leave' then
  local old=s.members[uid]; if old and old.active then old.active=false; s.revision=s.revision+1 end
end
local encoded=cjson.encode(s); redis.call('SET',KEYS[1],encoded,'EX',ARGV[5]); return {1,encoded}
`;
const KEEP_ALIVE = `local raw=redis.call('GET',KEYS[1]); if not raw or cjson.decode(raw).ended then return 0 end
redis.call('EXPIRE',KEYS[1],ARGV[1]); return 1`;
export class RedisCallChatStateStore implements CallChatStateStore {
  constructor(private readonly redis: CallPageRedis, private readonly ttlSeconds = TTL_SECONDS) {}
  private key(callId: string) { return `orgiq:call-chat:${encodeURIComponent(callId)}`; }
  private decode(raw: unknown): CallChatState {
    if (raw === null) return empty();
    const parsed = JSON.parse(String(raw)) as CallChatState;
    // Lua encodes an empty table as []; normalize that harmless representation.
    if (Array.isArray(parsed.members) && parsed.members.length === 0) parsed.members = {};
    return { revision: parsed.revision, ended: parsed.ended, members: parsed.members };
  }
  async get(callId: string) { return this.decode(await this.redis.command('EVAL', READ, 1, this.key(callId), this.ttlSeconds)); }
  private async update(callId: string, action: string, userId = '', now = '', preserveHistory = false) {
    const [ok, raw] = await this.redis.command('EVAL', UPDATE, 1, this.key(callId), action, userId, now,
      preserveHistory ? '1' : '0', this.ttlSeconds, MAX_MEMBERS) as [number, string];
    if (!Number(ok)) throw new AppError(raw === 'ended' ? 404 : 409, raw === 'ended' ? 'Call conversation has ended' : 'Call conversation membership limit reached');
    return this.decode(raw);
  }
  join(callId: string, userId: string, now: string, preserveHistory: boolean) { return this.update(callId, 'join', userId, now, preserveHistory); }
  leave(callId: string, userId: string) { return this.update(callId, 'leave', userId); }
  finish(callId: string) { return this.update(callId, 'finish'); }
  async keepAlive(callId: string) { await this.redis.command('EVAL', KEEP_ALIVE, 1, this.key(callId), this.ttlSeconds); }
}
