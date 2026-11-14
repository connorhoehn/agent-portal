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
import { PendingResults, SeenTurns, flushResults, parseClaim, parseTurns, processTurns, type ClaimResult } from '../../lib/meetingTurns';
import { runCallTool } from '../../lib/voice/runCore';
import { pageContextFor, pageTabsFor } from '../../lib/voice/pageContext';
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
    const pending = new PendingResults(`nova-results:${callId}:${userId}`);
    // The server's clock, from the `Date` header of its answers: a turn's expiry is the server's time, not this browser's.
    let offset = 0;
    const serverNow = (): number => Date.now() + offset;
    const learn = (res: Response): void => {
      const at = Date.parse(res.headers.get('date') ?? '');
      if (Number.isFinite(at)) offset = at - Date.now();
    };
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const claim = async (turnId: string): Promise<ClaimResult> => {
      try {
        const res = await fetch(`${base}/turns/${encodeURIComponent(turnId)}/claim`, { method: 'POST', credentials: 'include', cache: 'no-store' });
        learn(res);
        if (res.status === 404 || res.status === 409) return { status: 'refused' };
        return res.ok ? parseClaim(await res.json().catch(() => null)) : { status: 'error' };
      } catch { return { status: 'error' }; }
    };
    const post = async (turnId: string, body: { claimId: string; ok: boolean; output?: unknown; error?: string }): Promise<number> => {
      const res = await fetch(`${base}/turns/${encodeURIComponent(turnId)}/result`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      learn(res);
      return res.status;
    };
    const flush = async (): Promise<void> => {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      const next = await flushResults({ pending, now: serverNow, post });
      if (next !== null && !stopped) retryTimer = setTimeout(() => void flush(), Math.max(0, next - Date.now()));
    };
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
        // The page in view, as the voice navigator reads it: a work item made from the call's initiative page lands on that initiative.
        page: () => pageContextFor(window.location.pathname), tabs: () => pageTabsFor(window.location.pathname),
      };
    };
    const poll = async (): Promise<void> => {
      if (busy || stopped) return;
      busy = true;
      try {
        const res = await fetch(`${base}/turns?mine=1`, { credentials: 'include', cache: 'no-store' });
        learn(res);
        if (!res.ok || stopped) return;
        await processTurns(parseTurns(await res.json().catch(() => null)), {
          seen, pending, now: serverNow, claim,
          run: (name, args, write) => runCallTool(name, args, context(), { write }),
          post,
        });
        if (pending.size > 0 && !retryTimer) void flush();
      } catch { /* offline: the next tick asks again */ } finally { busy = false; }
    };
    void flush(); // a result kept from before a reload is posted again, not run again
    void poll();
    const timer = setInterval(() => void poll(), TURN_POLL_MS);
    const off = onTurnsPoke(callId, () => void poll());
    return () => { stopped = true; clearInterval(timer); if (retryTimer) clearTimeout(retryTimer); off(); };
  }, [listening, callId, userId, ledger, results]);
  return null;
}
