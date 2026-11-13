// The call assistant's client state: one shared store per call (the call bar, the
// transcription notice and the roster line all read it), refreshed every
// ASSISTANT_POLL_MS while something is watching and straight after each action.
// Nothing here talks while the server flag is off (`useSession().session.meetingAssistant`).

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useSession } from '../lib/auth';
import { useCapabilities } from '../lib/capabilities';
import { writeJson } from './writeJson';
import {
  ASSISTANT_POLL_MS, assistantControls, NO_ASSISTANT, parseAssistantState, type AssistantControls, type AssistantView,
} from './meetingAssistantModel';

export type AssistantAction = 'invite' | 'pause' | 'resume' | 'dismiss' | 'ack' | 'extend';

interface Slot { view: AssistantView; error: string | null; busy: boolean; watchers: number; timer: ReturnType<typeof setInterval> | null; listeners: Set<() => void> }
const slots = new Map<string, Slot>();

const slotOf = (callId: string): Slot => {
  let slot = slots.get(callId);
  if (!slot) { slot = { view: NO_ASSISTANT(callId), error: null, busy: false, watchers: 0, timer: null, listeners: new Set() }; slots.set(callId, slot); }
  return slot;
};
const publish = (slot: Slot, patch: Partial<Pick<Slot, 'view' | 'error' | 'busy'>>) => {
  Object.assign(slot, patch);
  for (const l of slot.listeners) l();
};
const base = (callId: string) => `/api/calls/${encodeURIComponent(callId)}/assistant`;

/** One read of the state; a failure keeps what was last known (a missed poll must not make Nova vanish). */
export async function refreshAssistant(callId: string): Promise<void> {
  const slot = slotOf(callId);
  try {
    const res = await fetch(`${base(callId)}/state`, { credentials: 'include', cache: 'no-store' });
    if (res.status === 404) { publish(slot, { view: NO_ASSISTANT(callId) }); return; }
    if (!res.ok) return;
    publish(slot, { view: parseAssistantState(callId, await res.json().catch(() => null)) });
  } catch { /* offline: keep the last view */ }
}

/** Runs one action, adopts the state it answers with, and says why when the server refused. */
export async function actOnAssistant(callId: string, action: AssistantAction): Promise<boolean> {
  const slot = slotOf(callId);
  publish(slot, { busy: true, error: null });
  const result = await writeJson<unknown>(`${base(callId)}/${action}`, 'POST', {});
  if (result.ok) publish(slot, { busy: false, view: parseAssistantState(callId, result.data) });
  else { publish(slot, { busy: false, error: result.error ?? 'Nova could not do that.' }); await refreshAssistant(callId); }
  return result.ok;
}

export interface MeetingAssistantHandle {
  /** The server advertises the feature. */
  enabled: boolean;
  view: AssistantView;
  controls: AssistantControls;
  busy: boolean;
  error: string | null;
  invite(): Promise<boolean>;
  pause(): Promise<boolean>;
  resume(): Promise<boolean>;
  dismiss(): Promise<boolean>;
  acknowledge(): Promise<boolean>;
  extend(): Promise<boolean>;
}

const cache = new WeakMap<Slot, { key: string; value: Pick<MeetingAssistantHandle, 'view' | 'busy' | 'error'> }>();
const snapshotOf = (slot: Slot) => {
  const key = `${slot.busy}|${slot.error}|${JSON.stringify(slot.view)}`;
  const hit = cache.get(slot);
  if (hit && hit.key === key) return hit.value;
  const value = { view: slot.view, busy: slot.busy, error: slot.error };
  cache.set(slot, { key, value });
  return value;
};

/** `callId` null (no live call) or the flag off: nothing is read and every control is hidden. */
export function useMeetingAssistant(callId: string | null): MeetingAssistantHandle {
  const { session } = useSession();
  const { can } = useCapabilities();
  const enabled = session?.meetingAssistant === true;
  const active = enabled && !!callId;
  const slot = useMemo(() => slotOf(callId ?? ''), [callId]);

  const subscribe = useCallback((onChange: () => void) => {
    if (!active) return () => undefined;
    slot.listeners.add(onChange);
    if (slot.watchers++ === 0) {
      void refreshAssistant(callId!);
      slot.timer = setInterval(() => void refreshAssistant(callId!), ASSISTANT_POLL_MS);
    }
    return () => {
      slot.listeners.delete(onChange);
      if (--slot.watchers === 0 && slot.timer) { clearInterval(slot.timer); slot.timer = null; }
    };
  }, [active, slot, callId]);
  const snap = useSyncExternalStore(subscribe, () => snapshotOf(slot), () => snapshotOf(slot));

  const run = (action: AssistantAction) => (callId && enabled ? actOnAssistant(callId, action) : Promise.resolve(false));
  const view = active ? snap.view : NO_ASSISTANT(callId ?? '');
  return {
    enabled, view, busy: snap.busy, error: active ? snap.error : null,
    controls: assistantControls({ enabled, inCall: !!callId, canInvite: can('InviteMeetingAssistant'), view }),
    invite: () => run('invite'), pause: () => run('pause'), resume: () => run('resume'),
    dismiss: () => run('dismiss'), acknowledge: () => run('ack'), extend: () => run('extend'),
  };
}
