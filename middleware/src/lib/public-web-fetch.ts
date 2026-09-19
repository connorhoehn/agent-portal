// Fetch untrusted crawl URLs without granting access to the server's network.
// Resolve once, reject every non-public answer, and pin the connection to an
// approved address. Redirects repeat the same policy; DNS is never re-resolved
// by the HTTP client. TLS still verifies the original hostname.
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const denied = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) denied.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  denied.addSubnet(address, prefix, 'ipv6');
}
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !denied.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !denied.check(address, 'ipv6');
}

export function publicWebUrl(input: string): URL {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && url.port !== '80' && url.port !== '443')) {
    throw new Error('Crawling requires a public HTTP(S) URL on port 80 or 443 without credentials');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname) && !isPublicAddress(hostname)) throw new Error('Non-public crawl address is forbidden');
  return url;
}

export async function publicWebFetch(input: string, options: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: string } = {}): Promise<Response> {
  // One deadline covers resolution, redirects, and response consumption.
  const deadline = AbortSignal.timeout(12_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let url = publicWebUrl(input);
  for (let hop = 0; hop <= 5; hop++) {
    signal.throwIfAborted();
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const resolution = isIP(hostname)
      ? Promise.resolve([{ address: hostname, family: isIP(hostname) }])
      : lookup(hostname, { all: true, verbatim: true });
    const addresses = await new Promise<Awaited<typeof resolution>>((resolve, reject) => {
      const abort = (): void => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      resolution.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
    if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) {
      throw new Error('Non-public crawl address is forbidden');
    }
    const pinned = addresses[0]!;
    const response = await new Promise<{ status: number; headers: Headers; body: Buffer }>((resolve, reject) => {
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        agent: false, signal,
        headers: { ...options.headers, 'Accept-Encoding': 'identity' },
        lookup: (_name, _opts, callback) => {
          // Node can ask for all addresses for family autoselection.
          if (_opts.all) callback(null, [pinned] as never);
          else callback(null, pinned.address, pinned.family);
        },
      }, res => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
          res.destroy();
          resolve({ status: res.statusCode!, headers, body: Buffer.alloc(0) });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) { res.destroy(new Error('Crawl response exceeds 2 MiB')); return; }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode ?? 502, headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Crawl redirect has no location');
      url = publicWebUrl(new URL(location, url).href);
      continue;
    }
    if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') {
      throw new Error('Compressed crawl responses are not accepted');
    }
    return new Response([204, 205, 304].includes(response.status) ? null : new Uint8Array(response.body), response);
  }
  throw new Error('Too many crawl redirects');
}

/** Browser navigation validation is defense in depth; its socket policy is AWS PUBLIC isolation. */
export async function assertPublicWebTarget(input: string): Promise<void> {
  const url = publicWebUrl(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const signal = AbortSignal.timeout(8_000);
  const addresses = isIP(hostname) ? [{ address: hostname }] : await new Promise<Array<{ address: string }>>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    lookup(hostname, { all: true }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) {
    throw new Error('Non-public crawl address is forbidden');
  }
}
