// The huddle conversation's roster: which gateway chat channel a joined OrgIQ
// call uses, who is in it and whether this person may post. Messages, typing,
// receipts, reactions and pins are ordinary gateway chat on that channel
// (`useChat` in HuddleChat.tsx); this file only reads the BFF resolver
// (GET /api/calls/:callId/chat) and the server's `call-chat` roster frames,
// with fences so a delayed reply cannot restore a removed member.

export interface HuddleScope { callId: string; tenant: string; actorId: string; identityKey: string }
export interface HuddleParticipant { userId: string; displayName: string }
export interface HuddleRosterSnapshot {
  callId: string; channel: string; revision: number; participants: HuddleParticipant[]; canSend: boolean; historyFrom: string;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const iso = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value));
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** The gateway chat channel of a huddle (middleware lib/call-chat.ts `callChatChannel`). */
export const huddleChannel = (callId: string): string => `orgiq:huddle:${callId}`;
export const huddleScopeKey = (scope: HuddleScope | null): string => scope
  ? JSON.stringify([scope.tenant, scope.actorId, scope.callId, scope.identityKey]) : '';

function participants(value: unknown): HuddleParticipant[] | null {
  if (!Array.isArray(value) || !value.every(person => record(person) && text(person.userId) && text(person.displayName))) return null;
  const unique = new Map<string, HuddleParticipant>();
  for (const person of value) unique.set(person.userId, { userId: person.userId, displayName: person.displayName });
  return [...unique.values()];
}

export function readHuddleRoster(value: unknown, callId: string): HuddleRosterSnapshot | null {
  if (!record(value) || value.callId !== callId || value.channel !== huddleChannel(callId)
    || !revision(value.revision) || typeof value.canSend !== 'boolean' || !iso(value.historyFrom)) return null;
  const people = participants(value.participants);
  if (!people) return null;
  return { callId, channel: value.channel, revision: value.revision, participants: people, canSend: value.canSend, historyFrom: value.historyFrom };
}

export class HuddleRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; this.name = 'HuddleRequestError'; }
}
export type HuddleRosterReader = (callId: string, signal?: AbortSignal) => Promise<HuddleRosterSnapshot>;

export function createHuddleRosterReader(request: typeof fetch = fetch): HuddleRosterReader {
  return async (callId, signal) => {
    // The resolver also replays this reader's messages; the roster needs only the newest one.
    const response = await request(`/api/calls/${encodeURIComponent(callId)}/chat?limit=1`, { credentials: 'include', signal });
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new HuddleRequestError(response.status,
      record(json) && text(json.error) ? json.error : `Huddle conversation request failed (${response.status})`);
    const snapshot = readHuddleRoster(json, callId);
    if (!snapshot) throw new HuddleRequestError(502, 'The huddle conversation response was invalid');
    return snapshot;
  };
}

export interface HuddleRosterState {
  scopeKey: string; participants: HuddleParticipant[]; revision: number;
  loaded: boolean; refreshing: boolean; canSend: boolean; ended: boolean;
  /** The resolver refused this person (not or no longer a participant). */
  denied: boolean;
  error: string | null;
}
export const emptyHuddleRoster = (scopeKey = ''): HuddleRosterState => ({ scopeKey, participants: [], revision: -1,
  loaded: false, refreshing: false, canSend: false, ended: false, denied: false, error: null });

const REFUSED = [401, 403, 404, 410];

/** One shell controller per identity/call scope; a new scope fences every older read and frame. */
export class HuddleRoster {
  private scope: HuddleScope | null = null;
  private state = emptyHuddleRoster();
  private generation = 0;
  private readGeneration = 0;
  private dataGeneration = 0;
  private abort = new AbortController();
  private listeners = new Set<() => void>();
  private readonly read: HuddleRosterReader;
  private readonly registrationRetryDelays: readonly number[];
  constructor(read: HuddleRosterReader, registrationRetryDelays: readonly number[] = [250, 750]) {
    this.read = read; this.registrationRetryDelays = registrationRetryDelays;
  }
  getSnapshot = (): HuddleRosterState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<HuddleRosterState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  setScope(scope: HuddleScope | null): void {
    const key = huddleScopeKey(scope);
    if (key === this.state.scopeKey) return;
    this.abort.abort(); this.abort = new AbortController();
    this.generation++; this.readGeneration++; this.dataGeneration++;
    this.scope = scope;
    this.state = emptyHuddleRoster(key);
    for (const listener of this.listeners) listener();
  }
  /** The server's `call-chat` frames: a newer roster revision, or the call's end. */
  receive = (frame: unknown): void => {
    if (!this.scope || !record(frame) || frame.type !== 'call-chat' || frame.callId !== this.scope.callId
      || frame.channel !== huddleChannel(this.scope.callId) || !revision(frame.revision) || frame.revision <= this.state.revision) return;
    if (frame.action === 'ended') {
      this.dataGeneration++; this.abort.abort();
      this.update({ revision: frame.revision, ended: true, canSend: false, refreshing: false, participants: [], error: 'This huddle has ended.' });
    } else if (frame.action === 'members' && !this.state.ended) {
      const people = participants(frame.participants);
      if (people) {
        this.dataGeneration++;
        const member = people.some(person => person.userId === this.scope!.actorId);
        this.update({ revision: frame.revision, participants: people, canSend: this.state.canSend && member });
      }
    }
  };
  async refresh({ retryRegistration = false }: { retryRegistration?: boolean } = {}): Promise<boolean> {
    if (!this.scope || this.state.ended) return false;
    const { callId } = this.scope;
    const generation = this.generation, read = ++this.readGeneration, data = this.dataGeneration;
    const signal = this.abort.signal;
    const stale = () => generation !== this.generation || read !== this.readGeneration || this.state.ended;
    this.update({ refreshing: true });
    try {
      let snapshot: HuddleRosterSnapshot;
      for (let attempt = 0; ; attempt++) {
        try { snapshot = await this.read(callId, signal); break; }
        catch (error) {
          const delay = this.registrationRetryDelays[attempt];
          if (!retryRegistration || this.state.loaded || delay === undefined || !(error instanceof HuddleRequestError)
            || ![403, 404].includes(error.status)) throw error;
          await new Promise<void>(resolve => {
            const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
            const timer = setTimeout(finish, delay); signal.addEventListener('abort', finish, { once: true });
          });
          if (stale()) return false;
        }
      }
      if (stale()) return false;
      // An older reply never downgrades a newer roster revision.
      const current = snapshot.revision >= this.state.revision;
      this.update({ loaded: true, denied: false,
        ...(current ? { revision: snapshot.revision, participants: snapshot.participants, canSend: snapshot.canSend } : {}),
        ...(data === this.dataGeneration ? { error: null } : {}) });
      return true;
    } catch (error) {
      if (stale() || data !== this.dataGeneration) return false;
      const refused = error instanceof HuddleRequestError && REFUSED.includes(error.status);
      this.update({ canSend: refused ? false : this.state.canSend, denied: refused || this.state.denied,
        error: error instanceof Error ? error.message : 'Could not load the huddle conversation' });
      return false;
    } finally {
      if (generation === this.generation && read === this.readGeneration && !this.state.ended) this.update({ refreshing: false });
    }
  }
}
