import { useEffect, useMemo, useState } from 'react';
import { GatewayProxyClient } from '@connorhoehnslalom/realtime-modules/proxy-client';
import type {
  GatewayClusterInfo,
  GatewayMetricsResponse,
} from '@connorhoehnslalom/realtime-modules/proxy-client';

// VITE_GATEWAY_URL is exposed to the browser bundle by Vite at build time.
// Mirror the lookup used by GatewayStatusBadge so the URL is sourced once
// and the badge + Settings panel stay in lockstep on which gateway they
// describe.
const GATEWAY_URL: string =
  (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env?.VITE_GATEWAY_URL ?? 'http://localhost:8080';

interface UseGatewayInfoReturn {
  cluster: GatewayClusterInfo | null;
  metrics: GatewayMetricsResponse | null;
  error: string | null;
  isLoading: boolean;
  gatewayUrl: string;
}

/**
 * Second adoption of `@connorhoehnslalom/realtime-modules/proxy-client` in
 * OrgIQ portal (after GatewayStatusBadge). Polls the gateway's
 * unauthenticated `/cluster` + `/metrics` endpoints so the Settings page
 * can render an "About > Gateway" panel (node count, active connections,
 * uptime, redis status).
 *
 * Errors are collapsed into a single string so the caller can render a
 * dash (or the message) without juggling two error channels.
 */
export function useGatewayInfo(pollIntervalMs = 30_000): UseGatewayInfoReturn {
  const client = useMemo(
    () => new GatewayProxyClient({ gatewayUrl: GATEWAY_URL }),
    [],
  );

  const [cluster, setCluster] = useState<GatewayClusterInfo | null>(null);
  const [metrics, setMetrics] = useState<GatewayMetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
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
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Gateway query failed');
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

  return { cluster, metrics, error, isLoading, gatewayUrl: GATEWAY_URL };
}
