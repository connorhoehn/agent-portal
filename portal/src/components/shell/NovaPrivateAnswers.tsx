// A private answer from Nova (budget, access request status: docs/meeting-assistant-design.md, decision 6) is sent to
// one person's notification inbox, never the call chat. The bell alone is easy to miss in a call, so while this person
// is in that call it also shows as a toast, marked "Only you can see this". Renders nothing.

import { useEffect, useRef } from 'react';
import { useSharedNotificationsOptional } from './SharedNotifications';
import { useLiveCallId } from './MeetingAssistantBar';
import { toastInfo } from '../../lib/toastStore';

/** An answer older than this arrived before this person was looking (a replay on reconnect): the bell holds it, no toast. */
const FRESH_MS = 30_000;

/** The private reply a notification carries for `callId`, or null. Pure. */
export function privateAnswerOf(n: { id: string; type?: string; body?: string; timestamp?: string; payload?: Record<string, unknown> }, callId: string | null, now: number): { id: string; text: string } | null {
  if (!callId || n.type !== 'assistant-private-reply' || n.payload?.['callId'] !== callId || !n.body) return null;
  const at = n.timestamp ? Date.parse(n.timestamp) : now;
  if (Number.isFinite(at) && now - at > FRESH_MS) return null;
  return { id: n.id, text: n.body };
}

export function NovaPrivateAnswers() {
  const callId = useLiveCallId();
  const inbox = useSharedNotificationsOptional();
  const shown = useRef(new Set<string>());
  const list = inbox?.notifications;
  useEffect(() => {
    if (!callId || !list) return;
    for (const n of list) {
      if (shown.current.has(n.id)) continue;
      const answer = privateAnswerOf(n as Parameters<typeof privateAnswerOf>[0], callId, Date.now());
      if (!answer) continue;
      shown.current.add(answer.id);
      toastInfo('Nova: only you can see this', answer.text);
    }
  }, [callId, list]);
  return null;
}
