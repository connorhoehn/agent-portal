// Hands-free Milo's floor, polled while a call runs hands-free (model: lib/miloFloorModel.ts). `base` is where the floor and hold live:
// a staff seat's `/api/calls/<id>/assistant`, or the candidate's `/api/interview-invite/milo` (null: nothing is read).
import { useCallback, useEffect, useState } from 'react';
import { FLOOR_POLL_MS, IDLE_POLL_MS, NO_FLOOR, holdRefusalWords, parseFloor, type MiloFloorView } from './miloFloorModel';

export type HoldAction = 'press' | 'release' | 'cancel';
export type HoldOutcome = { ok: true } | { ok: false; words: string };

export const staffFloorBase = (callId: string | null): string | null => (callId ? `/api/calls/${encodeURIComponent(callId)}/assistant` : null);
export const GUEST_FLOOR_BASE = '/api/interview-invite/milo';

/** The floor at `base`, read every FLOOR_POLL_MS while `on`; `hold` sends a press, release or cancel and takes the floor it answers. */
export function useMiloFloor(base: string | null, on: boolean): { view: MiloFloorView; hold: (action: HoldAction) => Promise<HoldOutcome> } {
  const [view, setView] = useState<MiloFloorView>(NO_FLOOR);
  useEffect(() => {
    if (!base || !on) { setView(NO_FLOOR); return undefined; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Every FLOOR_POLL_MS while the call is hands-free; IDLE_POLL_MS while it is not (the candidate learns it from this read).
    const read = async () => {
      let handsfree = false;
      try {
        const res = await fetch(`${base}/floor`, { credentials: 'include', cache: 'no-store' });
        if (alive && res.ok) { const next = parseFloor(await res.json().catch(() => null)); handsfree = next.handsfree; setView(next); }
      } catch { /* offline: keep the last floor */ }
      if (alive) timer = setTimeout(() => { void read(); }, handsfree ? FLOOR_POLL_MS : IDLE_POLL_MS);
    };
    void read();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [base, on]);
  const hold = useCallback(async (action: HoldAction): Promise<HoldOutcome> => {
    if (!base) return { ok: false, words: holdRefusalWords(0, null) };
    try {
      const res = await fetch(`${base}/hold/${action}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body: unknown = await res.json().catch(() => null);
      setView((v) => ({ ...parseFloor(body), ...(v.mayHold !== undefined ? { mayHold: v.mayHold } : {}) }));
      return res.ok ? { ok: true } : { ok: false, words: holdRefusalWords(res.status, body) };
    } catch { return { ok: false, words: holdRefusalWords(0, null) }; }
  }, [base]);
  return { view, hold };
}
