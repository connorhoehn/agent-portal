// What the social work graph hears from the places it cannot own: chat writes, the call
// state store, deck saves, recording changes, membership. docs/activity-graph-migration.md §10.
//
// This module imports nothing but the mock clock from the rest of the app, so the gateway-side seams (lib/call-pages.ts
// wraps the call state store, lib/social-chat.ts the chat store) and the providers can emit without a
// cycle. `live.ts` subscribes once and turns each event into a content-free work-graph change.
//
// An event names at most the conversation (its chat channel name) and a cause. It carries no message,
// title, person or run; it only decides which open streams recompute (each recompute re-decides every
// part for that viewer). The conversation name never leaves the process in a hint a client can read.

import { clock } from '../../mock/core/index.js';

export type SocialWorkGraphCause = 'message' | 'call' | 'recording' | 'deck' | 'flow-run' | 'membership';
export interface SocialWorkGraphEvent { conversationId: string | null; cause: SocialWorkGraphCause }

const listeners = new Set<(event: SocialWorkGraphEvent) => void>();
export function onSocialWorkGraphEvent(listener: (event: SocialWorkGraphEvent) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Fire-and-forget: a listener that throws never reaches the write that caused the event. */
export function emitSocialWorkGraphEvent(event: SocialWorkGraphEvent): void {
  for (const listener of listeners) {
    try { listener(event); } catch (error) { console.warn('[social-work-graph] listener failed', error); }
  }
}

/** Is `name` a conversation the graph can draw (`social:ch|dm|team|room:…`)? */
export const SOCIAL_CONVERSATION = /^social:(?:ch|dm|team|room):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export const socialConversationOrNull = (name: unknown): string | null =>
  typeof name === 'string' && SOCIAL_CONVERSATION.test(name) ? name : null;

// ── The calls this process has seen (the state store's own view, not a record) ──────────────────
//
// Live status comes from the call state store the gateway's calls() service drives, observed in
// lib/call-pages.ts. It is the only source that knows a call is ringing or running NOW; the call
// log (platform-api) lags and carries the finished rows. The loader merges the two by call id and
// draws a call only for a viewer who may read its lobby's conversation.

export interface ObservedCall {
  callId: string; lobbyName: string; callerId: string; targetUserIds: string[];
  participants: number; startedAt: string; endedAt: string | null; answered: boolean;
  /** When the last connected seat left while the call was still held open (the library's rejoin grace); null while anyone is in. */
  emptiedAt: string | null;
}
const observed = new Map<string, ObservedCall>();
const OBSERVED_MAX = 256;
const RECENT_MS = 6 * 60 * 60 * 1000;

export function observeCall(view: { callId: string; lobbyName: string; callerId: string; targetUserIds: string[]; participants: number }, now: Date = clock.now()): void {
  const prior = observed.get(view.callId);
  const answered = (prior?.answered ?? false) || view.participants >= 2 || view.targetUserIds.length === 0;
  observed.delete(view.callId);
  observed.set(view.callId, {
    callId: view.callId, lobbyName: view.lobbyName, callerId: view.callerId, targetUserIds: [...view.targetUserIds],
    participants: view.participants, startedAt: prior?.startedAt ?? now.toISOString(), endedAt: null, answered,
    emptiedAt: view.participants > 0 ? null : (prior?.emptiedAt ?? now.toISOString()),
  });
  trim(now);
}
export function observeCallEnded(callId: string, now: Date = clock.now()): ObservedCall | null {
  const prior = observed.get(callId);
  if (!prior || prior.endedAt) return prior ?? null;
  const next: ObservedCall = { ...prior, participants: 0, endedAt: now.toISOString() };
  observed.set(callId, next);
  return next;
}
function trim(now: Date): void {
  for (const [id, call] of observed) {
    if (observed.size <= OBSERVED_MAX && !(call.endedAt && now.getTime() - Date.parse(call.endedAt) > RECENT_MS)) break;
    observed.delete(id);
  }
}
export const observedCall = (callId: string): ObservedCall | null => observed.get(callId) ?? null;
export function observedCalls(): ObservedCall[] { return [...observed.values()].map(c => ({ ...c, targetUserIds: [...c.targetUserIds] })); }
export function resetObservedCalls(): void { observed.clear(); }
