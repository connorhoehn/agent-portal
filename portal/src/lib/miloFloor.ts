// Hands-free Milo's floor, pushed: realtime-modules `useAssistantFloor` reads `<base>/floor` once (and again after a reconnect) and
// then applies the `assistant-floor` frames the middleware sends on the call's chat channel whenever the floor changes (orchestrator
// `pushFloor`). Nothing polls. `base` is where the floor and hold live: a staff seat's `/api/calls/<id>/assistant`, or the
// candidate's `/api/interview-invite/milo`. `useMiloHoldBar` turns it into the library `AssistantBar`'s floor and hold props.
import { useCallback, useMemo, useState } from 'react';
import { useAssistantFloor, type AssistantFloorView } from '@connorhoehn/realtime-modules/client';
import type { AssistantBarFloor, AssistantBarHold } from '@connorhoehn/ui-components/video';
import { useGatewayFrames } from './gatewayFrames';
import { HOLD_LABEL, HOLD_MAX_MS, HOLD_TALKING_LABEL, holdRefusalWords, miloChannel } from './miloFloorModel';

export type HoldAction = 'press' | 'release' | 'cancel';
export type HoldOutcome = { ok: true } | { ok: false; words: string };

export const staffFloorBase = (callId: string | null): string | null => (callId ? `/api/calls/${encodeURIComponent(callId)}/assistant` : null);
export const GUEST_FLOOR_BASE = '/api/interview-invite/milo';

const REFUSAL_SHOWN_MS = 4000;

/** The floor of `callId`'s call (pushed; first read at `base`) while `on`; `hold` sends a press, release or cancel. */
export function useMiloFloor(base: string | null, callId: string | null, on: boolean): { view: AssistantFloorView; hold: (action: HoldAction) => Promise<HoldOutcome> } {
  const { gateway, connectionState } = useGatewayFrames();
  const socket = useMemo(() => ({ onMessage: gateway.onMessage, connectionState }), [gateway.onMessage, connectionState]);
  const read = useCallback(async (signal: AbortSignal): Promise<unknown> => {
    const res = await fetch(`${base}/floor`, { credentials: 'include', cache: 'no-store', signal });
    if (!res.ok) throw new Error(`floor ${res.status}`);
    return res.json();
  }, [base]);
  const { view, apply } = useAssistantFloor({ channel: base && callId && on ? miloChannel(callId) : null, read, gateway: socket });
  const hold = useCallback(async (action: HoldAction): Promise<HoldOutcome> => {
    if (!base) return { ok: false, words: holdRefusalWords(0, null) };
    try {
      const res = await fetch(`${base}/hold/${action}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body: unknown = await res.json().catch(() => null);
      apply(body);
      return res.ok ? { ok: true } : { ok: false, words: holdRefusalWords(res.status, body) };
    } catch { return { ok: false, words: holdRefusalWords(0, null) }; }
  }, [base, apply]);
  return { view, hold };
}

export interface MiloHoldBar {
  /** The call runs hands-free now (the bar draws the floor and the button only then). */
  handsfree: boolean;
  floor: AssistantBarFloor | null;
  /** Null: this viewer may not hold. */
  hold: AssistantBarHold | null;
  refusal: string | null;
}

/**
 * The hold button and the floor for `AssistantBar`. `mayHold`: staff pass the assistant state's; the candidate's comes with the
 * floor read. A refused press resets the button (it is drawn afresh) and shows the server's sentence for a moment.
 */
export function useMiloHoldBar({ base, callId, on, mayHold }: { base: string | null; callId: string | null; on: boolean; mayHold?: boolean }): MiloHoldBar {
  const { view, hold } = useMiloFloor(base, callId, on);
  const [holding, setHolding] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const send = useCallback(async (action: HoldAction) => {
    if (action !== 'press') { setHolding(false); await hold(action); return; }
    setHolding(true); setRefusal(null);
    const out = await hold('press');
    if (out.ok) return;
    setHolding(false); setGeneration((g) => g + 1); setRefusal(out.words);
    setTimeout(() => setRefusal(null), REFUSAL_SHOWN_MS);
  }, [hold]);
  const canHold = (mayHold ?? view.mayHold) === true;
  return {
    handsfree: view.handsfree,
    floor: view.floor ? { userId: view.floor.userId, name: view.floor.name } : null,
    hold: view.handsfree && canHold ? {
      holding, resetKey: generation, maxDurationMs: HOLD_MAX_MS, label: HOLD_LABEL, talkingLabel: HOLD_TALKING_LABEL,
      onStart: () => void send('press'), onEnd: () => void send('release'), onCancel: () => void send('cancel'),
    } : null,
    refusal,
  };
}
