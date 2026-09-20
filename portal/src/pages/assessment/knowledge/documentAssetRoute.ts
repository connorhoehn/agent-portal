/** Authentication follows the owning service, never an arbitrary URL in content. */
export function documentAssetRoute(src: string, gatewayUrl: string, portalOrigin: string): { url: URL; auth: 'grant' | 'session' } | null {
  const gatewayHttp = gatewayUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  try {
    const source = new URL(src, portalOrigin);
    if (source.origin === portalOrigin && source.pathname === '/api/assessment/knowledge/source/asset') return { url: source, auth: 'session' };
    const upload = new URL(src, gatewayHttp);
    if (upload.origin === new URL(gatewayHttp).origin && upload.pathname.startsWith('/api/uploads/')) return { url: upload, auth: 'grant' };
  } catch { /* Unrecognized image sources remain ordinary browser URLs. */ }
  return null;
}
