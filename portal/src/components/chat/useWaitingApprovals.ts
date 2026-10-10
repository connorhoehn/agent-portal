// The `/agent` loops paused at an approval step in the open conversation, for everyone who may read it
// (the requester finds their own paused loop again after a reload; an eligible approver or a reader sees
// someone else's). Polled, because a paused loop's push channel is the requester's private one: every
// POLL_MS while the tab is visible, with a doubling pause after failures (capped), and once more at once
// when the tab comes back. A conversation with no paused loop costs one small GET per poll.

import { useCallback, useEffect, useRef, useState } from 'react';
import { isDocumentHidden, nextPollDelay } from '../../hooks/pollSchedule';
import type { AgentApi, AgentWaitingRun } from './conversationAgent';

export const WAITING_POLL_MS = 5_000;

export function useWaitingApprovals(api: AgentApi, channel: string | null, enabled: boolean): { runs: AgentWaitingRun[]; refresh: () => void } {
  const [state, setState] = useState<{ channel: string | null; runs: AgentWaitingRun[] }>({ channel, runs: [] });
  const tick = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!channel || !enabled) return undefined;
    let cancelled = false; let failures = 0; let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      if (cancelled) return;
      if (!isDocumentHidden()) {
        try { const runs = await api.waiting(channel); if (!cancelled) { failures = 0; setState({ channel, runs }); } } catch { failures += 1; }
      }
      if (!cancelled) timer = setTimeout(() => { void read(); }, nextPollDelay(failures, WAITING_POLL_MS));
    };
    tick.current = () => { if (timer) clearTimeout(timer); void read(); };
    const onVisible = (): void => { if (!isDocumentHidden()) tick.current(); };
    document.addEventListener('visibilitychange', onVisible);
    void read();
    return () => { cancelled = true; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [api, channel, enabled]);
  const refresh = useCallback(() => tick.current(), []);
  return { runs: state.channel === channel ? state.runs : [], refresh };
}
