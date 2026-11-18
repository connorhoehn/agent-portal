// The candidate hears Milo (docs/interviews-tenant-plan.md decisions 9, 10; rows I3.5, I3.8; contract U9). Lane SPEAK's file;
// GUEST leaves two marked places in JoinRoom.tsx and the integrator joins them.
//
//   GuestMiloVoice     plays Milo's voice on the socket the candidate's page already holds (GuestCallHost's): the `assistant-audio`
//                      frames on the call chat's channel `orgiq:huddle:<callId>`, through the same player the Work footer uses
//                      (lib/assistantVoice.ts). The server relays only approved words in an interview, so every frame that comes is
//                      meant for the candidate's ears. One line: the question Milo last asked, read from the same channel's chat
//                      frames (a guest receives only Milo's approved lines; the answers to its requests are left out by their
//                      fixed words, lib/interviewsRoom.ts `lastAskedOf`).
//   GuestMiloRequests  "Repeat the question" and "How much time is left?": POST /api/interview-invite/milo/request, and the
//                      server's sentence beside them. Milo also says it aloud when it is listening with its voice on.
//
// Neither opens a socket or joins a channel; both render nothing until the candidate is in the call.
import { useEffect, useRef, useState, type JSX } from 'react';
import { Button, Chip, Inline, T } from '@connorhoehn/ui-components/shared';
import { SpeakerIcon } from '@connorhoehn/ui-components/video';
import { useAssistantVoice } from '../../lib/assistantVoice';
import { useGatewayFrames } from '../../lib/gatewayFrames';
import { hasJoinedCall } from '../../components/shell/callShellModel';
import { useCallHost } from '../../lib/conversationCall';
import { lastAskedOf } from '../../lib/interviewsRoom';
import { NO_ASSISTANT } from '../../lib/meetingAssistantModel';
import { GUEST_API } from './guestApi';
import type { GuestRoom } from './steps';

/** The call the candidate is in now, or null before they join (or after they leave). */
function useJoinedCallId(room: GuestRoom): string | null {
  const host = useCallHost();
  const call = host?.call;
  const here = host?.lobby?.lobbyName === room.lobbyName;
  return here && call && hasJoinedCall(call.call, call.phase) ? call.call?.callId ?? null : null;
}

/** The player is told the voice is on and Milo listening: the server only relays Milo's voice in an interview when it is. */
const heardView = (callId: string) => ({ ...NO_ASSISTANT(callId), voice: true, phase: 'listening' as const });

export function GuestMiloVoice({ room, line = null }: { room: GuestRoom; line?: string | null }): JSX.Element | null {
  const callId = useJoinedCallId(room);
  const voice = useAssistantVoice(callId, heardView(callId ?? ''));
  const { gateway } = useGatewayFrames();
  const [asked, setAsked] = useState<string | null>(null);
  useEffect(() => {
    setAsked(null);
    if (!callId) return undefined;
    const channel = `orgiq:huddle:${callId}`;
    return gateway.onMessage((frame) => setAsked((cur) => lastAskedOf(frame, channel, cur)));
  }, [callId, gateway.onMessage]);
  // A repeat answers with the question already on the line (E4 #34): no second copy; the question is announced again instead.
  const repeated = !!asked && !!line && line.trim() === asked.trim();
  const announced = useRef(0);
  const [announce, setAnnounce] = useState(0);
  useEffect(() => { if (repeated) setAnnounce(++announced.current); }, [repeated, line]);
  if (!callId || room.state !== 'open') return null;
  return <Inline gap="sm" align="center" className="min-w-0 px-4 py-1" data-testid="guest-milo-voice"
    data-voice-frames={voice.framesPlayed} data-voice-speaking={String(voice.speaking)}>
    {voice.speaking && <Chip size="xs" tone="info" icon={<SpeakerIcon size={12} />} data-testid="guest-milo-speaking">Milo is speaking</Chip>}
    {/* One line that wraps: the label and the whole question, never cut. A repeat re-mounts it, so a screen reader reads it again. */}
    {asked && <T key={announce} as="p" size="sm" role="status" className="min-w-0 flex-1" data-testid="guest-milo-asked">
      <T as="span" size="sm" weight="medium">Milo asked </T><T as="span" size="sm" data-testid="guest-milo-question">{asked}</T>
    </T>}
    {voice.needsGesture && <Button variant="ghost" size="sm" onClick={() => void voice.enableSound()} data-testid="guest-milo-enable-sound">Click to hear Milo</Button>}
    {/* The server's sentence to the candidate's last request, on this line rather than in the bar, so the bar never wraps at 1280. */}
    {line && !repeated && <T size="xs" tone="secondary" title={line} className="ml-auto" role="status" data-testid="guest-milo-line">{line}</T>}
  </Inline>;
}

/**
 * The two fixed requests (decision 10), as plain buttons in the bar. The server's sentence goes to `onLine`: the room shows it on
 * GuestMiloVoice's line above the bar (UI round 3: with both buttons, the time and the call's controls, the bar has no room left
 * for a sentence at 1280).
 */
export function GuestMiloRequests({ room, onLine }: { room: GuestRoom; onLine(line: string | null): void }): JSX.Element | null {
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

/** The request; a plain sentence whatever happens (the route's own, or one of ours when it does not answer). */
async function requestFromMilo(request: 'repeat' | 'time'): Promise<string> {
  try {
    const res = await fetch(`${GUEST_API}/milo/request`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }),
    });
    const body = await res.json().catch(() => null) as { line?: unknown; error?: unknown } | null;
    if (res.ok && typeof body?.line === 'string') return body.line;
    if (typeof body?.error === 'string') return body.error;
  } catch { /* below */ }
  return 'Milo could not answer just now. Try again in a moment.';
}
