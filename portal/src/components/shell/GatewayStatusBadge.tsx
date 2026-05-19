import { useEffect, useState } from 'react';
import { GatewayProxyClient } from '@connorhoehn/realtime-modules/proxy-client';

// VITE_GATEWAY_URL is exposed to the browser bundle by Vite at build time.
// We avoid `import.meta.env` typing concerns (no vite-env.d.ts in this repo)
// by reading via a typed-safe lookup with a sensible local-dev default.
const GATEWAY_URL: string =
  (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env?.VITE_GATEWAY_URL ?? 'http://localhost:8080';

const client = new GatewayProxyClient({ gatewayUrl: GATEWAY_URL });

type Status = 'unknown' | 'healthy' | 'unhealthy';

const COLORS: Record<Status, string> = {
  unknown: 'var(--color-text-tertiary)',
  healthy: 'var(--color-success, #10b981)',
  unhealthy: 'var(--color-danger, #ef4444)',
};

const POLL_MS = 30_000;

/**
 * First end-to-end adoption of `@connorhoehn/realtime-modules/proxy-client`
 * in OrgIQ portal. Polls the gateway's unauthenticated `/health` endpoint
 * and renders a small colored dot in the sidebar footer:
 *   green = healthy, red = unhealthy, gray = unknown (initial / loading).
 *
 * Gateway base URL: `VITE_GATEWAY_URL` (default `http://localhost:8080`).
 */
export function GatewayStatusBadge() {
  const [status, setStatus] = useState<Status>('unknown');

  useEffect(() => {
    let cancelled = false;

    const check = () => {
      client.getHealth().then(
        () => {
          if (!cancelled) setStatus('healthy');
        },
        () => {
          if (!cancelled) setStatus('unhealthy');
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
    <span
      title={`gateway (${GATEWAY_URL}): ${status}`}
      aria-label={`gateway status: ${status}`}
      style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: COLORS[status],
        display: 'inline-block',
      }}
    />
  );
}
