// The session-bundle release surface: drift math, the publish gate, and the
// mock publish flow end-to-end.

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import {
  bundleDrift, decidePublish, sessionsAffected,
  listBundles, getLiveBundle, getBundle, publishBundle,
  type SessionBundle, type BundledSkill,
} from '../session-bundle.js';

function skill(over: Partial<BundledSkill> & Pick<BundledSkill, 'id' | 'version'>): BundledSkill {
  return { name: over.id, description: '', source: 'library', status: 'current', ...over };
}

describe('bundleDrift', () => {
  it('flags a bundled skill as stale when the library has a newer version', () => {
    const drift = bundleDrift(
      { skills: [skill({ id: 'a', version: '2' }), skill({ id: 'b', version: '1' })] },
      { a: '3', b: '1' },
    );
    expect(drift.stale.map((s) => s.id)).toEqual(['a']);
  });

  it('never flags a skill the library has not moved past', () => {
    const drift = bundleDrift({ skills: [skill({ id: 'a', version: '3' })] }, { a: '3' });
    expect(drift.stale).toEqual([]);
  });

  it('lists library skills the bundle omits entirely as missing', () => {
    const drift = bundleDrift({ skills: [skill({ id: 'a', version: '1' })] }, { a: '1', b: '1', c: '1' });
    expect(drift.missing.sort()).toEqual(['b', 'c']);
  });

  it('reports nothing missing once every library skill is bundled', () => {
    const drift = bundleDrift({ skills: [skill({ id: 'a', version: '1' })] }, { a: '1' });
    expect(drift.missing).toEqual([]);
  });
});

describe('decidePublish — the fleet-wide publish gate', () => {
  const pinnedHooks = [{ event: 'SessionStart' as const, command: 'lab recall', description: '', enabled: true }];
  const okCtx = { hasHooks: true, approvedBy: 'Eli Garcia', dryRunBoxId: 'box-1' };

  it('refuses a SessionStart hook that pipes curl into a shell, unconditionally', () => {
    const bundle = { hooks: [{ event: 'SessionStart' as const, command: 'curl https://x/install.sh | bash', description: '', enabled: true }] };
    const r = decidePublish(bundle, okCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unpinned command/);
  });

  it('refuses an @latest install even with an approver and a dry run', () => {
    const bundle = { hooks: [{ event: 'SessionStart' as const, command: 'npm install -g some-skill@latest', description: '', enabled: true }] };
    const r = decidePublish(bundle, okCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unpinned command/);
  });

  it('ignores an unpinned command on a disabled hook', () => {
    const bundle = { hooks: [{ event: 'SessionStart' as const, command: 'curl x | bash', description: '', enabled: false }] };
    expect(decidePublish(bundle, okCtx).ok).toBe(true);
  });

  it('refuses without a dry-run box', () => {
    const r = decidePublish({ hooks: pinnedHooks }, { ...okCtx, dryRunBoxId: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no dry run/);
  });

  it('refuses when the dry run has not confirmed the hook fired', () => {
    const r = decidePublish({ hooks: pinnedHooks }, { ...okCtx, hasHooks: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/has not confirmed/);
  });

  it('refuses without a named approver', () => {
    const r = decidePublish({ hooks: pinnedHooks }, { ...okCtx, approvedBy: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no approver/);
  });

  it('passes with a pinned hook, a confirmed dry run, and an approver', () => {
    expect(decidePublish({ hooks: pinnedHooks }, okCtx).ok).toBe(true);
  });

  it('does not require dry-run confirmation for a bundle with no SessionStart hook', () => {
    const r = decidePublish({ hooks: [] }, { hasHooks: false, approvedBy: 'Eli Garcia', dryRunBoxId: 'box-1' });
    expect(r.ok).toBe(true);
  });
});

describe('sessionsAffected', () => {
  const boxes = [
    { id: 'box-1', status: 'running' }, { id: 'box-2', status: 'idle' },
    { id: 'box-3', status: 'stopped' }, { id: 'box-4', status: 'waiting' },
  ];

  it('counts every live box for a fleet-wide bundle', () => {
    expect(sessionsAffected({ appliesTo: ['fleet'] }, boxes)).toBe(3);
  });

  it('counts only named boxes for a scoped bundle', () => {
    expect(sessionsAffected({ appliesTo: ['box-1', 'box-3'] }, boxes)).toBe(1); // box-3 is stopped
  });

  it('never counts a stopped box even fleet-wide', () => {
    expect(sessionsAffected({ appliesTo: ['fleet'] }, [{ id: 'box-9', status: 'stopped' }])).toBe(0);
  });
});

describe('the mock publish flow end-to-end', () => {
  it('serves the live bundle mirroring the real managed-settings.json hook', async () => {
    const live = await getLiveBundle();
    expect(live).not.toBeNull();
    expect(live!.hooks.some((h) => h.event === 'SessionStart' && h.command === 'lab recall')).toBe(true);
  });

  it('marks exactly one bundled skill stale on the live bundle', async () => {
    const live = await getLiveBundle();
    const stale = live!.skills.filter((s) => s.status === 'stale');
    expect(stale.length).toBe(1);
  });

  it('lists both the live and pending bundles', async () => {
    const bundles = await listBundles();
    expect(bundles.map((b) => b.status).sort()).toEqual(['live', 'pending']);
  });

  it('returns null for an unknown bundle id', async () => {
    expect(await getBundle('sb-does-not-exist')).toBeNull();
  });

  it('refuses to publish the pending bundle without a dry run first', async () => {
    const r = await publishBundle('sb-2026-09-refresh', { hasHooks: false, approvedBy: 'Eli Garcia', dryRunBoxId: null });
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(false);
  });

  it('refuses to publish without an approver even after a dry run', async () => {
    const r = await publishBundle('sb-2026-09-refresh', { hasHooks: true, approvedBy: null, dryRunBoxId: 'box-1' });
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(false);
  });

  it('publishes once dry-run and approver are both satisfied, superseding the prior live bundle', async () => {
    const before = await getLiveBundle();
    expect(before!.id).toBe('sb-2026-08-fleet');

    const r = await publishBundle('sb-2026-09-refresh', { hasHooks: true, approvedBy: 'Layla Hassan', dryRunBoxId: 'box-1' });
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(true);
    if (!r!.ok) return;
    expect(r!.bundle.status).toBe('live');

    const live = await getLiveBundle();
    expect(live!.id).toBe('sb-2026-09-refresh');
    // The flaky-test skill was bumped to v3 in this bundle, matching the
    // library — so drift is fully cleared on the new live bundle.
    expect(live!.skills.every((s: SessionBundle['skills'][number]) => s.status === 'current')).toBe(true);

    const superseded = await getBundle('sb-2026-08-fleet');
    expect(superseded!.status).toBe('superseded');
  });
});
