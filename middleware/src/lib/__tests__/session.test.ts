// config.ts uses import.meta, which the CommonJS test build can't compile —
// mock it with the dev-key defaults (no Secrets Manager involved).
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' } },
}));

import {
  mintSession,
  landingRole,
  signSession,
  verifySession,
  hasGrant,
  permissiveGrants,
  rolesForTenant,
  type Grants,
  type Session,
} from '../session.js';

describe('mintSession', () => {
  const user = { id: 'u-test', displayName: 'Test User' };

  it('returns null when the user holds no grants', () => {
    expect(mintSession(user, {})).toBeNull();
  });

  it('defaults to orgiq when granted there', () => {
    const s = mintSession(user, { orgiq: ['member'], newsroom: ['editor'] });
    expect(s).toMatchObject({ sub: 'u-test', tenant: 'orgiq', role: 'member' });
  });

  it('falls back to the only granted tenant', () => {
    const s = mintSession(user, { newsroom: ['reporter'] });
    expect(s).toMatchObject({ tenant: 'newsroom', role: 'reporter' });
  });

  it('honors a preferred tenant/role only when actually granted', () => {
    const grants: Grants = { orgiq: ['member'], newsroom: ['editor', 'reporter'] };
    expect(mintSession(user, grants, { tenant: 'newsroom', role: 'reporter' }))
      .toMatchObject({ tenant: 'newsroom', role: 'reporter' });
    // hr-admin not granted → falls back to a held role.
    expect(mintSession(user, grants, { tenant: 'orgiq', role: 'hr-admin' }))
      .toMatchObject({ tenant: 'orgiq', role: 'member' });
  });

  it('prefers a non-admin role when several are held', () => {
    const s = mintSession(user, { orgiq: ['admin', 'member'] });
    expect(s?.role).toBe('member');
  });

  it('lands on the least-privileged role regardless of grant order', () => {
    // Same grants, different array order — both must land on member.
    expect(mintSession(user, { orgiq: ['org-leader', 'member'] })?.role).toBe('member');
    expect(mintSession(user, { orgiq: ['member', 'org-leader'] })?.role).toBe('member');
    // hr-admin is the most privileged, so it's never the landing role here.
    expect(mintSession(user, { orgiq: ['hr-admin', 'org-leader', 'member'] })?.role).toBe('member');
    // newsroom: reporter (rank 0) beats editor (rank 1).
    expect(mintSession(user, { newsroom: ['editor', 'reporter'] })?.role).toBe('reporter');
  });
});

describe('landingRole', () => {
  it('picks the lowest-rank non-admin role, deterministically', () => {
    expect(landingRole(['org-leader', 'member'])).toBe('member');
    expect(landingRole(['member', 'org-leader'])).toBe('member');
    expect(landingRole(['editor', 'reporter'])).toBe('reporter');
    expect(landingRole(['hr-admin'])).toBe('hr-admin');
  });

  it('returns admin only when it is the sole role held', () => {
    expect(landingRole(['admin'])).toBe('admin');
    expect(landingRole(['admin', 'member'])).toBe('member');
  });
});

describe('sign/verify round trip', () => {
  it('preserves grants and masquerade provenance', async () => {
    const grants: Grants = { newsroom: ['editor'] };
    const session = mintSession({ id: 'u-editor', displayName: 'Elena' }, grants, undefined, {
      sub: 'u-operator', role: 'admin', tenant: 'orgiq', grants: permissiveGrants(),
    })!;
    const verified = await verifySession(await signSession(session));
    expect(verified).not.toBeNull();
    expect(verified!.sub).toBe('u-editor');
    expect(verified!.grants).toEqual(grants);
    expect(verified!.act?.sub).toBe('u-operator');
  });

  it('rejects a tampered cookie', async () => {
    const cookie = await signSession(mintSession({ id: 'u-a' }, { orgiq: ['member'] })!);
    const [payload, mac] = cookie.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ sub: 'u-a', role: 'hr-admin', tenant: 'orgiq' })).toString('base64url');
    expect(await verifySession(`${forged}.${mac}`)).toBeNull();
    expect(await verifySession(`${payload}.AAAA`)).toBeNull();
  });

  it('repairs a validly-signed cookie whose role is not granted in its tenant', async () => {
    // Simulate a stale cookie: role carried into a tenant where it isn't held.
    const stale: Session = {
      sub: 'u-x', role: 'hr-admin', tenant: 'newsroom',
      grants: { newsroom: ['reporter'] }, iat: 1,
    };
    const verified = await verifySession(await signSession(stale));
    expect(verified).toMatchObject({ tenant: 'newsroom', role: 'reporter' });
  });

  it('grants permissive access to legacy cookies without a grants field', async () => {
    const legacy = { sub: 'demo-user', role: 'member', tenant: 'orgiq', iat: 1 };
    const verified = await verifySession(await signSession(legacy as unknown as Session));
    expect(verified).not.toBeNull();
    expect(rolesForTenant(verified!.grants, 'newsroom').length).toBeGreaterThan(0);
  });
});

describe('grant checks', () => {
  it('hasGrant is tenant-scoped — the cross-pollination guard', () => {
    const grants: Grants = { orgiq: ['org-leader'], newsroom: ['reporter'] };
    expect(hasGrant(grants, 'orgiq', 'org-leader')).toBe(true);
    expect(hasGrant(grants, 'newsroom', 'org-leader')).toBe(false);
    expect(hasGrant(grants, 'orgiq', 'reporter')).toBe(false);
    expect(hasGrant(grants, 'unknown', 'org-leader')).toBe(false);
  });
});
