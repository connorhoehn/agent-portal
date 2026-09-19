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
  sessionMiddleware,
  setGrantsResolver,
  type Grants,
  type Session,
} from '../session.js';

describe('mintSession', () => {
  const user = { id: 'u-test', displayName: 'Test User' };

  it('returns null when the user holds no grants', () => {
    expect(mintSession(user, {})).toBeNull();
  });

  it('defaults to orgiq when granted there', () => {
    const s = mintSession(user, { orgiq: ['member'], assessment: ['lead-assessor'] });
    expect(s).toMatchObject({ sub: 'u-test', tenant: 'orgiq', role: 'member' });
  });

  it('falls back to the only granted tenant', () => {
    const s = mintSession(user, { assessment: ['assessor'] });
    expect(s).toMatchObject({ tenant: 'assessment', role: 'assessor' });
  });

  it('honors a preferred tenant/role only when actually granted', () => {
    const grants: Grants = { orgiq: ['member'], assessment: ['lead-assessor', 'assessor'] };
    expect(mintSession(user, grants, { tenant: 'assessment', role: 'assessor' }))
      .toMatchObject({ tenant: 'assessment', role: 'assessor' });
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
    // assessment: assessor (rank 0) beats lead-assessor (rank 2).
    expect(mintSession(user, { assessment: ['lead-assessor', 'assessor'] })?.role).toBe('assessor');
  });
});

describe('landingRole', () => {
  it('picks the lowest-rank non-admin role, deterministically', () => {
    expect(landingRole(['org-leader', 'member'])).toBe('member');
    expect(landingRole(['member', 'org-leader'])).toBe('member');
    expect(landingRole(['lead-assessor', 'assessor'])).toBe('assessor');
    expect(landingRole(['hr-admin'])).toBe('hr-admin');
  });

  it('returns admin only when it is the sole role held', () => {
    expect(landingRole(['admin'])).toBe('admin');
    expect(landingRole(['admin', 'member'])).toBe('member');
  });

  // An SME dispatches agent work, so it outranks member but sits below the
  // roles that allocate the money it spends.
  it('ranks sme between member and org-leader', () => {
    expect(landingRole(['sme'])).toBe('sme');
    expect(landingRole(['sme', 'member'])).toBe('member');
    expect(landingRole(['org-leader', 'sme'])).toBe('sme');
    expect(landingRole(['hr-admin', 'sme'])).toBe('sme');
  });
});

describe('sign/verify round trip', () => {
  it('preserves grants and masquerade provenance', async () => {
    const grants: Grants = { assessment: ['lead-assessor'] };
    const session = mintSession({ id: 'u-jonas', displayName: 'Jonas' }, grants, undefined, {
      sub: 'u-operator', role: 'admin', tenant: 'orgiq', grants: permissiveGrants(),
    })!;
    const verified = await verifySession(await signSession(session));
    expect(verified).not.toBeNull();
    expect(verified!.sub).toBe('u-jonas');
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
    // iat must be recent — verifySession now enforces the session age
    // server-side, so an ancient iat is (correctly) an expired session.
    const stale: Session = {
      sub: 'u-x', role: 'hr-admin', tenant: 'assessment',
      grants: { assessment: ['assessor'] }, iat: Math.floor(Date.now() / 1000),
    };
    const verified = await verifySession(await signSession(stale));
    expect(verified).toMatchObject({ tenant: 'assessment', role: 'assessor' });
  });

  it('grants permissive access to legacy cookies without a grants field', async () => {
    const legacy = { sub: 'demo-user', role: 'member', tenant: 'orgiq', iat: Math.floor(Date.now() / 1000) };
    const verified = await verifySession(await signSession(legacy as unknown as Session));
    expect(verified).not.toBeNull();
    expect(rolesForTenant(verified!.grants, 'assessment').length).toBeGreaterThan(0);
  });

  it('rejects a validly-signed cookie whose iat is older than the session TTL', async () => {
    const ancient: Session = {
      sub: 'u-x', role: 'member', tenant: 'orgiq',
      grants: { orgiq: ['member'] }, iat: 1,
    };
    expect(await verifySession(await signSession(ancient))).toBeNull();
  });
});

