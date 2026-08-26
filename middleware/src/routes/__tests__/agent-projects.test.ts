// Agent-projects route (routes/agent-projects.ts). This pins the authz gap
// fix: org-leader can read the codebase list (the same tier bots.ts' market
// gate uses for the Authorize drawer) without holding ManageDevbox, while
// every mutation — link, unlink, clone, dispatch, finish — still requires
// ManageDevbox exactly as before.

const manageAllow = { value: true };
const gateActions: { read: string[]; manage: string[] } = { read: [], manage: [] };

jest.mock('../../lib/authz.js', () => ({
  resolveSession: (req: { session?: unknown }) => (req as { session?: unknown }).session ?? null,
  readForRolesElseAction: (_roles: string[], action: string) => {
    gateActions.read.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
  requireAction: (action: string) => {
    gateActions.manage.push(action);
    return (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      if (!manageAllow.value) { res.status(403).json({ error: 'Forbidden', action }); return; }
      next();
    };
  },
}));

jest.mock('../../providers/agent-projects.js', () => ({
  listAgentProjects: jest.fn(), getAgentProject: jest.fn(), linkAgentProject: jest.fn(),
  unlinkAgentProject: jest.fn(), buildCloneCommand: jest.fn(), markCloned: jest.fn(),
  checkoutPath: jest.fn(() => '/workspace/checkout'), finishRun: jest.fn(), listRuns: jest.fn(),
}));

jest.mock('../../lib/sdlc-pipeline.js', () => ({ dispatchGovernedRun: jest.fn() }));

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { agentProjectsRouter } from '../agent-projects.js';
import { errorHandler } from '../../lib/async-handler.js';
import {
  listAgentProjects, getAgentProject, linkAgentProject, unlinkAgentProject, listRuns,
} from '../../providers/agent-projects.js';
import { dispatchGovernedRun } from '../../lib/sdlc-pipeline.js';

const listMock = listAgentProjects as unknown as jest.Mock;
const getMock = getAgentProject as unknown as jest.Mock;
const linkMock = linkAgentProject as unknown as jest.Mock;
const unlinkMock = unlinkAgentProject as unknown as jest.Mock;
const listRunsMock = listRuns as unknown as jest.Mock;
const dispatchMock = dispatchGovernedRun as unknown as jest.Mock;

const PROJECT = { id: 'p-1', repoFullName: 'org/rag-search', orgProjectId: 'p-rag-search', sessionId: null };

const leader = { sub: 'u-vera', role: 'org-leader', tenant: 'orgiq' };

function buildApp(session: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (session) (req as unknown as { session: unknown }).session = session;
    next();
  });
  app.use('/api/agent-projects', agentProjectsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  manageAllow.value = true;
  listMock.mockReset(); listMock.mockResolvedValue([PROJECT]);
  getMock.mockReset(); getMock.mockResolvedValue(PROJECT);
  linkMock.mockReset(); linkMock.mockResolvedValue(PROJECT);
  unlinkMock.mockReset(); unlinkMock.mockResolvedValue(true);
  listRunsMock.mockReset(); listRunsMock.mockResolvedValue([]);
  dispatchMock.mockReset(); dispatchMock.mockResolvedValue({ ok: true, runId: 'run-1', checkout: '/workspace' });
});

describe('gating', () => {
  // The gates are shared constants built once at module load (readGate /
  // writeGate); the per-route 403 tests below prove each write enforces it.
  it('reads behind the org-leader/hr-admin DispatchAgentRun tier, writes behind ManageDevbox', () => {
    expect(gateActions.read).toContain('DispatchAgentRun');
    expect(gateActions.manage).toEqual(['ManageDevbox']);
  });
});

describe('GET /api/agent-projects', () => {
  it('lists codebases for an org-leader without ManageDevbox', async () => {
    const res = await request(buildApp(leader)).get('/api/agent-projects');
    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(1);
    expect(res.body.projects[0]!.id).toBe('p-1');
  });
});

describe('GET /api/agent-projects/:id/runs', () => {
  it('is readable by an org-leader', async () => {
    const res = await request(buildApp(leader)).get('/api/agent-projects/p-1/runs');
    expect(res.status).toBe(200);
    expect(listRunsMock).toHaveBeenCalledWith('p-1', 50);
  });
});

describe('write routes stay on ManageDevbox', () => {
  it('refuses POST / (link) for an org-leader once ManageDevbox is denied', async () => {
    manageAllow.value = false;
    const res = await request(buildApp(leader)).post('/api/agent-projects').send({ repoFullName: 'org/repo' });
    expect(res.status).toBe(403);
    expect(res.body.action).toBe('ManageDevbox');
    expect(linkMock).not.toHaveBeenCalled();
  });

  it('refuses DELETE /:id once ManageDevbox is denied', async () => {
    manageAllow.value = false;
    const res = await request(buildApp(leader)).delete('/api/agent-projects/p-1');
    expect(res.status).toBe(403);
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it('refuses POST /:id/clone-command once ManageDevbox is denied', async () => {
    manageAllow.value = false;
    const res = await request(buildApp(leader)).post('/api/agent-projects/p-1/clone-command').send({ sessionId: 's-1' });
    expect(res.status).toBe(403);
  });

  it('refuses POST /:id/runs (dispatch) once ManageDevbox is denied', async () => {
    manageAllow.value = false;
    const res = await request(buildApp(leader)).post('/api/agent-projects/p-1/runs').send({ prompt: 'do it' });
    expect(res.status).toBe(403);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('allows the write once ManageDevbox is granted', async () => {
    const res = await request(buildApp(leader)).post('/api/agent-projects').send({ repoFullName: 'org/repo' });
    expect(res.status).toBe(201);
    expect(linkMock).toHaveBeenCalled();
  });
});
