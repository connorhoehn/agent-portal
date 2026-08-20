// Agent projects — /api/agent-projects
//
// Link a repository, put it in a workspace, run an agent on it, see what
// changed. The route surface is small because the interesting question is
// narrow: not "what is happening in this repo" in the GitHub sense, but "what
// have the bots done to it".

import { Router } from 'express';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import {
  listAgentProjects, getAgentProject, linkAgentProject, unlinkAgentProject,
  buildCloneCommand, markCloned, checkoutPath, startRun, finishRun, listRuns,
} from '../providers/agent-projects.js';
import { executeProjectRun } from '../lib/project-runner.js';
import { resolveDevboxArn, devboxDataClient } from '../lib/devbox-arn.js';
import { registerBox, getBoxBySession, appendEvent } from '../lib/devbox-fleet.js';

export const agentProjectsRouter: Router = Router();

agentProjectsRouter.get('/', asyncHandler(async (_req, res) => {
  const projects = await listAgentProjects();
  // Recent runs alongside each project — the list is about activity, and a
  // list of repositories with no sign of what happened to them is a directory,
  // not a console.
  const withRuns = await Promise.all(projects.map(async (p) => ({
    ...p,
    checkout: checkoutPath(p),
    runs: await listRuns(p.id, 5),
  })));
  res.json({ projects: withRuns });
}));

agentProjectsRouter.post('/', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as {
    repoFullName?: string; defaultBranch?: string; connectionName?: string | null;
    orgProjectId?: string | null;
  };
  const repo = body.repoFullName?.trim();
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new ValidationError('repoFullName must be in owner/name form');
  }
  const project = await linkAgentProject({
    repoFullName: repo,
    ...(body.defaultBranch ? { defaultBranch: body.defaultBranch } : {}),
    connectionName: body.connectionName ?? null,
    orgProjectId: body.orgProjectId ?? null,
    addedBy: (req as { session?: { email?: string } }).session?.email ?? null,
  });
  res.status(201).json({ project });
}));

agentProjectsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const ok = await unlinkAgentProject(String(req.params['id'] ?? ''));
  if (!ok) throw new NotFoundError('No such project');
  res.json({ ok: true });
}));

agentProjectsRouter.get('/:id/runs', asyncHandler(async (req, res) => {
  res.json({ runs: await listRuns(String(req.params['id'] ?? ''), 50) });
}));

/**
 * The clone command for a project, ready to run in a devbox.
 *
 * Returned rather than executed here: the devbox command API streams its
 * output over SSE to whoever called it, and proxying that through this route
 * would mean the portal watches a copy instead of the real thing.
 *
 * The response carries the command because the caller has to run it — and the
 * caller is the portal, over an authenticated session. The redacted form is
 * what anything else should record.
 */
agentProjectsRouter.post('/:id/clone-command', asyncHandler(async (req, res) => {
  const project = await getAgentProject(String(req.params['id'] ?? ''));
  if (!project) throw new NotFoundError('No such project');

  const sessionId = String((req.body as { sessionId?: string } ?? {}).sessionId ?? '').trim();
  if (!sessionId) throw new ValidationError('sessionId is required — a project is cloned into a workspace');

  const { command, redacted } = await buildCloneCommand(project);
  await markCloned(project.id, sessionId);
  res.json({ command, redacted, checkout: checkoutPath(project), cwd: project.workspacePath });
}));

// ─── Runs ────────────────────────────────────────────────────────────────────

agentProjectsRouter.post('/:id/runs', asyncHandler(async (req, res) => {
  const project = await getAgentProject(String(req.params['id'] ?? ''));
  if (!project) throw new NotFoundError('No such project');

  const body = (req.body ?? {}) as { prompt?: string; model?: string; sessionId?: string };
  const prompt = body.prompt?.trim();
  if (!prompt) throw new ValidationError('prompt is required');

  const sessionId = body.sessionId ?? project.sessionId;
  if (!sessionId) {
    throw new ValidationError('This project has no workspace — clone it before running anything against it');
  }

  const run = await startRun({
    projectId: project.id, prompt, model: body.model ?? null, sessionId,
  });
  const checkout = checkoutPath(project);

  // Answer now, finish in the background.
  //
  // The run used to be driven by whichever browser tab started it, so closing
  // the tab left the row at `running` forever. Owning the lifecycle here means
  // a run completes — and records what changed — whether or not anyone is
  // watching.
  const arn = await resolveDevboxArn();
  if (!arn) {
    await finishRun(run.id, { status: 'failed', error: 'the devbox runtime is not deployed' });
    res.status(503).json({ error: 'devbox runtime not deployed' });
    return;
  }

  const box = getBoxBySession(sessionId) ?? registerBox({ sessionId });
  void executeProjectRun({
    runId: run.id,
    sessionId,
    checkout,
    prompt,
    model: body.model ?? null,
    runtimeArn: arn,
    client: devboxDataClient(),
    // Tee into the fleet log so the terminal dock and box tail show the run
    // as it happens, exactly as a manually started task does.
    onEvent: (ev) => appendEvent(box.id, ev),
  });

  res.status(202).json({ run, checkout });
}));

agentProjectsRouter.post('/runs/:runId/finish', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as {
    status?: string; filesChanged?: number; diffSummary?: string; error?: string;
  };
  const status = body.status === 'failed' ? 'failed' : 'done';
  await finishRun(String(req.params['runId'] ?? ''), {
    status,
    filesChanged: body.filesChanged ?? null,
    diffSummary: body.diffSummary ?? null,
    error: body.error ?? null,
  });
  res.json({ ok: true });
}));
