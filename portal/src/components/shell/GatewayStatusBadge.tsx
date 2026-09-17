import { useEffect, useState } from 'react';
import { GatewayProxyClient } from '@connorhoehnslalom/realtime-modules/proxy-client';
import type { ConnectionState } from '@connorhoehnslalom/realtime-modules/client/ws';
import { useGateway } from '@connorhoehnslalom/realtime-modules/client/ws';
import { Inline, StatusDot } from '@connorhoehnslalom/ui-components/shared';
import { nextPollDelay, isDocumentHidden } from '../../hooks/pollSchedule';

// VITE_GATEWAY_URL is exposed to the browser bundle by Vite at build time.
// We avoid `import.meta.env` typing concerns (no vite-env.d.ts in this repo)
// by reading via a typed-safe lookup with a sensible local-dev default.
const GATEWAY_URL: string =
  (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env?.VITE_GATEWAY_URL ?? 'http://localhost:8080';

// The bound `fetch` is load-bearing — see the long note in hooks/useGatewayInfo.
// The library defaults to `globalThis.fetch`, keeps it as a class field and
// calls it as `this.fetchImpl(...)`, which re-binds `this` away from `window`.
// In a browser that throws before the request is sent, so this dot had been
// painting red on every page of every deployment while nothing was wrong with
// any gateway. `fetch` is the library's own injection seam; the underlying bug
// is queued in docs/ui-components-queue.md.
const client = new GatewayProxyClient({
  gatewayUrl: GATEWAY_URL,
  fetch: globalThis.fetch.bind(globalThis),
});

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
 * Gateway base URL: `VITE_GATEWAY_URL` (default `http://localhost:8080`).
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

  useEffect(() => {
    let cancelled = false;
    let failures = 0;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const scheduleNext = () => {
      if (isDocumentHidden()) return;
      timeoutId = setTimeout(() => { void check(); }, nextPollDelay(failures, POLL_MS));
    };

    const check = async () => {
      try {
        await client.getHealth();
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
  }, []);

  return (
    <Inline as="span" gap="none" className="inline-flex items-center gap-[3px]">
      {/* StatusDot owns the dot; the colour stays runtime because it is keyed
          off the live status. */}
      <StatusDot
        size="xs"
        color={HTTP_COLORS[httpStatus]}
        title={`gateway HTTP (${GATEWAY_URL}): ${httpStatus}`}
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
