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
  listRecentRunsForProjects: jest.fn(),
}));

jest.mock('../../lib/sdlc-pipeline.js', () => ({ dispatchGovernedRun: jest.fn() }));
const boxAccess = { value: true };
jest.mock('../../lib/devbox-visibility.js', () => ({
  requireBoxAccess: jest.fn(async (_req: unknown, res: { status(n: number): { json(b: unknown): void } }) => {
    if (boxAccess.value) return true;
    res.status(403).json({ error: 'no computer here you can reach' });
    return false;
  }),
}));
jest.mock('../../lib/devbox-arn.js', () => ({ resolveDevboxArn: jest.fn(async () => 'arn:devbox'), devboxDataClient: jest.fn(() => ({})) }));
const shell = { output: '' };
jest.mock('../../lib/project-runner.js', () => ({ runDevboxShell: jest.fn(async () => shell.output) }));

import express, { type Request, type Response, type NextFunction } from 'express';
import request from '../../test-support/http.js';
import { agentProjectsRouter } from '../agent-projects.js';
import { errorHandler } from '../../lib/async-handler.js';
import {
  listAgentProjects, getAgentProject, linkAgentProject, unlinkAgentProject, listRuns,
  listRecentRunsForProjects, markCloned, finishRun, buildCloneCommand,
} from '../../providers/agent-projects.js';
import { runDevboxShell } from '../../lib/project-runner.js';
import { dispatchGovernedRun } from '../../lib/sdlc-pipeline.js';

const listMock = listAgentProjects as unknown as jest.Mock;
const getMock = getAgentProject as unknown as jest.Mock;
const linkMock = linkAgentProject as unknown as jest.Mock;
const unlinkMock = unlinkAgentProject as unknown as jest.Mock;
const listRunsMock = listRuns as unknown as jest.Mock;
const recentRunsMock = listRecentRunsForProjects as unknown as jest.Mock;
const dispatchMock = dispatchGovernedRun as unknown as jest.Mock;
const markClonedMock = markCloned as unknown as jest.Mock;
const finishRunMock = finishRun as unknown as jest.Mock;

