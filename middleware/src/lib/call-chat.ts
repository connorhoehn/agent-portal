// A huddle is a call-scoped conversation, never the initiative's Discussion
// or the invite lobby. Its messages are ordinary gateway chat on
// `orgiq:huddle:<callId>` (the library ChatService, its ChatStore, reactions,
// read receipts and typing); this module is only the authority around them:
//   - the membership mirror (`registered`/`removed`/`restored`/`finish`,
//     driven by call-store mutations through observeCallPageLifecycle);
//   - `assertSeat`, the gateway's channel authority for one connection, and
//     `assertMember`, the same authority for a session (REST callers);
//   - `memberRows`, the chat service's membership store for the namespace
//     (join boundary as `historyFrom`, departed members removed);
//   - the send contract the library does not own lives beside it in
//     call-chat-send.ts (`withHuddleChat`);
//   - `filterFrame`, which resolves page references per reader;
//   - `get`, the resolver behind GET /api/calls/:callId/chat.
// A meeting room's chat (`orgiq:huddle:<callId>~breakout~<roomId>`,
// docs/meeting-rooms-app-goal.md decision 1) is the same call's huddle, scoped
// to the room: its members are the call's current members who are in that
// room now (the meeting's own rule, `meetingRoom`), sends carry the same
// contract, and the call's terminal cleanup finishes it with the huddle.
import type { ChatMember, ChatMembershipStore, ChatMessage, ChatStore } from '@connorhoehn/realtime-modules/chat';
import type { ActiveCallStateView } from '@connorhoehn/realtime-modules/call';
import { breakoutChannel, breakoutLobbyName, parseBreakoutChannel } from '@connorhoehn/realtime-modules/meeting';
import { AppError } from './async-handler.js';
import { activeCallParticipant, callProvenance, connectedCallSession as connectedAnyCallSession, resolveConnectedCallSession as resolveAnyCallSession,
  currentCallChatGrant, currentCallAuthority, huddleLobbyTenant, HUDDLE_CHAT_TENANTS,
  type CallAccessOptions, type CallAuthority } from './call-access.js';
import type { RealtimeRouter } from '@connorhoehn/realtime-modules/server';
import { canonicalCallPage, type CallPageDescriptor, type CanonicalCallPage, type CallLifecycleObserver } from './call-pages.js';
import { dmPageDescriptor } from './dm-page-references.js';
import { huddleCallId } from './live-principal.js';
import { NOVA_USER_ID, parseAssistantMetadata } from './meeting-assistant/chat-types.js';
import type { Session } from './session.js';
import type { CallChatStateStore, CallChatState, CallChatMember } from './call-chat-state.js';
import { invalidateChannel } from './gateway/authority-invalidation.js';

export const CALL_CHAT_PREFIX = 'orgiq:huddle:';
/** Also reserves malformed variants, so they cannot fall through tenant auth. */
export function inCallChatNamespace(channel: string): boolean { return channel === 'orgiq:huddle' || channel.startsWith(CALL_CHAT_PREFIX); }
export function callChatChannel(callId: string): string { return `${CALL_CHAT_PREFIX}${callId}`; }
/** Room `roomId`'s chat in call `callId`'s huddle. */
export function roomChatChannel(callId: string, roomId: string): string { return breakoutChannel(callChatChannel(callId), roomId); }
/** A bare huddle chat name → its call and, for a meeting room's chat, the room; null for anything else (a room of a room included). */
export function huddleChatOf(channel: string): { callId: string; roomId: string | null } | null {
  const room = parseBreakoutChannel(channel);
  const callId = huddleCallId(room ? room.base : channel);
  return callId ? { callId, roomId: room?.roomId ?? null } : null;
}
// The namespace keeps its `orgiq:` name for every huddle; an assessment team
// page's huddle (`assessment:team:<id>`) and Social calls have one too. Seats resolve in each
// tenant, and activeCallParticipant pins each to its lobby's tenant.
const connectedCallSession = (router: RealtimeRouter, clientId: string) => connectedAnyCallSession(router, clientId, HUDDLE_CHAT_TENANTS);
const resolveConnectedCallSession = (router: RealtimeRouter, clientId: string) => resolveAnyCallSession(router, clientId, HUDDLE_CHAT_TENANTS);
/** A settled result's value, or its rejection rethrown (the first in input order wins, as a loop's would). */
function settled<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}
const huddleAuthority = (session: Session) => currentCallAuthority(session, HUDDLE_CHAT_TENANTS);
/** Does this lobby's call carry a huddle conversation? (Not document/pipelines calls.) */
const huddleLobby = (lobbyName: string) => huddleLobbyTenant(lobbyName) !== null && !inCallChatNamespace(lobbyName);
export interface CallChatPeer { userId: string; displayName: string }
export interface CallChatSnapshot {
  callId: string; channel: string; revision: number; participants: CallChatPeer[];
  messages: ChatMessage[]; canSend: boolean; historyFrom: string;
}
export type CallChatPageReference = ({ status: 'available' } & CanonicalCallPage) | ({ status: 'unavailable' } & CallPageDescriptor);
interface Seat { clientId: string; session: Session; authority: CallAuthority }
interface CheckedSeats { seats: Seat[]; generation: number }
interface Control { generation: number; ended: boolean; departed: Set<string>; seats: Map<string, number>; users: Map<string, string>;
  lobbyName: string | null; provenance: Map<string, string>; until: number;
  /** Meeting rooms whose chat this call has admitted someone to: finished with the huddle. */
  rooms: Set<string>;
  /** The seat the last registration fully reconciled, at the generation it ended on. */
  reconciled?: { clientId: string; generation: number; seat: number } }