describe('session_epoch', () => {
  it('round-trips the epoch through mint → sign → verify', async () => {
    const session = mintSession({ id: 'u-e', displayName: 'E', epoch: 7 }, { orgiq: ['member'] })!;
    expect(session.epoch).toBe(7);
    const verified = await verifySession(await signSession(session));
    expect(verified!.epoch).toBe(7);
  });

  it('omits epoch when the user has none (backward-compat)', async () => {
    const session = mintSession({ id: 'u-e' }, { orgiq: ['member'] })!;
    expect('epoch' in session).toBe(false);
    const verified = await verifySession(await signSession(session));
    expect(verified!.epoch).toBeUndefined();
  });

  it('preserves the cookie epoch through the stale-role REPAIR branch', async () => {
    // Role not held in its tenant → verifySession re-mints; the epoch must survive.
    const stale: Session = {
      sub: 'u-x', role: 'hr-admin', tenant: 'assessment',
      grants: { assessment: ['assessor'] }, iat: Math.floor(Date.now() / 1000), epoch: 4,
    };
    const verified = await verifySession(await signSession(stale));
    expect(verified).toMatchObject({ tenant: 'assessment', role: 'assessor', epoch: 4 });
  });

  describe('grants-refresh epoch enforcement', () => {
    // A cookie old enough to trigger the grants-refresh block (age > 120s) but
    // still within the session TTL.
    const staleIat = () => Math.floor(Date.now() / 1000) - 200;
    function fakeReqRes(cookie: string) {
      const req = { cookies: { 'orgiq.session': cookie } } as unknown as import('express').Request;
      const res = { cookie: jest.fn(), clearCookie: jest.fn() } as unknown as import('express').Response;
      return { req, res };
    }

    it('REJECTS a cookie whose epoch is below the user current epoch', async () => {
      setGrantsResolver(async () => ({ displayName: 'E', grants: { orgiq: ['member'] }, epoch: 5 }));
      const cookie = await signSession({
        sub: 'u-e', role: 'member', tenant: 'orgiq',
        grants: { orgiq: ['member'] }, iat: staleIat(), epoch: 2,
      });
      const { req, res } = fakeReqRes(cookie);
      await sessionMiddleware()(req, res, () => {});
      // Superseded → cookie cleared, dropped to the anonymous demo identity.
      expect((res.clearCookie as jest.Mock)).toHaveBeenCalled();
      expect(req.session?.sub).toBe('demo-user');
    });

    it('drops a session when its last grant has been revoked', async () => {
      setGrantsResolver(async () => ({ displayName: 'E', grants: {}, epoch: 2 }));
      const cookie = await signSession({
        sub: 'u-e', role: 'member', tenant: 'orgiq',
        grants: { orgiq: ['member'] }, iat: staleIat(), epoch: 2,
      });
      const { req, res } = fakeReqRes(cookie);
      await sessionMiddleware()(req, res, () => {});
      expect(res.clearCookie).toHaveBeenCalled();
      expect(req.session?.sub).not.toBe('u-e');
      expect(res.cookie).not.toHaveBeenCalled();
    });

    it('ACCEPTS a cookie whose epoch matches, re-minting at the current epoch', async () => {
      setGrantsResolver(async () => ({ displayName: 'E', grants: { orgiq: ['member'] }, epoch: 2 }));
      const cookie = await signSession({
        sub: 'u-e', role: 'member', tenant: 'orgiq',
        grants: { orgiq: ['member'] }, iat: staleIat(), epoch: 2,
      });
      const { req, res } = fakeReqRes(cookie);
      await sessionMiddleware()(req, res, () => {});
      expect(req.session?.sub).toBe('u-e');
      expect(req.session?.epoch).toBe(2);
      expect((res.cookie as jest.Mock)).toHaveBeenCalled();
    });

    it('treats a pre-epoch cookie (undefined → 0) as valid when the user has never bumped', async () => {
      setGrantsResolver(async () => ({ displayName: 'E', grants: { orgiq: ['member'] }, epoch: 0 }));
      const cookie = await signSession({
        sub: 'u-e', role: 'member', tenant: 'orgiq',
        grants: { orgiq: ['member'] }, iat: staleIat(),
      });
      const { req, res } = fakeReqRes(cookie);
      await sessionMiddleware()(req, res, () => {});
      expect(req.session?.sub).toBe('u-e');
    });
  });
});

describe('grant checks', () => {
  it('hasGrant is tenant-scoped — the cross-pollination guard', () => {
    const grants: Grants = { orgiq: ['org-leader'], assessment: ['assessor'] };
    expect(hasGrant(grants, 'orgiq', 'org-leader')).toBe(true);
    expect(hasGrant(grants, 'assessment', 'org-leader')).toBe(false);
    expect(hasGrant(grants, 'orgiq', 'assessor')).toBe(false);
    expect(hasGrant(grants, 'unknown', 'org-leader')).toBe(false);
  });
});
