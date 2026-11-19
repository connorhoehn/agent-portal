// The candidate hears Milo (docs/interviews-tenant-plan.md decisions 9, 10; rows I3.5, I3.8; contract U9). Lane SPEAK's file;
// GUEST leaves two marked places in JoinRoom.tsx and the integrator joins them.
//
//   GuestMiloVoice     plays Milo's voice on the socket the candidate's page already holds (GuestCallHost's): the `assistant-audio`
//                      frames on the call chat's channel `orgiq:huddle:<callId>`, through the same player the Work footer uses
//                      (lib/assistantVoice.ts). The server relays only approved words in an interview, so every frame that comes is
//                      meant for the candidate's ears. Under the call stage, a caption of what Milo is saying: Milo's lines read
//                      from the same channel's chat frames (a guest receives only Milo's approved lines; the answers to its
//                      requests are left out by their fixed words, lib/interviewsRoom.ts `lastMiloLineOf`), and Milo's answers to
//                      the candidate's requests. guestMiloCaption.ts holds its kind, label and clearing.
//   GuestMiloRequests  "Repeat the question" and "How much time is left?": POST /api/interview-invite/milo/request; the server's
//                      sentence becomes Milo's caption. Milo also says it aloud when it is listening with its voice on.
//
// Neither opens a socket or joins a channel; both render nothing until the candidate is in the call.
import { useEffect, useRef, useState, type JSX } from 'react';
import { Button, Card, Chip, Inline, Stack, T } from '@connorhoehn/ui-components/shared';
import { AssistantMark } from '@connorhoehn/ui-components/social';
import { SpeakerIcon } from '@connorhoehn/ui-components/video';
import { useAssistantVoice } from '../../lib/assistantVoice';
import { useGatewayFrames } from '../../lib/gatewayFrames';
import { hasJoinedCall } from '../../components/shell/callShellModel';
import { useCallHost } from '../../lib/conversationCall';
import { lastMiloLineOf, type MiloLastLine } from '../../lib/interviewsRoom';
import { NO_ASSISTANT } from '../../lib/meetingAssistantModel';
import { GUEST_API } from './guestApi';
import {
  MILO_CAPTION_SPEAKER, captionClearsAt, captionFromChat, captionFromRequest, captionKindLabel, replacesCaption,
  type MiloCaption, type MiloRequestAnswer,
} from './guestMiloCaption';
import type { GuestRoom } from './steps';

export type { MiloRequestAnswer } from './guestMiloCaption';

/** The call the candidate is in now, or null before they join (or after they leave). */
function useJoinedCallId(room: GuestRoom): string | null {
  const host = useCallHost();
  const call = host?.call;
  const here = host?.lobby?.lobbyName === room.lobbyName;
  return here && call && hasJoinedCall(call.call, call.phase) ? call.call?.callId ?? null : null;
}

/** The player is told the voice is on and Milo listening: the server only relays Milo's voice in an interview when it is. */
const heardView = (callId: string) => ({ ...NO_ASSISTANT(callId), voice: true, phase: 'listening' as const });

/**
 * Milo's caption under the call stage: what Milo is saying, drawn the way the call chat draws Milo's rows (its mark and name), on a
 * surface of its own. A question is tinted and marked "Question"; anything else (its introduction, a confirmation, the time) sits
 * on the plain surface. It appears with the line, shows "Speaking" while the voice plays, and clears a while after the voice stops
 * (guestMiloCaption.ts `captionClearsAt`) or when the next line comes. The region is polite-live, so a screen reader reads each line.
 */
