import { useEffect, useMemo, useState } from 'react';
import { createGatewayClient, gatewayEndpoints } from '../lib/gatewayEndpoint.ts';
import { classifyGatewayError } from './gatewayMode.ts';
export type { GatewayMode } from './gatewayMode.ts';
import type { GatewayMode } from './gatewayMode.ts';
import type {
  GatewayClusterInfo,
  GatewayMetricsResponse,
} from '@connorhoehnslalom/realtime-modules/proxy-client';

// VITE_GATEWAY_URL is exposed to the browser bundle by Vite at build time.
// Mirror the lookup used by GatewayStatusBadge so the URL is sourced once
// and the badge + Settings panel stay in lockstep on which gateway they
// describe.
const CONFIGURED_GATEWAY_URL =
  (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env?.VITE_GATEWAY_URL;
const GATEWAY_URL = gatewayEndpoints(CONFIGURED_GATEWAY_URL)?.http;

interface UseGatewayInfoReturn {
  cluster: GatewayClusterInfo | null;
  metrics: GatewayMetricsResponse | null;
  /** A sentence for a reader. Null whenever there is nothing wrong. */
  error: string | null;
  isLoading: boolean;
  gatewayUrl: string;
  mode: GatewayMode;
}

/**
 * Second adoption of `@connorhoehnslalom/realtime-modules/proxy-client` in
 * OrgIQ portal (after GatewayStatusBadge). Polls the gateway's
 * unauthenticated `/cluster` + `/metrics` endpoints so the Settings page
 * can render an "About > Gateway" panel (node count, active connections,
 * uptime, redis status).
 *
 * ⚠️ The bound `fetch` below is load-bearing, not defensive. The library
 * defaults to `globalThis.fetch`, stores it as a class field and calls it as
 * `this.fetchImpl(url, init)` — which re-binds `this` to the client instance.
 * Node tolerates that, which is where the library's tests run; a browser
 * throws `TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation`
 * before a single request leaves the page. That is why this panel had never
 * shown a number in a browser. `fetch` is the library's own documented
 * injection seam, so passing a bound one is using the API rather than working
 * around it; the underlying bug is queued in docs/ui-components-queue.md.
 */
export function useGatewayInfo(pollIntervalMs = 30_000): UseGatewayInfoReturn {
  const client = useMemo(
    () => createGatewayClient(CONFIGURED_GATEWAY_URL),
    [],
  );

  const [cluster, setCluster] = useState<GatewayClusterInfo | null>(null);
  const [metrics, setMetrics] = useState<GatewayMetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<GatewayMode>(client ? 'loading' : 'bff-only');
  const [isLoading, setIsLoading] = useState(Boolean(client));

  useEffect(() => {
    if (!client) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const [c, m] = await Promise.all([
          client.getClusterInfo(),
          client.getMetrics(),
        ]);
        if (cancelled) return;
        setCluster(c);
        setMetrics(m);
        setError(null);
        setMode('live');
      } catch (err) {
        if (cancelled) return;
        const { mode: m, message } = classifyGatewayError(err);
        setMode(m);
        setError(message);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    tick();
    const id = setInterval(tick, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [client, pollIntervalMs]);

  return { cluster, metrics, error, isLoading, gatewayUrl: GATEWAY_URL ?? 'Not configured', mode };
}
