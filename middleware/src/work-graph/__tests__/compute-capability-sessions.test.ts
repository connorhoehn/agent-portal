import {
  createComputeCapabilitySessions,
  type ComputeCapabilityResource,
  type ComputeCapabilitySources,
  type ComputeCapabilityTarget,
} from '../compute-capability-sessions.js';

const resource: ComputeCapabilityResource = { source: 'cloud-compute', resourceId: 'box:box-1' };
const now = Date.parse('2026-09-21T12:00:00.000Z');

function target(overrides: Partial<ComputeCapabilityTarget> = {}): ComputeCapabilityTarget {
  return {
    ownerId: 'person-1', resource, status: 'running', controllable: true,
    revocationKeys: ['box:box-1'], ...overrides,
  };
}

function fixture(overrides: Partial<ComputeCapabilitySources> = {}) {
  let current: ComputeCapabilityTarget | null = target();
  const sources: ComputeCapabilitySources = {
    resolve: jest.fn(async () => current),
    cancel: jest.fn(async () => true),
    ...overrides,
  };
  const sessions = createComputeCapabilitySessions({
    organizationId: 'org-1', sources, now: () => now, newId: () => 'capability-session-1', maxTtlMs: 60_000,
  });
  return {
    sources, sessions,
    setTarget(next: ComputeCapabilityTarget | null) { current = next; },
  };
}

function openInput(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1', viewerId: 'person-1', personId: 'person-1', resource,
    capability: 'observe' as const, requestedExpiresAt: new Date(now + 10 * 60_000).toISOString(), ...overrides,
  };
}

describe('source-owned compute capability sessions', () => {
  it('requires an exact durable owner match and source-configured organization', async () => {
    const { sessions } = fixture();
    await expect(sessions.open(openInput({ personId: 'person-2' }))).resolves.toEqual({ allowed: false, reason: 'owner-mismatch' });
    await expect(sessions.open(openInput({ organizationId: 'org-2' }))).resolves.toEqual({ allowed: false, reason: 'invalid-request' });
  });

  it('keeps a read attachment from escalating to control', async () => {
    const { sessions } = fixture();
    const observed = await sessions.open(openInput({ viewerId: 'person-2' }));
    if (!observed.allowed) throw new Error('expected observe session');
    await expect(sessions.use(observed.session.sessionId, 'control')).resolves.toEqual({ allowed: false, reason: 'control-not-allowed' });
  });

  it('denies control where the durable source cannot perform it', async () => {
    const { sessions } = fixture({ resolve: jest.fn(async () => target({ controllable: false })) });
    await expect(sessions.open(openInput({ capability: 'control' }))).resolves.toEqual({ allowed: false, reason: 'control-not-allowed' });
  });

  it('reports direct source access without allocating a capability session', async () => {
    const { sessions } = fixture();
    await expect(sessions.authorizeDisclosure({
      organizationId: 'org-1', viewerId: 'person-1', personId: 'person-1', resource,
    })).resolves.toEqual({ allowed: true, directAccess: true, capabilities: ['observe-terminal', 'control-terminal'] });
    await expect(sessions.authorizeDisclosure({
      organizationId: 'org-1', viewerId: 'person-2', personId: 'person-1', resource,
    })).resolves.toEqual({ allowed: true, directAccess: false, capabilities: ['observe-terminal', 'control-terminal'] });
    expect(sessions._sessionsForTest()).toHaveLength(0);
  });

  it('caps source-side expiry and actively notifies when durable ownership changes', async () => {
    const { sessions, setTarget } = fixture();
    const opened = await sessions.open(openInput());
    if (!opened.allowed) throw new Error('expected session');
    expect(opened.session.expiresAt).toBe(new Date(now + 60_000).toISOString());
    const ended = jest.fn();
    sessions.subscribe(opened.session.sessionId, ended);
    setTarget(target({ ownerId: 'person-2' }));
    await expect(sessions.revalidate(opened.session.sessionId)).resolves.toEqual({ allowed: false, reason: 'owner-mismatch' });
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ active: false, endReason: 'owner-mismatch' }));
  });

  it('terminates attached transports immediately on source revocation', async () => {
    const { sessions } = fixture();
    const opened = await sessions.open(openInput());
    if (!opened.allowed) throw new Error('expected session');
    const ended = jest.fn();
    sessions.subscribe(opened.session.sessionId, ended);
    expect(sessions.invalidateByRevocationKey('cloud-compute', 'box:box-1')).toBe(1);
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ active: false, endReason: 'source-revoked' }));
    await expect(sessions.revalidate(opened.session.sessionId)).resolves.toEqual({ allowed: false, reason: 'source-revoked' });
  });

  it('rechecks source truth before control and never cancels a vanished resource', async () => {
    const { sessions, sources, setTarget } = fixture();
    const opened = await sessions.open(openInput({ capability: 'control' }));
    if (!opened.allowed) throw new Error('expected control session');
    setTarget(null);
    await expect(sessions.use(opened.session.sessionId, 'control')).resolves.toEqual({ allowed: false, reason: 'source-missing' });
    expect(sources.cancel).not.toHaveBeenCalled();
  });

  it('rechecks ownership immediately before the irreversible control call', async () => {
    const resolve = jest.fn()
      .mockResolvedValueOnce(target()) // open
      .mockResolvedValueOnce(target()) // revalidate at use
      .mockResolvedValueOnce(target({ ownerId: 'person-2' })); // just before cancel
    const { sessions, sources } = fixture({ resolve });
    const opened = await sessions.open(openInput({ capability: 'control' }));
    if (!opened.allowed) throw new Error('expected control session');
    await expect(sessions.use(opened.session.sessionId, 'control')).resolves.toEqual({ allowed: false, reason: 'owner-mismatch' });
    expect(sources.cancel).not.toHaveBeenCalled();
  });
});