const PROJECT = { id: 'p-1', repoFullName: 'org/rag-search', orgProjectId: 'p-rag-search', sessionId: null };
const RUN = { id: 'run-1', projectId: 'p-1', status: 'done', startedAt: '2026-08-20T00:00:00Z' };

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
  recentRunsMock.mockReset(); recentRunsMock.mockResolvedValue(new Map([['p-1', [RUN]]]));
  markClonedMock.mockReset(); markClonedMock.mockResolvedValue(undefined);
  finishRunMock.mockReset(); finishRunMock.mockResolvedValue(undefined);
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

  it('attaches recent runs via ONE grouped query, never listRuns per project (N+1 fix)', async () => {
    listMock.mockResolvedValue([PROJECT, { ...PROJECT, id: 'p-2', repoFullName: 'org/scoring' }]);
    recentRunsMock.mockResolvedValue(new Map([['p-1', [RUN]], ['p-2', []]]));

    const res = await request(buildApp(leader)).get('/api/agent-projects');
    expect(res.status).toBe(200);
    // Exactly one fan-out call, with every project id and a per-project cap of 5.
    expect(recentRunsMock).toHaveBeenCalledTimes(1);
    expect(recentRunsMock).toHaveBeenCalledWith(['p-1', 'p-2'], 5);
    // The list path must NOT round-trip per project.
    expect(listRunsMock).not.toHaveBeenCalled();
    // Response shape unchanged: each project keeps its `runs` array (grouped by id).
    expect(res.body.projects[0]!.runs).toEqual([RUN]);
    expect(res.body.projects[1]!.runs).toEqual([]);
    expect(res.body.projects[0]!.checkout).toBe('/workspace/checkout');
  });

  it('defaults a project with no runs in the map to an empty array', async () => {
    recentRunsMock.mockResolvedValue(new Map());
    const res = await request(buildApp(leader)).get('/api/agent-projects');
    expect(res.status).toBe(200);
    expect(res.body.projects[0]!.runs).toEqual([]);
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

describe('POST /api/agent-projects/:id/clone-command — runs the clone server-side', () => {
  const TOKEN = 'ghs_SECRETtoken123';
  beforeEach(() => {
    boxAccess.value = true;
    (buildCloneCommand as unknown as jest.Mock).mockResolvedValue({
      command: `git clone --depth 50 https://x-access-token:${TOKEN}@github.com/org/rag-search.git /w/rag-search`,
      redacted: 'git clone --depth 50 https://***@github.com/org/rag-search.git /w/rag-search',
    });
    (runDevboxShell as unknown as jest.Mock).mockClear();
  });

  it('never returns the credentialed command, and scrubs credentials git echoes back', async () => {
    shell.output = `Cloning into '/w/rag-search'...\nwarning: redirect https://x-access-token:${TOKEN}@github.com/org/rag-search.git\n`;
    const res = await request(buildApp(leader)).post('/api/agent-projects/p-1/clone-command').send({ sessionId: 's-1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.command).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect(res.body.output).toContain('https://***@github.com');
    expect(runDevboxShell).toHaveBeenCalledWith(expect.anything(), 'arn:devbox', 's-1', expect.stringContaining(TOKEN));
    expect(markClonedMock).not.toHaveBeenCalled();
  });

  it('reports a failed clone as ok:false with the scrubbed git error', async () => {
    shell.output = `fatal: unable to access 'https://x-access-token:${TOKEN}@github.com/org/rag-search.git/': Could not resolve host\n`;
    const res = await request(buildApp(leader)).post('/api/agent-projects/p-1/clone-command').send({ sessionId: 's-1' });
    expect(res.body.ok).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });

  it('treats git\'s benign dubious-ownership notice as success', async () => {
    shell.output = 'fatal: detected dubious ownership in repository at /w/rag-search\n';
    const res = await request(buildApp(leader)).post('/api/agent-projects/p-1/clone-command').send({ sessionId: 's-1' });
    expect(res.body.ok).toBe(true);
  });

  it('refuses a box the caller cannot reach, and runs nothing', async () => {
    boxAccess.value = false;
    const res = await request(buildApp(leader)).post('/api/agent-projects/p-1/clone-command').send({ sessionId: 's-other' });
    expect(res.status).toBe(403);
    expect(runDevboxShell).not.toHaveBeenCalled();
  });
});

describe('POST /api/agent-projects/:id/cloned', () => {
  it('marks the project cloned into the confirmed session', async () => {
    const res = await request(buildApp(leader)).post('/api/agent-projects/p-1/cloned').send({ sessionId: '  s-42  ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(getMock).toHaveBeenCalledWith('p-1');
    expect(markClonedMock).toHaveBeenCalledWith('p-1', 's-42');
  });

  it('400s without a sessionId and never marks the project', async () => {
    const res = await request(buildApp(leader)).post('/api/agent-projects/p-1/cloned').send({});
    expect(res.status).toBe(400);
    expect(markClonedMock).not.toHaveBeenCalled();
  });

  it('404s an unknown project', async () => {
    getMock.mockResolvedValue(null);
    const res = await request(buildApp(leader)).post('/api/agent-projects/nope/cloned').send({ sessionId: 's-1' });
    expect(res.status).toBe(404);
    expect(markClonedMock).not.toHaveBeenCalled();
  });

  it('refuses once ManageDevbox is denied', async () => {
    manageAllow.value = false;
    const res = await request(buildApp(leader)).post('/api/agent-projects/p-1/cloned').send({ sessionId: 's-1' });
    expect(res.status).toBe(403);
    expect(markClonedMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/agent-projects/runs/:runId/finish', () => {
  it('records a failed run with its error and nulls what was not sent', async () => {
    const res = await request(buildApp(leader)).post('/api/agent-projects/runs/run-1/finish').send({ status: 'failed', error: 'git exited 128' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(finishRunMock).toHaveBeenCalledWith('run-1', { status: 'failed', filesChanged: null, diffSummary: null, error: 'git exited 128' });
  });

  it('any status other than "failed" finishes as done', async () => {
    await request(buildApp(leader)).post('/api/agent-projects/runs/run-2/finish').send({ status: 'running', filesChanged: 3, diffSummary: '+3 -1' });
    expect(finishRunMock).toHaveBeenCalledWith('run-2', { status: 'done', filesChanged: 3, diffSummary: '+3 -1', error: null });
  });

  it('refuses once ManageDevbox is denied', async () => {
    manageAllow.value = false;
    const res = await request(buildApp(leader)).post('/api/agent-projects/runs/run-1/finish').send({ status: 'done' });
    expect(res.status).toBe(403);
    expect(finishRunMock).not.toHaveBeenCalled();
  });
});
