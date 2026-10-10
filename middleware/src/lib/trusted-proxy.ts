/** Direct deployments ignore forwarding headers. ECS explicitly declares its
 * enforced proxy hops; only enable this where networking prevents bypassing
 * them.
 *
 *   0 / unset  direct — forwarding headers are ignored
 *   1          the ALB (OrgIQ-MiddlewareService, no CloudFront)
 *   2          CloudFront → ALB (OrgIQ-Portal, `deployPortal=true`): CloudFront
 *              appends the viewer's address to X-Forwarded-For and the ALB
 *              appends CloudFront's, so the client is two entries from the end
 */
export function trustedProxyHops(): number | false {
  const value = process.env['TRUST_PROXY_HOPS']?.trim();
  if (!value || value === '0') return false;
  if (value === '1') return 1;
  if (value === '2') return 2;
  throw new Error('TRUST_PROXY_HOPS must be 0 (direct), 1 (one enforced reverse proxy) or 2 (CloudFront in front of the ALB)');
}

interface SchemeSource {
  readonly secure?: boolean;
  get(name: string): string | undefined;
}

/**
 * The scheme the VIEWER used, for the session cookie's Secure flag and the
 * browser-origin check.
 *
 * With one hop `req.secure` is honest: Express reads the ALB's
 * X-Forwarded-Proto. With CloudFront in front it is not. CloudFront reaches
 * the ALB over plain HTTP (no certificate: the ALB has no TLS listener), and
 * the ALB sets X-Forwarded-Proto to the scheme of the connection IT received —
 * `http` — so every request looked insecure: the cookie lost `Secure` and the
 * portal's own `https://` origin read as cross-origin. The viewer's scheme
 * survives only in `CloudFront-Forwarded-Proto` (the origin request policy
 * forwards it). It is read only when two hops are declared, so a direct or
 * ALB-only deployment cannot be told otherwise by a header a client typed.
 */
export function viewerScheme(req: SchemeSource): 'http' | 'https' {
  if (trustedProxyHops() === 2) {
    const cf = req.get('cloudfront-forwarded-proto')?.trim().toLowerCase();
    if (cf === 'https' || cf === 'http') return cf;
  }
  return req.secure === true ? 'https' : 'http';
}

interface UpgradeSource {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly socket: { encrypted?: boolean } | object;
}

/**
 * `viewerScheme` for a WebSocket UPGRADE, which never passes through Express —
 * so there is no `req.secure` and no `trust proxy` to lean on. The upgrade
 * paths (lib/realtime-gateway.ts, lib/distillation-realtime.ts) used to read
 * the scheme off the socket alone, which behind the ALB is always plain TCP:
 * an `https://` page's socket then read as `http://<host>`, failed the
 * same-origin test, and survived only because PUBLIC_BASE_URL happened to
 * list the origin. Same trust rule as the HTTP side: forwarding headers count
 * only when TRUST_PROXY_HOPS declares the proxies that set them.
 */
export function upgradeScheme(req: UpgradeSource): 'http' | 'https' {
  const header = (name: string): string | undefined => {
    const v = req.headers[name];
    return (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim().toLowerCase();
  };
  const hops = trustedProxyHops();
  if (hops === 2) {
    const cf = header('cloudfront-forwarded-proto');
    if (cf === 'https' || cf === 'http') return cf;
  }
  if (hops) {
    const xf = header('x-forwarded-proto');
    if (xf === 'https' || xf === 'http') return xf;
  }
  return (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
}
