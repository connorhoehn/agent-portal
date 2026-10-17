import { useEffect, useMemo, useState } from 'react';
import { createGatewayClient, gatewayEndpoints } from '../lib/gatewayEndpoint.ts';
import { useSession } from '../lib/auth';
import { useRealtimeEndpoints } from '../lib/useRealtimeEndpoints';
import { classifyGatewayError } from './gatewayMode.ts';
export type { GatewayMode } from './gatewayMode.ts';
import type { GatewayMode } from './gatewayMode.ts';
import type {
  GatewayClusterInfo,
  GatewayMetricsResponse,
} from '@connorhoehn/realtime-modules/proxy-client';

// The gateway's URL comes from the realtime-token response (`gatewayUrl`,
// the middleware's REALTIME_GATEWAY_URL), with VITE_GATEWAY_URL as a local
// override only (lib/useRealtimeEndpoints.ts) — the same lookup
// GatewayStatusBadge uses, so the badge and this Settings panel describe the
// same gateway, and one bundle serves every environment instead of baking a
// build-time `localhost` into a deployed portal.

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
 * Second adoption of `@connorhoehn/realtime-modules/proxy-client` in
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
  const { session } = useSession();
  const { gatewayUrl: configuredUrl } = useRealtimeEndpoints(!!session);
  // A malformed URL (gatewayEndpoints throws) reads as "not configured"
  // rather than taking the Settings page down with it.
  const { httpUrl, client } = useMemo(() => {
    try {
      return {
        httpUrl: gatewayEndpoints(configuredUrl ?? undefined)?.http ?? null,
        client: createGatewayClient(configuredUrl ?? undefined),
      };
    } catch {
      return { httpUrl: null, client: null };
    }
  }, [configuredUrl]);

  const [cluster, setCluster] = useState<GatewayClusterInfo | null>(null);
  const [metrics, setMetrics] = useState<GatewayMetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<GatewayMode>(client ? 'loading' : 'bff-only');
  const [isLoading, setIsLoading] = useState(Boolean(client));

  useEffect(() => {
    // The URL arrives after the first render (the token fetch), so the mode
    // follows the client rather than being fixed at mount.
    if (!client) { setMode('bff-only'); setIsLoading(false); return; }
    setMode('loading');
    setIsLoading(true);
    let cancelled = false;

    // The BFF itself can be the configured "gateway" (it hosts /ws but has no
    // /cluster or /metrics). Ask its /health first so a clean mount logs no
    // 404s; a real gateway (or an unreachable one) falls through to the probe.
    let isBff: boolean | null = null;
    const tick = async () => {
      try {
        if (isBff === null && httpUrl) {
          try {
            const res = await fetch(`${httpUrl}/health`, { signal: AbortSignal.timeout(3000) });
            const body = res.ok ? ((await res.json()) as { service?: string }) : null;
            isBff = body?.service === 'orgiq-middleware';
          } catch { isBff = false; }
        }
        if (isBff) {
          if (cancelled) return;
          setMode('bff-only'); setError(null);
          return;
        }
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
  }, [client, httpUrl, pollIntervalMs]);

  return { cluster, metrics, error, isLoading, gatewayUrl: httpUrl ?? 'Not configured', mode };
}
