// What the Settings "Gateway" panel and the header's health dot are actually
// looking at — kept pure, and separate from the hook, so it can be tested the
// way pollSchedule.ts is (this repo's tests are plain node:test with no React
// renderer; see hooks/__tests__/useFetch.test.ts for the same split).
//
// The distinction that matters is BFF-ONLY vs DOWN, and it had never been
// drawn. This deployment points `VITE_GATEWAY_URL` at the middleware on
// purpose — `useLocalComputeStream.ts` and the assessment knowledge surface
// both say so in their own headers, and both were deliberately built to ride
// server-sent events instead. The middleware answers; it simply is not a
// gateway, so it has no `/cluster` and no `/metrics`. A 404 from a server that
// replied is that fact, not a fault, and rendering it as four dashes plus a
// raw exception string told the reader a healthy system was broken.

import {
  ProxyClientHttpError,
  ProxyClientNetworkError,
  ProxyClientTimeoutError,
} from '@connorhoehn/realtime-modules/proxy-client';

export type GatewayMode = 'loading' | 'live' | 'bff-only' | 'unreachable';

export interface GatewayVerdict {
  mode: Exclude<GatewayMode, 'loading' | 'live'>;
  /** A sentence for a reader, or null when there is nothing wrong. */
  message: string | null;
}

/**
 * Classify a failed probe into something a person can act on.
 *
 * The three outcomes call for genuinely different actions — reconfigure (this
 * host is not a gateway), go look (it is not answering), or read the message —
 * so they must not share one rendering. The library hands us the distinction
 * through its own error subclasses, which is why nothing here parses a string.
 *
 * A 405 counts with 404: a host that routes the path but refuses the method is
 * equally "serving, but not this API".
 */
export function classifyGatewayError(err: unknown): GatewayVerdict {
  if (err instanceof ProxyClientHttpError && (err.status === 404 || err.status === 405)) {
    return { mode: 'bff-only', message: null };
  }
  if (err instanceof ProxyClientNetworkError) {
    return {
      mode: 'unreachable',
      message: 'Not answering — check that the gateway is running and reachable from the browser.',
    };
  }
  if (err instanceof ProxyClientTimeoutError) {
    return { mode: 'unreachable', message: 'Timed out before replying.' };
  }
  if (err instanceof ProxyClientHttpError) {
    return { mode: 'unreachable', message: `Answered ${err.status}.` };
  }
  return { mode: 'unreachable', message: 'Could not be read.' };
}
