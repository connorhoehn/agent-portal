// DE-45: mintRepoToken against a fake GitHub API — one repository, exactly
// the asked permissions, a verifiable app JWT, and a refusal (no PAT
// fallback) when the app has no installation on the owner.

import { generateKeyPairSync, createVerify } from 'node:crypto';
import { GitHubAppTokenProvider, GitHubAppNotInstalled, signAppJwt } from '../github-app-token.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const NOW = Date.parse('2026-10-29T12:00:00Z');
const CTX = { runRef: 'run:1', callerSub: 'u-1' };

type Call = { url: string; method: string; auth: string; body: unknown };

function fakeGitHub(installs: Record<string, number>) {
  const calls: Call[] = [];
  const fetchFn = jest.fn(async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init.method ?? 'GET', auth: headers['Authorization'] ?? '', body });
    const inst = /\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(url);
    if (inst) {
      const id = installs[inst[1]!];
      return new Response(JSON.stringify(id ? { id } : { message: 'Not Found' }), { status: id ? 200 : 404 });
    }
    const tok = /\/app\/installations\/(\d+)\/access_tokens$/.exec(url);
    if (tok && init.method === 'POST') {
      return new Response(JSON.stringify({
        token: 'ghs_minted', expires_at: '2026-10-29T13:00:00Z',
        repositories: (body.repositories as string[]).map((n) => ({ full_name: `acme/${n}` })),
      }), { status: 201 });
    }
    return new Response('{}', { status: 500 });
  });
  return { calls, fetchFn };
}

describe('signAppJwt', () => {
  it('is an RS256 JWT for the app, verifiable with its public key, inside GitHub\'s 10-minute window', () => {
    const jwt = signAppJwt('12345', PEM, NOW);
    const [h, c, sig] = jwt.split('.');
    const v = createVerify('RSA-SHA256');
    v.update(`${h}.${c}`);
    expect(v.verify(publicKey, Buffer.from(sig!, 'base64url'))).toBe(true);
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    expect(claims.iss).toBe('12345');
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(claims.iat).toBeLessThan(NOW / 1000);
  });
});

describe('GitHubAppTokenProvider.mintRepoToken', () => {
  it('asks for one repository and exactly the asked permissions', async () => {
    const gh = fakeGitHub({ acme: 77 });
    const p = new GitHubAppTokenProvider({ appId: '12345', privateKeyPem: PEM, fetch: gh.fetchFn as never, now: () => NOW });
    const t = await p.mintRepoToken('acme/widgets', { contents: 'read' }, CTX);
    expect(t).toEqual({ token: 'ghs_minted', expiresAt: '2026-10-29T13:00:00Z', provider: 'github-app' });
    const post = gh.calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('https://api.github.com/app/installations/77/access_tokens');
    expect(post.body).toEqual({ repositories: ['widgets'], permissions: { contents: 'read', metadata: 'read' } });
    expect(gh.calls.every((c) => c.auth.startsWith('Bearer ey'))).toBe(true);
  });

  it('a push token adds pull_requests: write and nothing else', async () => {
    const gh = fakeGitHub({ acme: 77 });
    const p = new GitHubAppTokenProvider({ appId: '1', privateKeyPem: PEM, fetch: gh.fetchFn as never, now: () => NOW });
    await p.mintRepoToken('acme/widgets', { contents: 'write', pull_requests: 'write' }, CTX);
    expect(gh.calls.find((c) => c.method === 'POST')!.body).toEqual({
      repositories: ['widgets'], permissions: { contents: 'write', metadata: 'read', pull_requests: 'write' },
    });
  });

  it('refuses — no PAT fallback — when the app is not installed on the owner', async () => {
    const gh = fakeGitHub({ acme: 77 });
    const p = new GitHubAppTokenProvider({ appId: '1', privateKeyPem: PEM, fetch: gh.fetchFn as never, now: () => NOW });
    await expect(p.mintRepoToken('elsewhere/repo', { contents: 'read' }, { ...CTX, connectionName: 'gh-pat' }))
      .rejects.toBeInstanceOf(GitHubAppNotInstalled);
    expect(gh.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('refuses a malformed repository before reaching GitHub', async () => {
    const gh = fakeGitHub({});
    const p = new GitHubAppTokenProvider({ appId: '1', privateKeyPem: PEM, fetch: gh.fetchFn as never });
    await expect(p.mintRepoToken('../etc', { contents: 'read' }, CTX)).rejects.toThrow(/owner\/name/);
    expect(gh.fetchFn).not.toHaveBeenCalled();
  });

  it('will not construct without an app id and a PEM key', () => {
    expect(() => new GitHubAppTokenProvider({ appId: '', privateKeyPem: PEM })).toThrow(/id/);
    expect(() => new GitHubAppTokenProvider({ appId: '1', privateKeyPem: 'nope' })).toThrow(/PEM/);
  });
});
