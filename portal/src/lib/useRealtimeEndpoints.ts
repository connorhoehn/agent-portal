// Where the realtime services are, as the browser reaches them: the gateway,
// platform-api and the LVS SFU. The middleware's realtime-token response
// carries them (`gatewayUrl` / `platformApiUrl` / `videoUrl`, from its
// REALTIME_*_PUBLIC_URL config), so one portal bundle serves every
// environment; the build-time VITE_GATEWAY_URL / VITE_PLATFORM_API_URL /
// VITE_VIDEO_ENDPOINT survive only as local overrides (`realtimeEndpoints`).
//
// Starts from the cached token (`peek`) so a page mounted after the gateway
// provider fetched it has its endpoints on the first render, then fetches when
// signed in. A failed token fetch leaves only the overrides.

import { useEffect, useState } from 'react';
import { realtimeEndpoints, realtimeTokenSource, type RealtimeEndpoints } from './realtimeToken.ts';

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

/** The VITE_* overrides, keyed as realtimeEndpoints() takes them. */
export const REALTIME_ENDPOINT_OVERRIDES = {
  gatewayUrl: env.VITE_GATEWAY_URL,
  platformApiUrl: env.VITE_PLATFORM_API_URL,
  videoUrl: env.VITE_VIDEO_ENDPOINT,
};

export function useRealtimeEndpoints(signedIn: boolean): RealtimeEndpoints {
  const [endpoints, setEndpoints] = useState<RealtimeEndpoints>(
    () => realtimeEndpoints(realtimeTokenSource.peek(), REALTIME_ENDPOINT_OVERRIDES),
  );
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    const keep = (next: RealtimeEndpoints) => setEndpoints((cur) => (
      cur.gatewayUrl === next.gatewayUrl && cur.platformApiUrl === next.platformApiUrl && cur.videoUrl === next.videoUrl ? cur : next
    ));
    realtimeTokenSource.get().then(
      (t) => { if (live) keep(realtimeEndpoints(t, REALTIME_ENDPOINT_OVERRIDES)); },
      () => { if (live) keep(realtimeEndpoints(null, REALTIME_ENDPOINT_OVERRIDES)); },
    );
    return () => { live = false; };
  }, [signedIn]);
  return endpoints;
}
