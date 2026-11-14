// The call assistant's client state: one shared store per call (the call bar, the
// transcription notice and the roster line all read it), refreshed every
// ASSISTANT_POLL_MS while something is watching and straight after each action.
// Nothing here talks while the server flag is off (`useSession().session.meetingAssistant`).
// The call's proposals (docs/meeting-consent-design.md) ride the same tick: they are read only while Nova is in the call or a proposal
// can still be answered, so a call without either costs no extra request.

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useSession } from '../lib/auth';
import { useCapabilities } from '../lib/capabilities';
import { writeJson } from './writeJson';
import { budgetConfirmOf } from './voice/client';
import { budgetConfirmText } from './voice/controller';
import { isAnswerable, parseProposals, type ProposalAnswer, type ProposalView } from './meetingProposals';
import {
  assistantPresent, ASSISTANT_POLL_MS, assistantControls, NO_ASSISTANT, parseAssistantState, type AssistantControls, type AssistantView,
} from './meetingAssistantModel';

export type AssistantAction = 'invite' | 'pause' | 'resume' | 'dismiss' | 'ack' | 'extend';

/** An over-budget refusal the person may confirm past: the action to send again and the sentence that asks. */
export interface BudgetAsk { action: 'invite' | 'extend'; title: string; detail: string }

interface Slot { view: AssistantView; error: string | null; ask: BudgetAsk | null; busy: boolean; proposals: ProposalView[]; watchers: number; timer: ReturnType<typeof setInterval> | null; listeners: Set<() => void> }
const slots = new Map<string, Slot>();

const slotOf = (callId: string): Slot => {
  let slot = slots.get(callId);
  if (!slot) { slot = { view: NO_ASSISTANT(callId), error: null, ask: null, busy: false, proposals: [], watchers: 0, timer: null, listeners: new Set() }; slots.set(callId, slot); }
  return slot;
};
const publish = (slot: Slot, patch: Partial<Pick<Slot, 'view' | 'error' | 'ask' | 'busy' | 'proposals'>>) => {
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
  if (assistantPresent(slot.view) || slot.proposals.some(isAnswerable)) await refreshProposals(callId);
}

/** One read of the call's proposals; a 404 means none this person may see. A failure keeps the last list. */
export async function refreshProposals(callId: string): Promise<void> {
  const slot = slotOf(callId);
  try {
    const res = await fetch(`${base(callId)}/proposals`, { credentials: 'include', cache: 'no-store' });
    if (res.status === 404) { publish(slot, { proposals: [] }); return; }
    if (!res.ok) return;
    publish(slot, { proposals: parseProposals(await res.json().catch(() => null)) });
  } catch { /* offline: keep the last list */ }
}

/** One answer to a proposal. The server judges it; the list is read again either way. Resolves to the refusal sentence, or null. */
/** `asExecutor` (a consent only): run it in this person's own browser instead of the executor's. */
export async function answerProposal(callId: string, proposalId: string, answer: ProposalAnswer, reason?: string, opts: { asExecutor?: boolean } = {}): Promise<string | null> {
  const body = { response: answer, ...(reason ? { reason } : {}), ...(opts.asExecutor && answer === 'consent' ? { asExecutor: true } : {}) };
  const result = await writeJson<unknown>(`${base(callId)}/proposals/${encodeURIComponent(proposalId)}/response`, 'POST', body);
  await refreshProposals(callId);
  return result.ok ? null : (result.error ?? 'That answer was not saved.');
}

/**
 * Runs one action, adopts the state it answers with, and says why when the server refused. A refusal that can be confirmed
 * (the shared spend refusal, `confirmFlag: confirmOverUserBudget`) becomes `ask` instead of an error, when `mayConfirm`
 * (the inviter; the server honours the flag on extend only from them). `confirmOverUserBudget` re-sends past it.
 */
