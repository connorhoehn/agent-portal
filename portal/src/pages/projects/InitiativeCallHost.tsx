// The orgiq shell's call host (docs/social-calls-plan.md step 5). Mounted
// once in IqLayout, around every /iq page, so:
//
//   - there is ONE useConversationCall for the tenant shell, and a call keeps
//     going while you move between pages (the dock is drawn by the initiative
//     page; elsewhere the call carries on undocked);
//   - incoming rings reach you on any /iq page (useIncomingConversationCalls →
//     IncomingCallToast, lib/conversationCall.tsx), and Accept binds the call
//     to the ring's lobby, opens what it is about (the initiative, or Search on
//     the same people — callChannelHref) and answers it;
//   - media has an LVSProvider above it when the SFU's URL is known (the
//     realtime token's `videoUrl`, or VITE_VIDEO_ENDPOINT). Unknown, there is
//     no provider: signalling and the platform-api session still run,
//     and the dock shows initials instead of video.
//
// The call hook wants ONE lobby name. A page that can start a call `bind`s its
// lobby (the tenant-prefixed dm lobby of you + the people it would ring: an
// initiative's owner + SMEs, or the people selected on Search) while nothing
// is in progress; a ring being answered, or a call that is not idle, holds the
// binding so another page cannot pull the call out from under it.
//
// Tenant scoping: the lobby is tenant-prefixed, and the middleware's own
// gateway (`/ws`, `calls({ lobbyGuard })`) refuses a lobby outside the
// caller's tenant (docs/social-calls-plan.md step 7).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  LVSProvider,
  useConversationCall,
  useIncomingConversationCalls,
  type ConversationCallResult,
  type IncomingConversationCall,
} from '@connorhoehnslalom/realtime-modules/client/video';
import { useSession } from '../../lib/auth';
import { useGatewayFrames } from '../../lib/gatewayFrames';
import { realtimeTokenSource } from '../../lib/realtimeToken';
import { useRealtimeEndpoints } from '../../lib/useRealtimeEndpoints';
import { IncomingCallToast } from '../../lib/conversationCall';
import { callChannelHref } from '../../lib/conversationCallModel';

export interface CallLobby {
  lobbyName: string;
  /** What the dock's title says (the initiative's name, the people on Search). */
  title: string;
  /** Rides the invite so the callee's Accept can open what the call is about (callChannelHref). */
  channel: string | null;
}

export interface InitiativeCallHostValue {
  call: ConversationCallResult;
  /** The lobby the call is bound to; null until a page binds one or a ring is answered. */
  lobby: CallLobby | null;
  /** Bind this page's lobby. Ignored while a call is in progress or a ring is being answered. */
  bind(lobby: CallLobby): void;
  self: { userId: string; displayName: string } | null;
  tenant: string | null;
  gatewayConfigured: boolean;
  connectionState: string;
  /** platform-api base URL the browser can reach, or null (calls unavailable). */
  platformApiUrl: string | null;
}

const Ctx = createContext<InitiativeCallHostValue | null>(null);

export function useInitiativeCallHost(): InitiativeCallHostValue | null {
  return useContext(Ctx);
}

// The hook needs a lobby even while nothing is bound; discovery is off then,
// so this name is never sent anywhere.
const UNBOUND = '__unbound__';
const getIdToken = async (): Promise<string> => (await realtimeTokenSource.get()).token;
// LVSProvider's own token is a placeholder: useConversationCall overrides it
// per call with the participant token platform-api mints.
const noToken = (): string => '';

function CallHost({ children, platformApiUrl }: { children: ReactNode; platformApiUrl: string | null }) {
  const { session } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const here = `${location.pathname}${location.search}`;
  const frames = useGatewayFrames();
  const self = useMemo(
    () => (session ? { userId: session.sub, displayName: session.name || session.sub } : null),
    [session],
  );
  const [lobby, setLobby] = useState<CallLobby | null>(null);
  const pendingRing = useRef<IncomingConversationCall | null>(null);

  const call = useConversationCall({
    lobbyName: lobby?.lobbyName ?? UNBOUND,
    channel: lobby?.channel ?? null,
    self: self ?? { userId: '', displayName: '' },
    platformApi: { baseUrl: platformApiUrl ?? '', getIdToken },
    gateway: frames.gateway,
    discover: !!lobby && frames.configured,
  });
  const phaseRef = useRef(call.phase);
  phaseRef.current = call.phase;

  const bind = useCallback((next: CallLobby) => {
    if (pendingRing.current) return;
    const phase = phaseRef.current;
    if (phase !== 'idle' && phase !== 'ringing') return;
    setLobby((cur) => (cur && cur.lobbyName === next.lobbyName && cur.title === next.title && cur.channel === next.channel ? cur : next));
  }, []);

  const rings = useIncomingConversationCalls({
    gateway: frames.gateway,
    self: { userId: self?.userId ?? null, ...(self ? { displayName: self.displayName } : {}) },
    onAccept: (ring) => {
      pendingRing.current = ring;
      setLobby({ lobbyName: ring.lobbyName, title: ring.callerName, channel: ring.channel });
      const href = callChannelHref(ring.channel);
      if (href && href !== here) navigate(href);
    },
  });

  // Answer once the hook is bound to the ring's lobby: it creates/joins the
  // platform-api session under ITS lobby name, not the ring's.
  const accept = call.accept;
  useEffect(() => {
    const ring = pendingRing.current;
    if (!ring || lobby?.lobbyName !== ring.lobbyName) return;
    pendingRing.current = null;
    void accept(ring);
  }, [lobby, accept]);

  const value = useMemo<InitiativeCallHostValue>(() => ({
    call, lobby, bind, self,
    tenant: session?.tenant ?? null,
    gatewayConfigured: frames.configured,
    connectionState: frames.connectionState,
    platformApiUrl,
  }), [call, lobby, bind, self, session?.tenant, frames.configured, frames.connectionState, platformApiUrl]);

  const head = rings.rings[0] ?? null;
  return (
    <Ctx.Provider value={value}>
      {children}
      {head && (
        <IncomingCallToast
          ring={head}
          onAccept={() => rings.accept(head)}
          onDecline={() => rings.decline(head)}
        />
      )}
    </Ctx.Provider>
  );
}

/**
 * The shell mount: LVS (when the SFU's URL is known) around the call host.
 * Endpoints come from the realtime-token response (`useRealtimeEndpoints`),
 * with VITE_PLATFORM_API_URL / VITE_VIDEO_ENDPOINT as local overrides. The
 * video URL is latched: once LVS is mounted it stays mounted, so a token
 * refresh can never pull the provider out from under a live call. (Arriving
 * after the first render — a cold token — remounts the page once, before any
 * call can exist.)
 */
export function InitiativeCallHost({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const { platformApiUrl, videoUrl } = useRealtimeEndpoints(!!session);
  const latched = useRef<string | null>(null);
  if (videoUrl && !latched.current) latched.current = videoUrl;
  const video = latched.current;
  const host = <CallHost platformApiUrl={platformApiUrl}>{children}</CallHost>;
  return video
    ? <LVSProvider baseUrl={video} getAuthToken={noToken}>{host}</LVSProvider>
    : host;
}
