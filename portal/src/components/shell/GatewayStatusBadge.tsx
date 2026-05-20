import { useEffect, useState } from 'react';
import { GatewayProxyClient } from '@connorhoehn/realtime-modules/proxy-client';
import type { ConnectionState } from '@connorhoehn/realtime-modules/client/ws';
import { useGatewaySocket } from '../../hooks/useGatewaySocket';

// VITE_GATEWAY_URL is exposed to the browser bundle by Vite at build time.
// We avoid `import.meta.env` typing concerns (no vite-env.d.ts in this repo)
// by reading via a typed-safe lookup with a sensible local-dev default.
const GATEWAY_URL: string =
  (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env?.VITE_GATEWAY_URL ?? 'http://localhost:8080';

const client = new GatewayProxyClient({ gatewayUrl: GATEWAY_URL });

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
 */
export function GatewayStatusBadge() {
  const [httpStatus, setHttpStatus] = useState<HttpStatus>('unknown');
  const { connectionState } = useGatewaySocket();

  useEffect(() => {
    let cancelled = false;

    const check = () => {
      client.getHealth().then(
        () => {
          if (!cancelled) setHttpStatus('healthy');
        },
        () => {
          if (!cancelled) setHttpStatus('unhealthy');
        }
      );
    };

    check();
    const t = setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      <span
        title={`gateway HTTP (${GATEWAY_URL}): ${httpStatus}`}
        aria-label={`gateway HTTP status: ${httpStatus}`}
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: HTTP_COLORS[httpStatus],
          display: 'inline-block',
        }}
      />
      <span
        title={`gateway WS: ${connectionState}`}
        aria-label={`gateway WebSocket status: ${connectionState}`}
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: WS_COLORS[connectionState],
          display: 'inline-block',
        }}
      />
    </span>
  );
}