export function GuestMiloVoice({ room, answer = null }: { room: GuestRoom; answer?: MiloRequestAnswer | null }): JSX.Element | null {
  const callId = useJoinedCallId(room);
  const voice = useAssistantVoice(callId, heardView(callId ?? ''));
  const { gateway } = useGatewayFrames();
  const [last, setLast] = useState<MiloLastLine | null>(null);
  const [caption, setCaption] = useState<MiloCaption | null>(null);
  const seq = useRef(0);
  const show = (make: (n: number) => MiloCaption) => setCaption((cur) => {
    const next = make(seq.current + 1);
    if (!replacesCaption(cur, next)) return cur;
    seq.current = next.seq;
    return next;
  });
  useEffect(() => {
    setLast(null); setCaption(null);
    if (!callId) return undefined;
    const channel = `orgiq:huddle:${callId}`;
    return gateway.onMessage((frame) => setLast((cur) => lastMiloLineOf(frame, channel, cur)));
  }, [callId, gateway.onMessage]);
  // A new line of Milo's in the chat (lastMiloLineOf hands back the same object when a frame holds none).
  useEffect(() => { if (last) show((n) => captionFromChat(last, n, Date.now())); }, [last]); // eslint-disable-line react-hooks/exhaustive-deps
  // Milo's answer to the candidate's request. A sentence of ours when Milo did not answer is a plain note below, not Milo's words.
  useEffect(() => { if (answer?.ok) show((n) => captionFromRequest(answer, last, n)); }, [answer]); // eslint-disable-line react-hooks/exhaustive-deps
  // Clearing: never while the voice plays; the hold counts from when it stopped.
  const stoppedAt = useRef<number | null>(null);
  useEffect(() => { if (!voice.speaking) stoppedAt.current = Date.now(); }, [voice.speaking]);
  useEffect(() => {
    if (!caption) return undefined;
    const at = captionClearsAt(caption, voice.speaking, stoppedAt.current);
    if (at === null) return undefined;
    const t = setTimeout(() => setCaption((cur) => (cur?.seq === caption.seq ? null : cur)), Math.max(0, at - Date.now()));
    return () => clearTimeout(t);
  }, [caption, voice.speaking]);
  if (!callId || room.state !== 'open') return null;
  const note = answer && !answer.ok ? answer.text : null;
  return <Stack gap="xs" align="center" className="shrink-0 px-4 pb-2" data-testid="guest-milo-voice"
    data-voice-frames={voice.framesPlayed} data-voice-speaking={String(voice.speaking)}>
    {/* Always mounted, so the polite announcement fires when a line arrives; the caption is keyed by its sequence, so a repeated
        question is read again. */}
    <Stack gap="none" align="stretch" className="w-full max-w-2xl" role="status" aria-live="polite" data-testid="guest-milo-caption">
      {caption && <MiloCaptionCard key={caption.seq} caption={caption} speaking={voice.speaking} />}
    </Stack>
    {voice.needsGesture && <Button variant="ghost" size="sm" onClick={() => void voice.enableSound()} data-testid="guest-milo-enable-sound">Click to hear Milo</Button>}
    {note && <T size="xs" tone="warning" wrap role="status" data-testid="guest-milo-line">{note}</T>}
  </Stack>;
}

/** One caption: Milo's mark and name (as the call chat draws Milo's rows), the kind and the speaking state, then the words, whole. */
function MiloCaptionCard({ caption, speaking }: { caption: MiloCaption; speaking: boolean }) {
  const question = caption.kind === 'question';
  const kind = captionKindLabel(caption.kind);
  // The words keep the ids the walks read: a line from the chat (or the question again) is the question line; Milo's answer to a
  // request is the request's line.
  const wordsId = caption.source === 'request' ? 'guest-milo-line' : 'guest-milo-question';
  return <Card tone={question ? 'assistant' : 'default'} padding="sm" data-testid="guest-milo-question-line"
    data-milo-verb={question ? 'asked' : 'said'} data-milo-source={caption.source}>
    <Inline gap="sm" align="start" wrap={false} className="min-w-0">
      <AssistantMark size={24} />
      <Stack gap="xs" className="min-w-0 flex-1">
        <Inline gap="xs" align="center">
          <T size="xs" weight="semibold">{MILO_CAPTION_SPEAKER}</T>
          {kind && <Chip size="xs" tone="accent" data-testid="guest-milo-kind">{kind}</Chip>}
          {speaking && <Chip size="xs" tone="info" icon={<SpeakerIcon size={12} />} data-testid="guest-milo-speaking">Speaking</Chip>}
        </Inline>
        <T size="sm" weight={question ? 'medium' : 'normal'} wrap data-testid={wordsId}>{caption.text}</T>
      </Stack>
    </Inline>
  </Card>;
}

/**
 * The two fixed requests (decision 10), as plain buttons in the bar. The server's answer goes to `onLine`: the room shows it as
 * Milo's caption under the stage (UI round 3: with both buttons, the time and the call's controls, the bar has no room left for a
 * sentence at 1280).
 */
export function GuestMiloRequests({ room, onLine }: { room: GuestRoom; onLine(answer: MiloRequestAnswer | null): void }): JSX.Element | null {
  const callId = useJoinedCallId(room);
  const [busy, setBusy] = useState(false);
  if (!callId || room.state !== 'open') return null;
  const ask = async (request: 'repeat' | 'time') => {
    if (busy) return;
    setBusy(true);
    onLine(await requestFromMilo(request));
    setBusy(false);
  };
  return <Inline gap="xs" align="center" wrap={false} className="shrink-0" data-testid="guest-milo-requests">
    <Button variant="secondary" size="sm" className="whitespace-nowrap" disabled={busy} onClick={() => void ask('repeat')} data-testid="guest-milo-repeat">Repeat the question</Button>
    <Button variant="secondary" size="sm" className="whitespace-nowrap" disabled={busy} onClick={() => void ask('time')} data-testid="guest-milo-time">How much time is left?</Button>
  </Inline>;
}

/** The request: the route's sentence (`ok`), or, when it refuses or does not answer, its error or one of ours (not Milo's words). */
async function requestFromMilo(request: 'repeat' | 'time'): Promise<MiloRequestAnswer> {
  const at = Date.now();
  try {
    const res = await fetch(`${GUEST_API}/milo/request`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }),
    });
    const body = await res.json().catch(() => null) as { line?: unknown; error?: unknown } | null;
    if (res.ok && typeof body?.line === 'string') return { text: body.line, ok: true, at };
    if (typeof body?.error === 'string') return { text: body.error, ok: false, at };
  } catch { /* below */ }
  return { text: 'Milo could not answer just now. Try again in a moment.', ok: false, at };
}