class CallMembershipChanged extends AppError {
  constructor() { super(409, 'Call membership changed. Refresh the conversation.'); }
}
export interface CallChatRuntimeOptions extends CallAccessOptions {
  state: CallChatStateStore; messages: ChatStore;
  canonical?: typeof canonicalCallPage;
  grant?: typeof currentCallChatGrant;
  now?: () => number;
  maintenanceIntervalMs?: number;
  /**
   * Is `userId` in this meeting room now (`<call lobby>~breakout~<roomId>`):
   * its members and the meeting's organizers, or anyone while rooms are
   * self-select (lib/gateway/authority.ts `admitMeetingRoomSync`). Absent:
   * no room chat at all.
   */
  meetingRoom?: (userId: string, roomLobby: string) => boolean;
}
const clone = <T>(value: T): T => structuredClone(value);
/** What a huddle message may carry. Anything else is dropped on send and never rendered. */
export const METADATA_KEYS = ['displayName', 'clientDeliveryId', 'replyTo', 'attachments', 'summaryOf'] as const;
const REST_CLIENT = /^(http|rest:[a-z-]+)$/;
const NOT_JOINED = 'Join this call before opening its conversation';
const NOT_IN_ROOM = 'Join this breakout room before opening its conversation';
/** A removed row for nobody: keeps the namespace closed when there is no current roster. */
const closedRow = (channel: string): ChatMember => ({ channel, userId: '', role: 'member', addedBy: '', addedAt: new Date(0).toISOString(),
  historyFrom: new Date(0).toISOString(), removedAt: new Date(0).toISOString() });

