// Runs the call assistant's turns in this person's own browser (docs/meeting-assistant-design.md, decision 5).
// Renders nothing. While Nova is listening in the call this person is in, it asks the server for the turns made for
// this person every TURN_POLL_MS (the 5 s state poll is too slow for a read that someone is waiting on) and runs each
// one once through the voice navigator's executor with this person's own session. See lib/meetingTurns.ts for the
// rules: reads when pending, writes only when running, never twice.

import { useEffect, useMemo, useRef } from 'react';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { useMeetingAssistant } from '../../lib/meetingAssistant';
import { onTurnsPoke } from '../../lib/meetingTurnsPoke';
import { SeenTurns, parseTurns, processTurns } from '../../lib/meetingTurns';
import { writeJson } from '../../lib/writeJson';
import { runCallTool } from '../../lib/voice/runCore';
import { ResultMemory, type DeliveryRecord, type ToolContext } from '../../lib/voice/tools';
import { PAGES, isPageVisible } from './portalCommands';
import { useLiveCallId } from './MeetingAssistantBar';

/** How often the browser asks for its turns while Nova is listening. */
export const TURN_POLL_MS = 2000;

export function MeetingTurnRunner() {
  const callId = useLiveCallId();
  const nova = useMeetingAssistant(callId);
  const { session } = useSession();
  const { can } = useCapabilities();
  const listening = nova.enabled && (nova.view.phase === 'listening' || nova.view.phase === 'invited');
  const userId = session?.sub ?? null;
  const ledger = useMemo(() => new Map<string, DeliveryRecord>(), [userId]);
  const results = useMemo(() => new ResultMemory(), [userId, session?.tenant]);
  const live = useRef({ session, can });
  live.current = { session, can };

  useEffect(() => {
    if (!listening || !callId || !userId) return undefined;
    const seen = new SeenTurns(`nova-turns:${callId}:${userId}`);
    const base = `/api/calls/${encodeURIComponent(callId)}/assistant`;
    let stopped = false;
    let busy = false;
    // A tool context for this person only. It cannot navigate (a call is not the place to move their page).
    const context = (): ToolContext => {
      const s = live.current.session;
      return {
        tenant: s?.tenant ?? 'orgiq', role: s?.role ?? 'member', switchable: s?.switchable?.[s.tenant] ?? null, userId, userName: s?.name ?? null,
        ledger, results, palette: { pages: PAGES, visible: isPageVisible },
        can: live.current.can, fetch: (url, init) => fetch(url, init), navigate: () => undefined, now: () => new Date(),
      };
    };
    const poll = async (): Promise<void> => {
      if (busy || stopped) return;
      busy = true;
      try {
        const res = await fetch(`${base}/turns?mine=1`, { credentials: 'include', cache: 'no-store' });
        if (!res.ok || stopped) return;
        await processTurns(parseTurns(await res.json().catch(() => null)), {
          seen, now: Date.now,
          run: (name, args, write) => runCallTool(name, args, context(), { write }),
          post: async (turnId, body) => { await writeJson(`${base}/turns/${encodeURIComponent(turnId)}/result`, 'POST', body); },
        });
      } catch { /* offline: the next tick asks again */ } finally { busy = false; }
    };
    void poll();
    const timer = setInterval(() => void poll(), TURN_POLL_MS);
    const off = onTurnsPoke(callId, () => void poll());
    return () => { stopped = true; clearInterval(timer); off(); };
  }, [listening, callId, userId, ledger, results]);
  return null;
}