export async function actOnAssistant(callId: string, action: AssistantAction, opts: { confirmOverUserBudget?: boolean; mayConfirm?: boolean } = {}): Promise<boolean> {
  const slot = slotOf(callId);
  publish(slot, { busy: true, error: null, ask: null });
  const result = await writeJson<unknown>(`${base(callId)}/${action}`, 'POST', opts.confirmOverUserBudget ? { confirmOverUserBudget: true } : {});
  if (result.ok) { publish(slot, { busy: false, view: parseAssistantState(callId, result.data) }); return true; }
  const confirm = opts.mayConfirm && !opts.confirmOverUserBudget ? budgetConfirmOf(result.status, result.data) : null;
  if (confirm && (action === 'invite' || action === 'extend')) {
    const words = budgetConfirmText(confirm);
    publish(slot, { busy: false, ask: { action, title: words.title, detail: words.detail.replace(/ Start it anyway\?$/, ' Go ahead anyway?') } });
  }
  else { publish(slot, { busy: false, error: result.error ?? 'Nova could not do that.' }); await refreshAssistant(callId); }
  return false;
}

/** Turns Nova's voice on or off for the call (an inviter's action; the server posts the notice in the chat). */
export async function setAssistantVoice(callId: string, on: boolean): Promise<boolean> {
  const slot = slotOf(callId);
  publish(slot, { busy: true, error: null, ask: null });
  const result = await writeJson<unknown>(`${base(callId)}/voice`, 'POST', { on });
  if (result.ok) { publish(slot, { busy: false, view: parseAssistantState(callId, result.data) }); return true; }
  publish(slot, { busy: false, error: result.error ?? 'Nova could not do that.' });
  await refreshAssistant(callId);
  return false;
}

export interface MeetingAssistantHandle {
  /** The server advertises the feature. */
  enabled: boolean;
  view: AssistantView;
  controls: AssistantControls;
  busy: boolean;
  error: string | null;
  /** An over-budget refusal waiting for a yes or a no. */
  ask: BudgetAsk | null;
  /** Yes sends the held action again past the budget; no drops it. */
  answerAsk(yes: boolean): Promise<boolean>;
  invite(): Promise<boolean>;
  pause(): Promise<boolean>;
  resume(): Promise<boolean>;
  dismiss(): Promise<boolean>;
  acknowledge(): Promise<boolean>;
  extend(): Promise<boolean>;
  /** The call's proposals this person may see, oldest first. */
  proposals: ProposalView[];
  /** The inviter's switch: Nova speaks aloud in this call, or stops. */
  setVoice(on: boolean): Promise<boolean>;
  /** This person may use the voice switch. */
  canSetVoice: boolean;
}

const cache = new WeakMap<Slot, { key: string; value: Pick<MeetingAssistantHandle, 'view' | 'busy' | 'error' | 'ask' | 'proposals'> }>();
const snapshotOf = (slot: Slot) => {
  const key = `${slot.busy}|${slot.error}|${JSON.stringify(slot.ask)}|${JSON.stringify(slot.view)}|${JSON.stringify(slot.proposals)}`;
  const hit = cache.get(slot);
  if (hit && hit.key === key) return hit.value;
  const value = { view: slot.view, busy: slot.busy, error: slot.error, ask: slot.ask, proposals: slot.proposals };
  cache.set(slot, { key, value });
  return value;
};

const NO_PROPOSALS: ProposalView[] = [];

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

  const mayConfirm = !!session?.sub && snap.view.invitedBy === session.sub;
  const run = (action: AssistantAction) => (callId && enabled ? actOnAssistant(callId, action, { mayConfirm: action === 'invite' || mayConfirm }) : Promise.resolve(false));
  const view = active ? snap.view : NO_ASSISTANT(callId ?? '');
  return {
    enabled, view, busy: snap.busy, error: active ? snap.error : null, ask: active ? snap.ask : null, proposals: active ? snap.proposals : NO_PROPOSALS,
    answerAsk: (yes) => {
      const ask = snap.ask;
      if (!yes || !ask || !callId) { publish(slot, { ask: null }); return Promise.resolve(false); }
      return actOnAssistant(callId, ask.action, { confirmOverUserBudget: true });
    },
    controls: assistantControls({ enabled, inCall: !!callId, canInvite: can('InviteMeetingAssistant'), view }),
    invite: () => run('invite'), pause: () => run('pause'), resume: () => run('resume'),
    dismiss: () => run('dismiss'), acknowledge: () => run('ack'), extend: () => run('extend'),
    setVoice: (on) => (callId && enabled ? setAssistantVoice(callId, on) : Promise.resolve(false)),
    canSetVoice: can('InviteMeetingAssistant'),
  };
}
