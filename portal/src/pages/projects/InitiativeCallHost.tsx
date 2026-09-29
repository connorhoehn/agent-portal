// The orgiq shell's call host (docs/social-calls-plan.md step 5). Mounted
// once in IqLayout, around every /iq page, so:
//
//   - there is ONE useConversationCall for the tenant shell, and a call keeps
//     going while you move between pages (the dock is drawn by the initiative
//     page; elsewhere the call carries on undocked);
//   - incoming rings reach you on any /iq page (useIncomingConversationCalls →
//     IncomingCallToast), and Accept binds the call to the ring's lobby, opens
//     the initiative it is about and answers it;
//   - media has an LVSProvider above it when VITE_VIDEO_ENDPOINT is set. Unset,
//     there is no provider: signalling and the platform-api session still run,
//     and the dock shows initials instead of video.
//
// The call hook wants ONE lobby name. An initiative page `bind`s its lobby
// (tenant-prefixed dm lobby of you + owner + SMEs) while nothing is in
// progress; a ring being answered, or a call that is not idle, holds the
// binding so another page cannot pull the call out from under it.
//
// Tenant scoping here is the lobby PREFIX only. The gateway's
// `calls({ lobbyGuard })` would refuse a lobby outside the caller's org, but
// the gateway is realtime-examples' server, not ours, so nothing enforces it
// yet (docs/social-calls-plan.md step 7).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
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
import { IncomingCallToast } from './IncomingCallToast';
import { initiativeFromChannel } from './initiativeCallModel';

export interface CallLobby {
  lobbyName: string;
  /** What the dock's title says (the initiative's name). */
  title: string;
  /** Rides the invite so the callee's toast can open the initiative. */
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

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const VIDEO_ENDPOINT = env.VITE_VIDEO_ENDPOINT?.trim() || null;
const PLATFORM_API_ENV = env.VITE_PLATFORM_API_URL?.trim() || null;

// The hook needs a lobby even while nothing is bound; discovery is off then,
// so this name is never sent anywhere.
const UNBOUND = '__unbound__';
const getIdToken = async (): Promise<string> => (await realtimeTokenSource.get()).token;
// LVSProvider's own token is a placeholder: useConversationCall overrides it
// per call with the participant token platform-api mints.
const noToken = (): string => '';

/**
 * The browser-facing platform-api URL. VITE_PLATFORM_API_URL wins: the
 * middleware's PLATFORM_API_URL (echoed by the realtime token) may be an
 * internal address the browser cannot reach (docs/social-calls-plan.md,
 * "Deploying it" risk 3). The token's value is the fallback.
 */
function usePlatformApiUrl(signedIn: boolean): string | null {
  const [fromToken, setFromToken] = useState<string | null>(null);
  useEffect(() => {
    if (PLATFORM_API_ENV || !signedIn) return;
    let live = true;
    realtimeTokenSource.get().then(
      (t) => { if (live) setFromToken(t.platformApiUrl ?? null); },
      () => { if (live) setFromToken(null); },
    );
    return () => { live = false; };
  }, [signedIn]);
  return PLATFORM_API_ENV ?? fromToken;
}

function CallHost({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const navigate = useNavigate();
  const frames = useGatewayFrames();
  const self = useMemo(
    () => (session ? { userId: session.sub, displayName: session.name || session.sub } : null),
    [session],
  );
  const platformApiUrl = usePlatformApiUrl(!!session);
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
      const initiative = initiativeFromChannel(ring.channel);
      if (initiative) navigate(`/iq/projects/${encodeURIComponent(initiative)}`);
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

/** The shell mount: LVS (when configured) around the call host. */
export function InitiativeCallHost({ children }: { children: ReactNode }) {
  const host = <CallHost>{children}</CallHost>;
  return VIDEO_ENDPOINT
    ? <LVSProvider baseUrl={VIDEO_ENDPOINT} getAuthToken={noToken}>{host}</LVSProvider>
    : host;
}