export class CallChatRuntime implements CallLifecycleObserver {
  private readonly controls = new Map<string, Control>();
  private readonly maintenance: ReturnType<typeof setInterval> | null;
  private disposed = false;
  constructor(private readonly opts: CallChatRuntimeOptions) {
    const interval = opts.maintenanceIntervalMs ?? 60_000;
    this.maintenance = interval > 0 ? setInterval(() => {
      for (const [id, control] of this.controls) {
        if (control.until <= this.now()) { this.controls.delete(id); continue; }
        if (!control.ended) void this.reconcile(id, true).then(() => this.opts.state.keepAlive(id)).catch(() => undefined);
      }
    }, interval) : null;
    this.maintenance?.unref?.();
  }
  get messages(): ChatStore { return this.opts.messages; }
  private now() { return (this.opts.now ?? Date.now)(); }
  private control(callId: string): Control {
    let control = this.controls.get(callId);
    if (!control || control.until <= this.now()) {
      control = { generation: 0, ended: false, departed: new Set(), seats: new Map(), users: new Map(),
        lobbyName: null, provenance: new Map(), until: 0, rooms: new Set() };
      this.controls.set(callId, control);
    }
    control.until = this.now() + 4 * 60 * 60 * 1000;
    return control;
  }
  private check(callId: string) {
    if (this.disposed || this.control(callId).ended) throw new AppError(404, 'Call conversation has ended');
  }
  private fence(callId: string, generation: number) {
    this.check(callId);
    if (this.control(callId).generation !== generation) throw new CallMembershipChanged();
  }
  private async lifecycle(work: () => Promise<void>) {
    try { await work(); }
    catch (error) {
      // A newer lifecycle callback owns reconciliation. The stale operation
      // stays fenced; HTTP reads still receive the actionable conflict.
      if (!(error instanceof CallMembershipChanged)) throw error;
    }
  }
  private grant = (session: Session, authority: CallAuthority, action: 'ViewSocial' | 'PostMessage', lobbyName: string) =>
    (this.opts.grant ?? currentCallChatGrant)(session, authority, action, lobbyName);
  private async participant(callId: string, session: Session, write = false) {
    this.check(callId);
    const result = await activeCallParticipant(this.opts, callId, session);
    // The grant and the call/state reads do not depend on each other, and the
    // latest re-read below follows all of them, so they run together; a
    // refused grant still wins over what the reads found.
    const [granted, currentRead, stateRead] = await Promise.allSettled([
      (async () => await this.grant(session, result.authority, 'ViewSocial', result.call.lobbyName)
        && (!write || await this.grant(session, result.authority, 'PostMessage', result.call.lobbyName)))(),
      this.opts.calls.getCall(callId),
      this.opts.state.get(callId),
    ]);
    if (settled(granted) !== true) throw new AppError(403, 'This call is no longer available to your current session');
    const current = settled(currentRead); this.check(callId);
    if (!current) throw new AppError(404, 'Call is no longer active');
    const state = settled(stateRead); this.check(callId);
    if (state.ended) throw new AppError(404, 'Call conversation has ended');
    const provenance = callProvenance(session);
    const connections = await Promise.all(current.participantClientIds.map(id => resolveConnectedCallSession(this.opts.router, id)));
    const clientIds = current.participantClientIds.filter((id, index) => !this.control(callId).departed.has(id)
      && connections[index] && callProvenance(connections[index]!) === provenance);
    if (!clientIds.length || current.lobbyName !== result.call.lobbyName) throw new AppError(403, NOT_JOINED);
    // Policy/resource and connection reads can outlive a host-grant revoke,
    // epoch change, or departure. Re-read the signed authority and seat after
    // them; no positive result from the first lookup owns this final check.
    const latest = await activeCallParticipant(this.opts, callId, session); this.check(callId);
    if (latest.call.lobbyName !== current.lobbyName) throw new AppError(403, NOT_JOINED);
    if (!await this.grant(session, latest.authority, 'ViewSocial', latest.call.lobbyName)
      || (write && !await this.grant(session, latest.authority, 'PostMessage', latest.call.lobbyName))) {
      throw new AppError(403, 'This call is no longer available to your current session');
    }
    const finalAuthority = await (this.opts.authority ?? huddleAuthority)(session); this.check(callId);
    const admittedIds = clientIds.filter(id => latest.clientIds.includes(id) && !this.control(callId).departed.has(id));
    if (!admittedIds.length) throw new AppError(403, NOT_JOINED);
    const control = this.control(callId); control.lobbyName = latest.call.lobbyName;
    for (const id of admittedIds) control.provenance.set(id, provenance);
    return { ...latest, authority: finalAuthority, clientIds: admittedIds, state };
  }
  private async seats(callId: string): Promise<Seat[]> {
    this.check(callId);
    const call = await this.opts.calls.getCall(callId); this.check(callId);
    if (!call) throw new AppError(404, 'Call is no longer active');
    if (!huddleLobby(call.lobbyName)) throw new AppError(403, 'This call cannot open a huddle conversation');
    // Every seat is checked at once: each check is its own fresh read, and
    // reads queued together share one directory query instead of one each.
    const checked = await Promise.allSettled(call.participantClientIds.map(async (clientId): Promise<Seat | null> => {
      const session = await resolveConnectedCallSession(this.opts.router, clientId);
      if (!session || this.control(callId).departed.has(clientId)) return null;
      try {
        const result = await this.participant(callId, session);
        return result.clientIds.includes(clientId) ? { clientId, session, authority: result.authority } : null;
      } catch (error) {
        if (!(error instanceof AppError) || error.status >= 500) throw error;
        return null;
      }
    }));
    return checked.map(settled).filter((seat): seat is Seat => seat !== null);
  }
  private peers(seats: Seat[]): CallChatPeer[] {
    return [...new Map(seats.map(seat => [seat.session.sub, { userId: seat.session.sub, displayName: seat.authority.displayName }])).values()]
      .sort((a, b) => a.userId.localeCompare(b.userId));
  }
  /**
   * Immediately revoke the departing connection, before the asynchronous store
   * write: later channel checks for it deny, a check already in flight is
   * fenced by its seat epoch, and its chat/reaction subscriptions are removed
   * (the router does not re-ask a subscription it already holds).
   */
  invalidate(callId: string, clientId?: string) {
    const control = this.controls.get(callId);
    if (!control) return;
    control.generation += 1;
    // The seat is gone now: no cached verdict on the huddle may outlive it.
    invalidateChannel(callChatChannel(callId), 'huddle-seat');
    if (clientId) {
      control.departed.add(clientId);
      control.seats.set(clientId, (control.seats.get(clientId) ?? 0) + 1);
      const session = connectedCallSession(this.opts.router, clientId);
      if (session) control.users.set(clientId, session.sub);
      for (const channel of this.chatChannels(callId)) {
        void Promise.resolve(this.opts.router.unsubscribeFromChannel?.(clientId, channel)).catch(() => undefined);
      }
    }
  }
  /** Every router channel of this call's conversation: the huddle and each room's chat, with their reactions. */
  private chatChannels(callId: string): string[] {
    const names = [callChatChannel(callId), ...[...(this.controls.get(callId)?.rooms ?? [])].map(roomId => roomChatChannel(callId, roomId))];
    return names.flatMap(name => [name, `reactions:${name}`]);
  }
  /**
   * Is `userId` in room `roomId` of this live huddle call now? Asked of the
   * meeting on the call's stored lobby, never a name the client supplied.
   */
  private async inRoom(callId: string, roomId: string, userId: string): Promise<boolean> {
    if (!userId || !this.opts.meetingRoom) return false;
    this.check(callId);
    const call = await this.opts.calls.getCall(callId); this.check(callId);
    if (!call || !huddleLobby(call.lobbyName) || !this.opts.meetingRoom(userId, breakoutLobbyName(call.lobbyName, roomId))) return false;
    this.control(callId).rooms.add(roomId);
    return true;
  }
  async registered(callId: string, clientId: string, preserveHistory = false) {
    // A call's first join registers its seat, then claims it: the claim's
    // registration (history preserved) right after the first one's full
    // reconciliation repeats checks that just passed. Anything in between (a
    // departure, a restore, another seat's registration) moves the generation.
    const control = this.controls.get(callId); const done = control?.reconciled;
    if (preserveHistory && done && control && done.clientId === clientId && done.generation === control.generation
      && done.seat === (control.seats.get(clientId) ?? 0) && !control.departed.has(clientId) && !control.ended) return;
    return this.lifecycle(() => this.registeredCurrent(callId, clientId, preserveHistory));
  }
  private async registeredCurrent(callId: string, clientId: string, preserveHistory: boolean) {
    const call = await this.opts.calls.getCall(callId);
    // The shared call store also owns Social/document/pipelines calls. They do
    // not acquire a huddle conversation during registration or recovery.
    if (call && !huddleLobby(call.lobbyName)) return;
    this.check(callId);
    if (!call?.participantClientIds.includes(clientId)) return;
    const control = this.control(callId); control.departed.delete(clientId); control.generation += 1;
    control.seats.set(clientId, (control.seats.get(clientId) ?? 0) + 1);
    invalidateChannel(callChatChannel(callId), 'huddle-seat');
    const session = await resolveConnectedCallSession(this.opts.router, clientId);
    if (session) control.users.set(clientId, session.sub);
    // Explicit admission resets this person's floor even if a delayed old
    // reconciliation restored an active flag after their final seat left.
    // Another actual seat (or public atomic resume) preserves their history.
    const others = session ? await Promise.all(call.participantClientIds.map(id => resolveConnectedCallSession(this.opts.router, id))) : [];
    const anotherSeat = session && call.participantClientIds.some((id, index) => id !== clientId && !control.departed.has(id)
      && others[index] && callProvenance(others[index]!) === callProvenance(session));
    // That reset is this seat's join inside the reconcile, under the same
    // check every seat gets right before its join.
    const reset = session && !preserveHistory && !anotherSeat ? clientId : undefined;
    const generation = control.generation;
    const known = await this.reconcile(callId, true, reset);
    if (control.generation === generation) control.reconciled = { clientId, generation, seat: control.seats.get(clientId) ?? 0 };
    // The roster notice is not part of the seat: membership is settled above,
    // and every delivery is re-derived for its recipient (filterFrame).
    void this.lifecycle(() => this.broadcastMembers(callId, known))
      .catch(error => console.warn('[call-chat] roster broadcast failed', error));
  }
  async removed(callId: string, clientId: string) {
    const call = await this.opts.calls.getCall(callId);
    // The library may remove the final old socket after terminal cleanup.
    // That callback cannot change a finished conversation or reopen its floor.
    if (this.disposed || this.controls.get(callId)?.ended) return;
    if ((call && !huddleLobby(call.lobbyName)) || (!call && !this.controls.has(callId))) return;
    this.check(callId);
    const userId = this.control(callId).users.get(clientId);
    // Zero seats may be recoverable. Retain the floors.
    const ids = call?.participantClientIds ?? [];
    const connections = await Promise.all(ids.map(id => resolveConnectedCallSession(this.opts.router, id)));
    if (userId && !ids.some((id, index) => !this.control(callId).departed.has(id)
      && connections[index]?.sub === userId)) await this.opts.state.leave(callId, userId);
    invalidateChannel(callChatChannel(callId), 'huddle-seat');
    if (call?.participantClientIds.length) await this.broadcastMembers(callId);
  }
  async restored(callId: string, call: ActiveCallStateView) {
    return this.lifecycle(() => this.restoredCurrent(callId, call));
  }
  private async restoredCurrent(callId: string, call: ActiveCallStateView) {
    if (!huddleLobby(call.lobbyName)) return;
    this.check(callId); const control = this.control(callId); control.generation += 1;
    invalidateChannel(callChatChannel(callId), 'huddle-seat');
    for (const id of call.participantClientIds) {
      control.departed.delete(id);
      const session = await resolveConnectedCallSession(this.opts.router, id); if (session) control.users.set(id, session.sub);
    }
    await this.broadcastMembers(callId, await this.reconcile(callId, true));
  }
  /**
   * Every connected seat checked once, right before its own join (an atomic
   * update), all seats together; members with no passing seat leave. `reset`
   * is a seat whose person's history floor starts now (an explicit join). The
   * seats it checked come back with their generation, for the broadcast.
   */
  private async reconcile(callId: string, preserveHistory: boolean, reset?: string): Promise<CheckedSeats> {
    const generation = this.control(callId).generation;
    this.check(callId);
    const call = await this.opts.calls.getCall(callId); this.check(callId);
    if (!call) throw new AppError(404, 'Call is no longer active');
    if (!huddleLobby(call.lobbyName)) throw new AppError(403, 'This call cannot open a huddle conversation');
    const state = await this.opts.state.get(callId); this.fence(callId, generation);
    const checked = await Promise.allSettled(call.participantClientIds.map(async (clientId): Promise<Seat | null> => {
      const session = await resolveConnectedCallSession(this.opts.router, clientId);
      if (!session || this.control(callId).departed.has(clientId)) return null;
      let result: Awaited<ReturnType<CallChatRuntime['participant']>>;
      try { result = await this.participant(callId, session); }
      catch (error) { if (!(error instanceof AppError) || error.status >= 500) throw error; return null; }
      this.fence(callId, generation);
      if (!result.clientIds.includes(clientId)) return null;
      await this.opts.state.join(callId, session.sub, new Date(this.now()).toISOString(), preserveHistory && clientId !== reset);
      this.fence(callId, generation);
      this.control(callId).users.set(clientId, session.sub);
      return { clientId, session, authority: result.authority };
    }));
    const seats = checked.map(settled).filter((seat): seat is Seat => seat !== null);
    const users = new Set(seats.map(seat => seat.session.sub));
    for (const [userId, member] of Object.entries(state.members)) {
      if (member.active && !users.has(userId)) {
        this.fence(callId, generation); await this.opts.state.leave(callId, userId);
        invalidateChannel(callChatChannel(callId), 'huddle-seat');
      }
    }
    return { seats, generation };
  }
  /** Initiative/work page references belong to OrgIQ huddles; an assessment huddle carries none. */
  async pageReferencesAllowed(callId: string): Promise<boolean> {
    const call = await this.opts.calls.getCall(callId);
    return !!call && huddleLobbyTenant(call.lobbyName) === 'orgiq';
  }
  /** One reader's view of a stored message: allowlisted metadata, the page reference resolved now. */
  async render(callId: string, message: ChatMessage, pages = new Map<string, Promise<CallChatPageReference>>(),
    channel = callChatChannel(callId)): Promise<ChatMessage> {
    const metadata: Record<string, unknown> = {};
    for (const key of METADATA_KEYS) if (message.metadata?.[key] !== undefined) metadata[key] = clone(message.metadata[key]);
    // The meeting assistant's kinds are shown only on a message its fixed identity authored: a person's message
    // that carries `assistant` or `assistant-…` keys never reaches a reader with them (call-chat-send.ts refuses
    // them on the way in; this is the second lock, on the way out).
    const assistant = message.userId === NOVA_USER_ID ? parseAssistantMetadata(message.metadata) : null;
    if (assistant) Object.assign(metadata, clone(assistant));
    const page = dmPageDescriptor(message.metadata?.['pageReference']);
    if (page) {
      const key = `${page.kind}:${page.id}`;
      if (!pages.has(key)) pages.set(key, (this.opts.canonical ?? canonicalCallPage)(page)
        .then(found => ({ ...found, status: 'available' as const }), (error: unknown) => {
          if (!(error instanceof AppError) || ![403, 404].includes(error.status)) throw error;
          return { ...page, status: 'unavailable' as const };
        }));
      metadata['pageReference'] = await pages.get(key)!;
    }
    return { id: message.id, clientId: message.clientId, ...(message.userId ? { userId: message.userId } : {}),
      channel, message: message.message, timestamp: message.timestamp, metadata };
  }
  /** The chat service's strictly-after membership rule, plus deletions. */
  private visible(message: ChatMessage, member: CallChatMember) {
    const sent = Date.parse(message.timestamp), floor = Date.parse(member.historyFrom);
    return !message.deletedAt && message.metadata?.['deleted'] !== true && Number.isFinite(sent) && Number.isFinite(floor) && sent > floor;
  }
  /**
   * The reader (or, with `write`, sender) authority for a SESSION: an actual
   * connected seat with this session's provenance, an active history floor,
   * and the huddle's current host-lobby authority. For REST callers (resolver, /summarize,
   * pins, upload bytes), which have no connection of their own.
   */
  async assertMember(callId: string, session: Session, write = false): Promise<void> {
    const actor = await this.participant(callId, session, write);
    if (!actor.state.members[session.sub]?.active) throw new AppError(403, NOT_JOINED);
  }
  /**
   * The gateway's channel authority for one CONNECTION: it is a current,
   * non-departed seat of this call, its session may still use the host lobby,
   * and its person is an active member. Fenced
   * by the seat epoch: a departure or re-registration while this check awaits
   * denies it, so a delayed read cannot restore access after Leave.
   */
  async assertSeat(callId: string, clientId: string, write = false): Promise<void> {
    this.check(callId);
    const control = this.control(callId);
    const epoch = control.seats.get(clientId) ?? 0;
    const current = () => !this.disposed && this.controls.get(callId) === control && !control.ended
      && !control.departed.has(clientId) && (control.seats.get(clientId) ?? 0) === epoch;
    if (!current()) throw new AppError(403, NOT_JOINED);
    const session = await resolveConnectedCallSession(this.opts.router, clientId);
    if (!session || !current()) throw new AppError(403, NOT_JOINED);
    const actor = await this.participant(callId, session, write);
    if (!actor.clientIds.includes(clientId) || !actor.state.members[session.sub]?.active || !current()) throw new AppError(403, NOT_JOINED);
  }
  /** `assertSeat`, and the seat's person is in room `roomId` now: a room chat's join, read and send. */
  async assertRoomSeat(callId: string, roomId: string, clientId: string, write = false): Promise<void> {
    await this.assertSeat(callId, clientId, write);
    const session = await resolveConnectedCallSession(this.opts.router, clientId);
    if (!session || !await this.inRoom(callId, roomId, session.sub)) throw new AppError(403, NOT_IN_ROOM);
  }
  /** Gateway or REST caller: a connection id names its seat, a REST label asks for the session. */
  async assertChannelAccess(callId: string, clientId: string, session: Session, write: boolean): Promise<void> {
    if (REST_CLIENT.test(clientId)) return this.assertMember(callId, session, write);
    const connected = await resolveConnectedCallSession(this.opts.router, clientId);
    if (!connected || callProvenance(connected) !== callProvenance(session)) throw new AppError(403, NOT_JOINED);
    return this.assertSeat(callId, clientId, write);
  }
  /**
   * The chat service's membership rows for this huddle: active members from
   * their join boundary, departed members removed. Never empty (an empty list
   * is an OPEN channel to the library): no roster, an ended call or a failed
   * read is one closed row for nobody.
   */
  async memberRows(callId: string): Promise<ChatMember[]> {
    const channel = callChatChannel(callId);
    try {
      if (this.disposed || this.controls.get(callId)?.ended) return [closedRow(channel)];
      const state: CallChatState = await this.opts.state.get(callId);
      if (state.ended || this.disposed || this.controls.get(callId)?.ended) return [closedRow(channel)];
      const rows = Object.entries(state.members).map(([userId, member]): ChatMember => ({ channel, userId, role: 'member', addedBy: userId,
        addedAt: member.historyFrom, historyFrom: member.historyFrom, removedAt: member.active ? null : member.historyFrom }));
      return rows.length ? rows : [closedRow(channel)];
    } catch { return [closedRow(channel)]; }
  }
  /** The call's lobby name from the call store, or null when the call is gone (the meeting assistant records it). */
  async lobbyOf(callId: string): Promise<string | null> {
    return (await this.opts.calls.getCall(callId))?.lobbyName ?? null;
  }
  /**
   * People who hold or held a seat in this call while it lives: the chat roster, active or departed.
   * Empty once the call has ended (the roster is cleared with it).
   */
  async seatedUsers(callId: string): Promise<{ userId: string; active: boolean }[]> {
    return (await this.memberRows(callId)).filter(row => row.userId !== '').map(row => ({ userId: row.userId, active: row.removedAt == null }));
  }
  /**
   * A room chat's membership rows: the huddle's active members who are in
   * that room now, under the room's channel name. The huddle's join boundary
   * is the floor, so a room's history is what was said in it since the
   * reader joined the call. Closed with the call, like the huddle's.
   */
  async roomMemberRows(callId: string, roomId: string): Promise<ChatMember[]> {
    const channel = roomChatChannel(callId, roomId);
    try {
      const rows = await this.memberRows(callId);
      const inRoom = await Promise.all(rows.map(row => row.removedAt == null && this.inRoom(callId, roomId, row.userId)));
      const kept = rows.filter((_, index) => inRoom[index]).map(row => ({ ...row, channel }));
      return kept.length ? kept : [closedRow(channel)];
    } catch { return [closedRow(channel)]; }
  }
  /** The reader's join boundary (ms), or +Infinity for someone who is not an active member. */
  async memberFloor(callId: string, userId: string): Promise<number> {
    const member = (await this.memberRows(callId)).find(row => row.userId === userId && row.removedAt == null);
    const floor = member?.historyFrom ? Date.parse(member.historyFrom) : NaN;
    return Number.isFinite(floor) ? floor : Number.POSITIVE_INFINITY;
  }
  /** GET /api/calls/:callId/chat: the call's channel, current audience and this reader's replay. */
  async get(callId: string, session: Session, limit = 50): Promise<CallChatSnapshot> {
    await this.participant(callId, session);
    await this.reconcile(callId, true);
    const generation = this.control(callId).generation;
    const actor = await this.participant(callId, session);
    const floor = actor.state.members[session.sub];
    if (!floor?.active) throw new AppError(403, NOT_JOINED);
    let stored: ChatMessage[];
    try { stored = await this.opts.messages.listMessages(callChatChannel(callId), Math.min(100, Math.max(1, limit))); }
    catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'Huddle history is temporarily unavailable. Try again.');
    }
    const pages = new Map<string, Promise<CallChatPageReference>>();
    const messages = await Promise.all(stored.filter(message => this.visible(message, floor)).map(message => this.render(callId, message, pages)));
    const seats = await this.seats(callId);
    const canSend = await this.grant(session, actor.authority, 'PostMessage', actor.call.lobbyName);
    // Canonical/resource reads can outlive revocation, leave, or end.
    const current = await this.participant(callId, session); this.fence(callId, generation);
    if (!current.state.members[session.sub]?.active) throw new AppError(403, NOT_JOINED);
    return { callId, channel: callChatChannel(callId), revision: current.state.revision,
      participants: this.peers(seats), messages, canSend, historyFrom: floor.historyFrom };
  }
  /**
   * Last-mile delivery of huddle frames. Roster/terminal metadata is
   * re-derived for the recipient; chat frames on the namespace are dropped
   * for a departed or ended seat and carry page references resolved now.
   */
  async filterFrame(clientId: string, frame: Record<string, unknown>): Promise<unknown | null> {
    if (this.disposed) return null;
    if (frame.type === 'chat') {
      const channel = typeof frame.channel === 'string' ? frame.channel : '';
      const ref = huddleChatOf(channel);
      const callId = ref?.callId ?? null;
      const control = callId ? this.controls.get(callId) : undefined;
      if (!ref || !callId || !control || control.ended || control.departed.has(clientId)) return null;
      // A room's chat reaches only someone in that room now (a reassignment moves them out).
      if (ref.roomId) {
        const session = await resolveConnectedCallSession(this.opts.router, clientId);
        if (!session || !await this.inRoom(callId, ref.roomId, session.sub)) return null;
      }
      const pages = new Map<string, Promise<CallChatPageReference>>();
      if ((frame.action === 'message' || frame.action === 'messageUpdated') && frame.message && typeof frame.message === 'object') {
        return { ...frame, message: await this.render(callId, frame.message as ChatMessage, pages, channel) };
      }
      if (frame.action === 'history' && Array.isArray(frame.messages)) {
        return { ...frame, messages: await Promise.all((frame.messages as ChatMessage[]).map(message => this.render(callId, message, pages, channel))) };
      }
      return frame;
    }
    if (typeof frame.callId !== 'string') return null;
    const session = await resolveConnectedCallSession(this.opts.router, clientId);
    if (!session) return null;
    const callId = frame.callId;
    if (frame.type === 'call-chat' && frame.action === 'ended') {
      const state = await this.opts.state.get(callId);
      return state.ended && await this.terminalParticipant(callId, clientId, session)
        ? { type: 'call-chat', action: 'ended', callId, channel: callChatChannel(callId), revision: state.revision } : null;
    }
    if (frame.type !== 'call-chat' || frame.action !== 'members') return null;
    // seats() checks this recipient's own seat afresh with everyone else's;
    // the recipient's recheck after it is the last word, as before.
    const seats = await this.seats(callId);
    if (!seats.some(seat => seat.clientId === clientId)) return null;
    const current = await this.participant(callId, session);
    return { ...frame, revision: current.state.revision, participants: this.peers(seats) };
  }
  /** Content-free terminal metadata is only for a previously admitted seat. */
  private async terminalParticipant(callId: string, clientId: string, session: Session): Promise<boolean> {
    const control = this.controls.get(callId);
    if (!control?.ended || !control.lobbyName || control.departed.has(clientId)
      || control.provenance.get(clientId) !== callProvenance(session)) return false;
    const authority = await (this.opts.authority ?? huddleAuthority)(session);
    if (!this.opts.lobbyAllowed({ userId: session.sub, org: session.tenant, role: session.role,
      tenants: Object.keys(authority.grants) }, control.lobbyName)
      || !await this.grant(session, authority, 'ViewSocial', control.lobbyName)) return false;
    // A late policy/resource receipt cannot emit to a retired identity.
    await (this.opts.authority ?? huddleAuthority)(session);
    const current = await resolveConnectedCallSession(this.opts.router, clientId);
    return !!current && callProvenance(current) === callProvenance(session);
  }
  /**
   * Tell every seat the roster. `known` is the seat list a reconcile just
   * checked: while its generation stands, nobody left or re-registered since,
   * so it is not derived again. No recipient is checked here: every frame to
   * a client passes `filterFrame` (the gateway's filterClientMessage, with the
   * recipient's principal revalidated around it), which re-derives this
   * recipient's seat, the roster and the revision before delivering.
   */
  private async broadcastMembers(callId: string, known?: CheckedSeats) {
    const generation = this.control(callId).generation;
    const seats = known && known.generation === generation ? known.seats : await this.seats(callId);
    const participants = this.peers(seats);
    const { revision } = await this.opts.state.get(callId); this.fence(callId, generation);
    const sent = await Promise.allSettled(seats.map(seat => this.opts.router.sendToClient(seat.clientId,
      { type: 'call-chat', action: 'members', callId, channel: callChatChannel(callId), revision, participants })));
    sent.forEach(settled);
  }
  async finish(callId: string, participantClientIds: string[] = []) {
    // Anyone who listens for a call's end (the meeting assistant) is told with the people who held a seat, read before the roster is cleared.
    if (finishListeners.size) {
      // Only people still holding a seat as the call ends: someone who left earlier was not there for what came after (meeting assistant, audit M1).
      const seated = (await this.seatedUsers(callId).catch(() => [])).filter((u) => u.active).map((u) => u.userId);
      for (const listener of finishListeners) { try { void Promise.resolve(listener(callId, seated)).catch((e: unknown) => console.warn('[call-chat] finish listener failed', e)); } catch (e) { console.warn('[call-chat] finish listener failed', e); } }
    }
    const control = this.control(callId); control.ended = true; control.generation += 1;
    invalidateChannel(callChatChannel(callId), 'huddle-ended');
    for (const roomId of control.rooms) invalidateChannel(roomChatChannel(callId, roomId), 'huddle-ended');
    // The rooms' chats end with the call: every seat leaves them too.
    for (const clientId of participantClientIds) {
      for (const channel of this.chatChannels(callId)) {
        void Promise.resolve(this.opts.router.unsubscribeFromChannel?.(clientId, channel)).catch(() => undefined);
      }
    }
    const state: CallChatState = await this.opts.state.finish(callId);
    for (const clientId of participantClientIds) {
      const session = await resolveConnectedCallSession(this.opts.router, clientId); if (!session) continue;
      try {
        if (await this.terminalParticipant(callId, clientId, session)) await this.opts.router.sendToClient(clientId,
          { type: 'call-chat', action: 'ended', callId, channel: callChatChannel(callId), revision: state.revision });
      } catch { /* Terminal metadata contains no message or page contents. */ }
    }
  }
  dispose() {
    this.disposed = true; if (this.maintenance) clearInterval(this.maintenance);
    this.controls.clear(); this.opts.state.dispose?.();
  }
}
type FinishListener = (callId: string, seatedUserIds: string[]) => void | Promise<void>;
const finishListeners = new Set<FinishListener>();
/** Be told when a call's conversation ends (once per `finish`), with the user ids that still held an ACTIVE seat. Returns the unsubscribe. */
export function onCallChatFinished(listener: FinishListener): () => void { finishListeners.add(listener); return () => { finishListeners.delete(listener); }; }
let runtime: CallChatRuntime | null = null;
export function setCallChatRuntime(value: CallChatRuntime | null) { runtime = value; }
export function callChatRuntime(): CallChatRuntime {
  if (!runtime) throw new AppError(503, 'Huddle chat is unavailable'); return runtime;
}

/**
 * The chat service's membership store: huddle names read the call-chat mirror
 * (`memberRows`), every other channel the wrapped store. Huddle rows are never
 * written through the chat service (addMembers/removeMember are refused).
 */
export function huddleMembershipStore(base: ChatMembershipStore, current: () => CallChatRuntime | null): ChatMembershipStore {
  const rows = async (channel: string): Promise<ChatMember[]> => {
    const ref = huddleChatOf(channel);
    const owner = current();
    if (!ref || !owner) return [closedRow(channel)];
    return ref.roomId ? owner.roomMemberRows(ref.callId, ref.roomId) : owner.memberRows(ref.callId);
  };
  return {
    listMembers: (channel, opts) => inCallChatNamespace(channel) ? rows(channel) : base.listMembers(channel, opts),
    getMember: async (channel, userId) => inCallChatNamespace(channel)
      ? (await rows(channel)).find(row => row.userId === userId && !!userId) ?? null : base.getMember(channel, userId),
    putMember: async member => {
      if (inCallChatNamespace(member.channel)) throw new AppError(403, 'Huddle membership follows the call');
      return base.putMember(member);
    },
  };
}
