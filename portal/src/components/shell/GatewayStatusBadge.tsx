import { useEffect, useMemo, useState } from 'react';
import { createGatewayClient, gatewayEndpoints } from '../../lib/gatewayEndpoint.ts';
import { useSession } from '../../lib/auth';
import { useRealtimeEndpoints } from '../../lib/useRealtimeEndpoints';
import type { ConnectionState } from '@connorhoehn/realtime-modules/client/ws';
import { useGateway } from '@connorhoehn/realtime-modules/client/ws';
import { Inline, StatusDot } from '@connorhoehnslalom/ui-components/shared';
import { nextPollDelay, isDocumentHidden } from '../../hooks/pollSchedule';

// The gateway's URL comes from the realtime-token response (`gatewayUrl`),
// with VITE_GATEWAY_URL as a local override (lib/useRealtimeEndpoints.ts).
// Unknown, the badge renders nothing and makes no requests.
//
// The bound `fetch` is load-bearing — see the long note in hooks/useGatewayInfo.
// The library defaults to `globalThis.fetch`, keeps it as a class field and
// calls it as `this.fetchImpl(...)`, which re-binds `this` away from `window`.
// In a browser that throws before the request is sent, so this dot had been
// painting red on every page of every deployment while nothing was wrong with
// any gateway. `fetch` is the library's own injection seam (createGatewayClient
// passes it); the underlying bug is queued in docs/ui-components-queue.md.

type HttpStatus = 'unknown' | 'healthy' | 'unhealthy';

const HTTP_COLORS: Record<HttpStatus, string> = {
  unknown: 'var(--color-text-tertiary)',
  healthy: 'var(--color-success, #10b981)',
  unhealthy: 'var(--color-danger, #ef4444)',
};

const WS_COLORS: Record<ConnectionState, string> = {
  idle: 'var(--color-text-tertiary)',
  connecting: 'var(--color-warning, #f59e0b)',
  connected: 'var(--color-success, #10b981)',
  reconnecting: 'var(--color-warning, #f59e0b)',
  disconnected: 'var(--color-danger, #ef4444)',
};

const POLL_MS = 30_000;

/**
 * Gateway status indicator showing two signals side-by-side:
 *
 *  1. HTTP health dot — polls `/health` every 30 s via GatewayProxyClient
 *     (green = healthy, red = unhealthy, gray = unknown).
 *  2. WS connection dot — real-time state from `useGatewaySocket` context
 *     (green = connected, amber = connecting/reconnecting, red = disconnected,
 *     gray = idle).
 *
 * The HTTP poll and WS connection are independent; both are kept so structured
 * health data (uptime, node count) remains available without a live WS.
 *
 * Gateway base URL: the realtime token's `gatewayUrl` (VITE_GATEWAY_URL overrides);
 * no indicator or polling when neither is known.
 *
 * Not `useFetch`: the gateway is a separate origin from the portal's `/api`
 * and this client's `request()` sends no `credentials`, so routing it
 * through `useFetch` (which always fetches with `credentials: 'include'`)
 * would change a same-origin-safe call into a cross-origin credentialed one
 * with no corresponding CORS contract on the gateway side. The scheduling —
 * visibility-pause and failure backoff — is still shared with `useFetch` via
 * `hooks/pollSchedule`, so this differs from it only in the transport.
 */
export function GatewayStatusBadge() {
  const [httpStatus, setHttpStatus] = useState<HttpStatus>('unknown');
  const { connectionState } = useGateway();
  const { session } = useSession();
  const { gatewayUrl } = useRealtimeEndpoints(!!session);
  // A malformed URL (gatewayEndpoints throws) hides the badge rather than the page.
  const { gatewayHttp, client } = useMemo(() => {
    try {
      return { gatewayHttp: gatewayEndpoints(gatewayUrl ?? undefined)?.http ?? null, client: createGatewayClient(gatewayUrl ?? undefined) };
    } catch {
      return { gatewayHttp: null, client: null };
    }
  }, [gatewayUrl]);

  useEffect(() => {
    if (!client) return;
    const gatewayClient = client;
    let cancelled = false;
    let failures = 0;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const scheduleNext = () => {
      if (isDocumentHidden()) return;
      timeoutId = setTimeout(() => { void check(); }, nextPollDelay(failures, POLL_MS));
    };

    const check = async () => {
      try {
        await gatewayClient.getHealth();
        if (!cancelled) { setHttpStatus('healthy'); failures = 0; }
      } catch {
        if (!cancelled) { setHttpStatus('unhealthy'); failures += 1; }
      } finally {
        if (!cancelled) scheduleNext();
      }
    };

    const onVisibilityChange = () => {
      if (isDocumentHidden()) {
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = undefined; }
        return;
      }
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = undefined; }
      void check();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    void check();

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [client]);

  if (!client) return null;

  return (
    <Inline as="span" gap="none" className="inline-flex items-center gap-[3px]">
      {/* StatusDot owns the dot; the colour stays runtime because it is keyed
          off the live status. */}
      <StatusDot
        size="xs"
        color={HTTP_COLORS[httpStatus]}
        title={`gateway HTTP (${gatewayHttp}): ${httpStatus}`}
        aria-label={`gateway HTTP status: ${httpStatus}`}
      />
      <StatusDot
        size="xs"
        color={WS_COLORS[connectionState]}
        title={`gateway WS: ${connectionState}`}
        aria-label={`gateway WebSocket status: ${connectionState}`}
      />
    </Inline>
  );
}
