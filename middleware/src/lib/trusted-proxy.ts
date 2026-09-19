/** Direct deployments ignore forwarding headers. ECS explicitly declares its
 * one ALB hop; only enable this where networking prevents bypassing that proxy.
 */
export function trustedProxyHops(): number | false {
  const value = process.env['TRUST_PROXY_HOPS']?.trim();
  if (!value || value === '0') return false;
  if (value === '1') return 1;
  throw new Error('TRUST_PROXY_HOPS must be 0 (direct) or 1 (one enforced reverse proxy)');
}
