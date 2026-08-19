// Shell URL construction and presigning.
//
// This module had no tests, and its failure modes are all silent: a missing
// session id does not error, it lands the terminal in a brand-new microVM
// where /mnt/workspace looks empty. A wrong path or service name fails at the
// WebSocket upgrade with an opaque close code. Every property here is one that
// would otherwise only surface against live AWS.
//
// The shape is pinned against aws/bedrock-agentcore-sdk-typescript's
// `connectShellPresigned`, since this is a hand-rolled equivalent of it.

jest.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: () => async () => ({
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret',
    sessionToken: 'token',
  }),
}));

import { presignShellUrl, isValidShellId } from '../devbox-shell.js';

const ARN = 'arn:aws:bedrock-agentcore:us-east-1:647757222309:runtime/orgiq_devbox-AbC123';
const SESSION = 'd6bafcff-26a0-4cf9-a196-53f8b6c97383b633';

async function url(over: Partial<Parameters<typeof presignShellUrl>[1]> = {}): Promise<URL> {
  const { url: u } = await presignShellUrl(ARN, {
    shellId: 'portal-abc', sessionId: SESSION, region: 'us-east-1', ...over,
  });
  return new URL(u);
}

describe('URL shape', () => {
  it('is a wss URL on the regional agentcore host', async () => {
    const u = await url();
    expect(u.protocol).toBe('wss:');
    expect(u.hostname).toBe('bedrock-agentcore.us-east-1.amazonaws.com');
  });

  it('uses the region it is given rather than a global default', async () => {
    const u = await url({ region: 'us-west-2' });
    expect(u.hostname).toBe('bedrock-agentcore.us-west-2.amazonaws.com');
  });

  it('puts the ARN in one URI-encoded path segment', async () => {
    // Unencoded, the ARN's colons and slashes would be read as path
    // separators and the upgrade would 404.
    const u = await url();
    expect(u.pathname).toBe(`/runtimes/${encodeURIComponent(ARN)}/ws/shells`);
    expect(u.pathname).not.toContain('runtime/orgiq_devbox');
  });

  it('carries the session id, without which a NEW microVM is created', async () => {
    // The failure this pins: no session id means the terminal opens against a
    // fresh session and /mnt/workspace appears empty instead of showing the
    // box the operator is looking at.
    const u = await url();
    expect(u.searchParams.get('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id')).toBe(SESSION);
  });

  it('carries the shell id, which is the reattachment handle', async () => {
    const u = await url({ shellId: 'my-shell' });
    expect(u.searchParams.get('shellId')).toBe('my-shell');
  });

  it('defaults the qualifier to DEFAULT', async () => {
    expect((await url()).searchParams.get('qualifier')).toBe('DEFAULT');
  });
});

describe('signature', () => {
  it('signs for the bedrock-agentcore service, not bedrock', async () => {
    const u = await url();
    expect(u.searchParams.get('X-Amz-Credential')).toContain('/bedrock-agentcore/');
  });

  it('is a SigV4 query presign, because a browser cannot set headers on a WebSocket', async () => {
    const u = await url();
    expect(u.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(u.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(u.searchParams.get('X-Amz-Date')).toBeTruthy();
  });

  it('covers the session and shell ids in the signature', async () => {
    // If these were appended after signing, the service would reject the
    // upgrade — so they must appear in SignedHeaders/canonical query.
    const u = await url();
    const signed = u.searchParams.get('X-Amz-SignedHeaders');
    expect(signed).toContain('host');
    // Both ids are query params on the signed request, so changing either
    // must change the signature.
    const other = await url({ shellId: 'different-shell' });
    expect(other.searchParams.get('X-Amz-Signature'))
      .not.toBe(u.searchParams.get('X-Amz-Signature'));
  });
});

describe('expiry', () => {
  it('is short by default — the URL is a bearer credential for a shell', async () => {
    const { expiresIn } = await presignShellUrl(ARN, {
      shellId: 's', sessionId: SESSION, region: 'us-east-1',
    });
    expect(expiresIn).toBe(120);
  });

  it('clamps into a sane band rather than trusting the caller', async () => {
    const long = await presignShellUrl(ARN, { shellId: 's', sessionId: SESSION, region: 'us-east-1', expiresIn: 99_999 });
    const short = await presignShellUrl(ARN, { shellId: 's', sessionId: SESSION, region: 'us-east-1', expiresIn: 1 });
    expect(long.expiresIn).toBe(900);
    expect(short.expiresIn).toBe(30);
  });
});

describe('shell id validation', () => {
  it.each(['a', 'portal-abc', 'A_1-b', 'x'.repeat(128)])('accepts %s', (id) => {
    expect(isValidShellId(id)).toBe(true);
  });

  it.each(['', 'has space', 'has/slash', 'emoji✨', 'x'.repeat(129)])('rejects %s', (id) => {
    // The service answers RuntimeClientError 424 for a malformed id, which
    // reaches a browser as an opaque failed upgrade — better to refuse here.
    expect(isValidShellId(id)).toBe(false);
  });

  it('refuses to presign an invalid id rather than minting a doomed URL', async () => {
    await expect(presignShellUrl(ARN, {
      shellId: 'bad id', sessionId: SESSION, region: 'us-east-1',
    })).rejects.toThrow(/invalid shellId/);
  });
});
