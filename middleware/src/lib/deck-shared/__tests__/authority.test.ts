// The ONE deck write rule (lib/deck-shared/authority.ts): 4 tenants x writer /
// reader / outsider / forged subject. Sessions are hand-built; the directory
// re-read is the identity, Cedar decisions come from the role registry below.

jest.mock('../../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true, agentcore: true } },
}));
jest.mock('../../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'assessor', tenant: 'assessment', label: 'A', summary: '', capabilities: ['ViewAssessment', 'RunAssessmentAgent'] },
    { id: 'lead-assessor', tenant: 'assessment', label: 'R', summary: '', capabilities: ['ViewAssessment'] },
    { id: 'operator', tenant: 'pipelines', label: 'O', summary: '', capabilities: ['ViewPipelines', 'RunPipeline'] },
    { id: 'author', tenant: 'pipelines', label: 'R', summary: '', capabilities: ['ViewPipelines'] },
    { id: 'sme', tenant: 'orgiq', label: 'S', summary: '', capabilities: ['DispatchAgentRun'] },
    { id: 'member', tenant: 'orgiq', label: 'M', summary: '', capabilities: [] },
  ],
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));
jest.mock('../../live-principal.js', () => ({ currentLiveSession: async (session: unknown) => session }));
// Sweep 11: an orgiq deck is written by its initiative's own people; `u-off` is on none.
jest.mock('../../initiative-scope.js', () => ({
  stewardsInitiative: async (session: { sub?: string } | null) => !!session?.sub && session.sub !== 'u-off',
}));
// Social: the conversation's current grant + membership is chatAccess; the members below are the only ones it admits.
jest.mock('../../../routes/chat-pins.js', () => ({
  chatAccess: async (req: { session?: { sub: string; role: string } }, channel: string, action: string) => {
    const sub = req.session?.sub;
    if (!sub) throw Object.assign(new Error('Unauthenticated'), { status: 401 });
    const { AppError } = jest.requireActual('../../async-handler.js');
    if (channel !== 'social:ch:general' || !['u-writer', 'u-owner'].includes(sub) || (action === 'PostMessage' && req.session?.role === 'reader')) {
      throw new AppError(403, 'Not a member of this conversation');
    }
    return sub;
  },
}));

import type { Request } from 'express';
import { deckWriteAuthority, type DeckSubject, type DeckTenant } from '../authority.js';

const req = (session: Record<string, unknown> | null): Request => ({ session: session ? { iat: 0, grants: {}, ...session } : undefined }) as unknown as Request;
const status = async (p: Promise<unknown>): Promise<number> => { try { await p; return 200; } catch (e) { return (e as { status?: number }).status ?? 500; } };

interface Case { tenant: DeckTenant; subject: DeckSubject; writer: Record<string, unknown>; reader: Record<string, unknown>; outsider: Record<string, unknown>; foreign: DeckSubject }
const CASES: Case[] = [
  { tenant: 'assessment', subject: { tenant: 'assessment', teamId: 'TEAM-001' }, foreign: { tenant: 'pipelines', runId: 'job:x' },
    writer: { sub: 'u1', tenant: 'assessment', role: 'assessor' }, reader: { sub: 'u2', tenant: 'assessment', role: 'lead-assessor' }, outsider: { sub: 'u3', tenant: 'orgiq', role: 'sme' } },
  { tenant: 'pipelines', subject: { tenant: 'pipelines', runId: 'job:x' }, foreign: { tenant: 'orgiq', projectId: 'p-soc2' },
    writer: { sub: 'u1', tenant: 'pipelines', role: 'operator' }, reader: { sub: 'u2', tenant: 'pipelines', role: 'author' }, outsider: { sub: 'u3', tenant: 'assessment', role: 'assessor' } },
  { tenant: 'orgiq', subject: { tenant: 'orgiq', projectId: 'p-soc2' }, foreign: { tenant: 'assessment', teamId: 'TEAM-001' },
    writer: { sub: 'u1', tenant: 'orgiq', role: 'sme' }, reader: { sub: 'u2', tenant: 'orgiq', role: 'member' }, outsider: { sub: 'u3', tenant: 'pipelines', role: 'operator' } },
  { tenant: 'social', subject: { tenant: 'social', channel: 'social:ch:general', ownerId: 'u-owner' }, foreign: { tenant: 'assessment', teamId: 'TEAM-001' },
    writer: { sub: 'u-writer', tenant: 'social', role: 'participant' }, reader: { sub: 'u-writer', tenant: 'social', role: 'reader' }, outsider: { sub: 'u-out', tenant: 'social', role: 'participant' } },
];

describe.each(CASES)('deckWriteAuthority — $tenant', (c) => {
  it('the actor who may run the tenant agent on the subject writes (build, save, revise, share)', async () => {
    for (const op of ['build', 'save', 'revise', 'share'] as const) {
      expect((await deckWriteAuthority(c.tenant, c.subject, req(c.writer), op)).sub).toBe(c.writer['sub']);
    }
  });
  it('a reader is refused', async () => { expect(await status(deckWriteAuthority(c.tenant, c.subject, req(c.reader)))).toBe(403); });
  it('an outsider (another tenant / non-member) is refused; an anonymous caller is 401', async () => {
    expect(await status(deckWriteAuthority(c.tenant, c.subject, req(c.outsider)))).toBe(403);
    expect(await status(deckWriteAuthority(c.tenant, c.subject, req(null)))).toBe(401);
  });
  it('a forged subject (another tenant\'s subject under this tenant\'s rule) is refused', async () => {
    expect(await status(deckWriteAuthority(c.tenant, c.foreign, req(c.writer)))).toBe(403);
  });
});

describe('deckWriteAuthority — orgiq needs the initiative\'s own people (sweep 11)', () => {
  it('a DispatchAgentRun holder who is not on the initiative is refused every write', async () => {
    for (const op of ['build', 'save', 'revise', 'share'] as const) {
      expect(await status(deckWriteAuthority('orgiq', { tenant: 'orgiq', projectId: 'p-soc2' }, req({ sub: 'u-off', tenant: 'orgiq', role: 'sme' }), op))).toBe(403);
    }
  });
});

describe('deckWriteAuthority — social delete is owner-only', () => {
  const subject: DeckSubject = { tenant: 'social', channel: 'social:ch:general', ownerId: 'u-owner' };
  it('a member may write but only the owner deletes', async () => {
    expect(await status(deckWriteAuthority('social', subject, req({ sub: 'u-writer', tenant: 'social', role: 'participant' }), 'delete'))).toBe(403);
    expect((await deckWriteAuthority('social', subject, req({ sub: 'u-owner', tenant: 'social', role: 'participant' }), 'delete')).sub).toBe('u-owner');
  });
  it('a forged channel the caller is not in is refused', async () => {
    expect(await status(deckWriteAuthority('social', { ...subject, channel: 'social:ch:secret' }, req({ sub: 'u-writer', tenant: 'social', role: 'participant' })))).toBe(403);
  });
});
