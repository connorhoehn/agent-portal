// The room's live hints (middleware lib/interviews/live-hint.ts): the activity feed on the interview's lobby name, where the
// server says a candidate knocked or the lead ended. One event calls `onHint` once and the page reads again; the read decides.
// Only that interview's seats can subscribe, so another interview's member hears nothing. Draws nothing, and nothing at all
// without a gateway (the pages' slow poll still finds the change).
import { useEffect, useRef } from 'react';
import { useActivity, useGatewayOptional } from '@connorhoehn/realtime-modules/client';
import { hintsAfter, interviewLobbyName } from './interviewsRoom';

export type InterviewHint = { knock: boolean; ended: boolean };

function Listening({ interviewId, onHint }: { interviewId: string; onHint(hint: InterviewHint): void }) {
  const { events } = useActivity(interviewLobbyName(interviewId));
  const seen = useRef(events.length);
  const handler = useRef(onHint);
  handler.current = onHint;
  useEffect(() => {
    const hints = hintsAfter(events, seen.current, interviewId);
    seen.current = hints.next;
    if (hints.knock || hints.ended) handler.current({ knock: hints.knock, ended: hints.ended });
  }, [events, interviewId]);
  return null;
}

export function InterviewHintListener({ interviewId, onHint }: { interviewId: string | null; onHint(hint: InterviewHint): void }) {
  const gateway = useGatewayOptional();
  return gateway && interviewId ? <Listening key={interviewId} interviewId={interviewId} onHint={onHint} /> : null;
}
