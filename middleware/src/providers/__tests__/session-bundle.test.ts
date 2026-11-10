// The session bundle: the live-impact count and the seeded live bundle.

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { sessionsAffected, getLiveBundle } from '../session-bundle.js';

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

describe('the live bundle', () => {
  it('serves the live bundle mirroring the real managed-settings.json hook', async () => {
    const live = await getLiveBundle();
    expect(live).not.toBeNull();
    expect(live!.hooks.some((h) => h.event === 'SessionStart' && h.command === 'lab brief')).toBe(true);
  });

  it('marks exactly one bundled skill stale on the live bundle', async () => {
    const live = await getLiveBundle();
    const stale = live!.skills.filter((s) => s.status === 'stale');
    expect(stale.length).toBe(1);
  });
});
