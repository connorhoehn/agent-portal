// The candidate's call host (docs/interviews-tenant-plan.md row I2.4, the candidate's side; decision 21).
//
// The same call runtime the shell runs (lib/conversationCall.tsx `CallHostProvider`, the library's call block host),
// fed from the guest side instead of the staff session, because /join mounts with no router, no session provider
// and no shell (main.tsx):
//   - the gateway socket: the app's own `OptionalGatewayProvider`, handed the guest token source
//     (pages/join/guestRealtime.ts), so the socket authenticates with the guest's token exactly as the staff one
//     does with the staff token, and learns the gateway's address from the token answer (D1);
//   - the call frames: `useGatewayFrames()` over that socket, as ShellCallHost reads them;
//   - who and where: D1's `self` (the token's `guest:<inviteId>`, "Candidate"), the interviews tenant, and the
//     endpoints from the guest token answer (a local VITE_* override still wins, as for staff);
//   - nothing the shell adds around the host: no ring navigation (a guest is never rung), no call log reports, no
//     directory names, no meeting (rooms), no huddle chat provider (the guest's chat is pages/join/GuestRoomChat).
// The one playback sink (`CallMediaOutlet`) sits in the room's footer, as the shell's does (JoinRoom).
import { useCallback, useMemo, type ReactNode } from 'react';
import { OptionalGatewayProvider } from '../../components/OptionalGatewayProvider';
import { CallHostProvider } from '../../lib/conversationCall';
import { useGatewayFrames } from '../../lib/gatewayFrames';
import { realtimeEndpoints, type RealtimeToken, type RealtimeTokenSource } from '../../lib/realtimeToken';
import { REALTIME_ENDPOINT_OVERRIDES } from '../../lib/useRealtimeEndpoints';
import { guestRoomNameFor } from '../../lib/interviewsRoom';
import type { GuestPanel } from './steps.ts';

/** The candidate's own pre-join choices, kept apart from a staff member's on the same device. */
const GUEST_PRE_JOIN_KEY = 'interviews.guest-prejoin.v1';

export interface GuestCallHostProps {
  /** The first guest token (its endpoints place the call); later ones come from `tokens`. */
  token: RealtimeToken;
  tokens: RealtimeTokenSource;
  self: { userId: string; displayName: string };
  /** Who the candidate meets (the lead's name and how many others), for the tiles' names. */
  panel?: GuestPanel | null;
  children: ReactNode;
}

export function GuestCallHost({ token, tokens, self, panel = null, children }: GuestCallHostProps) {
  return <OptionalGatewayProvider url={REALTIME_ENDPOINT_OVERRIDES.gatewayUrl} tokens={tokens}>
    <GuestHost token={token} tokens={tokens} self={self} panel={panel}>{children}</GuestHost>
  </OptionalGatewayProvider>;
}

function GuestHost({ token, tokens, self, panel = null, children }: GuestCallHostProps) {
  const frames = useGatewayFrames();
  const { platformApiUrl, videoUrl } = realtimeEndpoints(token, REALTIME_ENDPOINT_OVERRIDES);
  const getIdToken = useCallback(async () => (await tokens.get()).token, [tokens]);
  const who = useMemo(() => ({ userId: self.userId, displayName: self.displayName }), [self.userId, self.displayName]);
  // The tiles' names: the call knows the panel only by their ids, which the candidate must never read.
  const nameFor = useMemo(() => guestRoomNameFor(self.userId, panel), [self.userId, panel?.lead, panel?.others]); // eslint-disable-line react-hooks/exhaustive-deps
  return <CallHostProvider scopeKey={JSON.stringify(['interviews', who.userId])} self={who} tenant="interviews"
    platformApiUrl={platformApiUrl} getIdToken={getIdToken} videoUrl={videoUrl}
    gateway={frames.gateway} gatewayConfigured={frames.configured} connectionState={frames.connectionState}
    preJoinStorageKey={GUEST_PRE_JOIN_KEY} meeting={false} callNoun="call" nameFor={nameFor}>
    {children}
  </CallHostProvider>;
}
