import { EventEmitter } from 'node:events';
jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('node:http', () => ({ request: jest.fn() }));
jest.mock('node:https', () => ({ request: jest.fn() }));
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isPublicAddress, publicWebFetch } from '../public-web-fetch.js';

const dns = lookup as jest.Mock;
const http = httpRequest as unknown as jest.Mock;
const https = httpsRequest as unknown as jest.Mock;
function reply(status: number, headers: Record<string, string> = {}, body = 'public page'): void {
  https.mockImplementationOnce((_url, options, done) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => {
      const answer = jest.fn();
      options.lookup('example.com', { all: true }, answer);
      expect(answer).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
      const res = Object.assign(new EventEmitter(), { statusCode: status, headers, destroy: jest.fn((err?: Error) => { if (err) res.emit('error', err); }) });
      done(res);
      res.emit('data', Buffer.from(body));
      res.emit('end');
    };
    return req;
  });
}
beforeEach(() => {
  jest.resetAllMocks();
  dns.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});
it.each(['127.0.0.1','10.0.0.1','172.16.0.1','192.168.0.1','169.254.169.254','100.100.100.200','0.0.0.0','224.0.0.1','198.18.0.1','::1','::','fc00::1','fe80::1','::ffff:127.0.0.1','2002:7f00:1::','2001:db8::1','64:ff9b::7f00:1'])('rejects non-public IP %s', address => {
  expect(isPublicAddress(address)).toBe(false);
});
it.each(['https://127.1/','http://2130706433/','http://0x7f000001/','http://[::ffff:127.0.0.1]/','file:///etc/passwd','http://user:pass@example.com/','http://example.com:3001/'])('rejects unsafe initial URL %s before connection', async url => {
  await expect(publicWebFetch(url)).rejects.toThrow();
  expect(http).not.toHaveBeenCalled(); expect(https).not.toHaveBeenCalled();
});
it('rejects a mixed public/private DNS answer without opening a socket', async () => {
  dns.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]);
  await expect(publicWebFetch('https://example.com/')).rejects.toThrow('Non-public');
  expect(https).not.toHaveBeenCalled();
});
it('pins DNS answers while retaining the TLS hostname and never uses a shared agent', async () => {
  reply(200);
  expect(await (await publicWebFetch('https://example.com/')).text()).toBe('public page');
  expect(dns).toHaveBeenCalledTimes(1);
  expect(https.mock.calls[0][0].hostname).toBe('example.com');
  expect(https.mock.calls[0][1].agent).toBe(false);
});
it('rejects redirect to metadata before connecting', async () => {
  reply(302, { location: 'http://169.254.169.254/latest/meta-data/' });
  await expect(publicWebFetch('https://example.com/')).rejects.toThrow('Non-public');
  expect(https).toHaveBeenCalledTimes(1); expect(http).not.toHaveBeenCalled();
});
it('revalidates DNS on same-host redirects, catching rebinding', async () => {
  reply(302, { location: '/next' });
  dns.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
  await expect(publicWebFetch('https://example.com/')).rejects.toThrow('Non-public');
  expect(https).toHaveBeenCalledTimes(1);
});
it('follows a public redirect', async () => {
  reply(302, { location: '/next' }); reply(200);
  expect((await publicWebFetch('https://example.com/')).status).toBe(200);
  expect(https.mock.calls[1][0].pathname).toBe('/next');
});
it('bounds redirect chains', async () => {
  for (let i = 0; i < 6; i++) reply(302, { location: '/again' });
  await expect(publicWebFetch('https://example.com/')).rejects.toThrow('Too many');
});
it('accepts public IPv6 but not special-purpose IPv6 ranges', () => {
  expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  expect(isPublicAddress('8.8.8.8')).toBe(true);
});

it('rejects oversized bodies', async () => {
  reply(200, {}, 'x'.repeat(2 * 1024 * 1024 + 1));
  await expect(publicWebFetch('https://example.com/')).rejects.toThrow('2 MiB');
});
it('rejects compressed responses rather than decompressing unbounded input', async () => {
  reply(200, { 'content-encoding': 'gzip' });
  await expect(publicWebFetch('https://example.com/')).rejects.toThrow('Compressed');
});
it('does not connect after an aborted request', async () => {
  await expect(publicWebFetch('https://example.com/', { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
  expect(https).not.toHaveBeenCalled();
});
