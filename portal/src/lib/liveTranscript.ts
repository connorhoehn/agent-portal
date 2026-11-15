// The live transcript's two pieces of client state (docs/meeting-assistant-design.md):
//   - whether the view is on, per call, shared by Nova's footer menu and whichever pane draws the call's chat (one tiny store,
//     not one host's React context). Only one call is ever live, so the store holds that call; a call that ends resets it.
//   - the lines, read by useLiveTranscript only while the view is on (liveTranscriptModel.ts decides when).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AssistantPhase } from './meetingAssistantModel';
import {
  livePlan, liveAfterUrl, liveTailUrl, mergeLines, mergeSpeakers, newestSeq, oldestSeq, type LiveLine, type LiveSpeaker,
} from './liveTranscriptModel.ts';

let shown: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const emit = () => { for (const fn of listeners) fn(); };

/** Turns the view on or off for this call (on for one call turns it off for any other). */
export function setLiveTranscript(callId: string, on: boolean): void {
  const next = on ? callId : shown === callId ? null : shown;
  if (next === shown) return;
  shown = next; emit();
}

export function liveTranscriptOn(callId: string | null): boolean { return !!callId && shown === callId; }

export function useLiveTranscriptOn(callId: string | null): boolean {
  return useSyncExternalStore(subscribe, () => liveTranscriptOn(callId), () => false);
}

export interface LiveTranscript {
  lines: LiveLine[];
  speakers: ReadonlyMap<string, LiveSpeaker>;
  /** When Nova was invited (epoch ms); a line's time reads from it. */
  since: number | null;
  /** Older lines exist before the oldest one held. */
  earlier: boolean;
  loaded: boolean;
  loadingEarlier: boolean;
  error: string | null;
  loadEarlier(): void;
}

interface Answer { lines: LiveLine[]; speakers?: LiveSpeaker[]; since?: number; earlier?: boolean }

async function read(url: string): Promise<Answer> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(res.status === 404 ? 'The transcript is not available to you.' : 'The transcript could not be read. It will try again.');
  return await res.json() as Answer;
}

/** Reads the call's lines while `on`: the newest first, then the new ones on the plan's schedule. Nothing is fetched while off. */
export function useLiveTranscript(callId: string | null, on: boolean, phase: AssistantPhase): LiveTranscript {
  const [lines, setLines] = useState<LiveLine[]>([]);
  const [speakers, setSpeakers] = useState<ReadonlyMap<string, LiveSpeaker>>(new Map());
  const [since, setSince] = useState<number | null>(null);
  const [earlier, setEarlier] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finalRead, setFinalRead] = useState(false);
  const generation = useRef(0);
  const held = useRef<LiveLine[]>([]);
  const inFlight = useRef(false);

  const take = useCallback((answer: Answer, mode: 'tail' | 'after' | 'earlier') => {
    const next = mergeLines(held.current, answer.lines ?? []);
    held.current = next; setLines(next);
    if (answer.speakers?.length) setSpeakers((s) => mergeSpeakers(s, answer.speakers!));
    if (typeof answer.since === 'number') setSince(answer.since);
    if (mode !== 'after' && typeof answer.earlier === 'boolean') setEarlier(answer.earlier);
    setError(null);
  }, []);

  // The view opens (or the call changes): start over from the newest lines. Closing it drops what was read.
  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    held.current = []; inFlight.current = false;
    setLines([]); setSpeakers(new Map()); setSince(null); setEarlier(false); setLoaded(false); setError(null); setFinalRead(false);
    if (!on || !callId) return;
    read(liveTailUrl(callId)).then((a) => { if (mine === generation.current) { take(a, 'tail'); setLoaded(true); } })
      .catch((e: unknown) => { if (mine === generation.current) { setError(e instanceof Error ? e.message : String(e)); setLoaded(true); } });
  }, [callId, on, take]);

  const plan = livePlan(on && loaded, phase, finalRead);
  const pollOnce = useCallback(async (mine: number) => {
    if (!callId || inFlight.current) return;
    inFlight.current = true;
    try {
      const a = await read(liveAfterUrl(callId, newestSeq(held.current)));
      if (mine === generation.current) take(a, 'after');
    } catch (e) {
      if (mine === generation.current) setError(e instanceof Error ? e.message : String(e));
    } finally { inFlight.current = false; }
  }, [callId, take]);

  const everyMs = plan.kind === 'poll' ? plan.everyMs : 0;
  useEffect(() => {
    if (!everyMs) return;
    const mine = generation.current;
    const timer = setInterval(() => void pollOnce(mine), everyMs);
    return () => clearInterval(timer);
  }, [everyMs, pollOnce]);
  // Nova left: one more read for the last lines it stored, then nothing.
  useEffect(() => {
    if (plan.kind !== 'final') return;
    const mine = generation.current;
    void pollOnce(mine).finally(() => { if (mine === generation.current) setFinalRead(true); });
  }, [plan.kind, pollOnce]);

  const loadEarlier = useCallback(() => {
    const before = oldestSeq(held.current);
    if (!callId || !before || loadingEarlier) return;
    const mine = generation.current;
    setLoadingEarlier(true);
    read(liveTailUrl(callId, before)).then((a) => { if (mine === generation.current) take(a, 'earlier'); })
      .catch((e: unknown) => { if (mine === generation.current) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (mine === generation.current) setLoadingEarlier(false); });
  }, [callId, loadingEarlier, take]);

  return { lines, speakers, since, earlier, loaded, loadingEarlier, error, loadEarlier };
}
