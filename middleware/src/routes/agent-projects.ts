// Agent projects — /api/agent-projects
//
// Link a repository, put it in a workspace, run an agent on it, see what
// changed. The route surface is small because the interesting question is
// narrow: not "what is happening in this repo" in the GitHub sense, but "what
// have the bots done to it".

import { Router } from 'express';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import { readForRolesElseAction, requireAction } from '../lib/authz.js';
import {
  listAgentProjects, getAgentProject, linkAgentProject, unlinkAgentProject,
  buildCloneCommand, markCloned, checkoutPath, finishRun, listRuns,
  listRecentRunsForProjects,
} from '../providers/agent-projects.js';
import { dispatchGovernedRun } from '../lib/sdlc-pipeline.js';

export const agentProjectsRouter: Router = Router();

// Reading the codebase list/runs is the same authority as authorizing a run
// from the marketplace drawer (bots.ts' marketReadGate) — org-leader/hr-admin
// need to see which repos deliver an initiative without holding the devbox
// keys. Every mutation (link/unlink/clone/dispatch/finish) stays on
// ManageDevbox exactly as the router-wide mount previously enforced.
const readGate = readForRolesElseAction(['org-leader', 'hr-admin'], 'DispatchAgentRun');
const writeGate = requireAction('ManageDevbox');

agentProjectsRouter.get('/', readGate, asyncHandler(async (_req, res) => {
  const projects = await listAgentProjects();
  // Recent runs alongside each project — the list is about activity, and a
  // list of repositories with no sign of what happened to them is a directory,
  // not a console. One windowed query returns the latest runs for every repo at
  // once (grouped by project id), rather than a round-trip per repository that
  // grew linearly with the fleet on this polled surface.
  const runsByProject = await listRecentRunsForProjects(projects.map((p) => p.id), 5);
  const withRuns = projects.map((p) => ({
    ...p,
    checkout: checkoutPath(p),
    runs: runsByProject.get(p.id) ?? [],
  }));
  res.json({ projects: withRuns });
}));

agentProjectsRouter.post('/', writeGate, asyncHandler(async (req, res) => {
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
    addedBy: req.session?.sub ?? null,
  });
  res.status(201).json({ project });
}));

agentProjectsRouter.delete('/:id', writeGate, asyncHandler(async (req, res) => {
  const ok = await unlinkAgentProject(String(req.params['id'] ?? ''));
  if (!ok) throw new NotFoundError('No such project');
  res.json({ ok: true });
}));

agentProjectsRouter.get('/:id/runs', readGate, asyncHandler(async (req, res) => {
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
agentProjectsRouter.post('/:id/clone-command', writeGate, asyncHandler(async (req, res) => {
  const project = await getAgentProject(String(req.params['id'] ?? ''));
  if (!project) throw new NotFoundError('No such project');

  const sessionId = String((req.body as { sessionId?: string } ?? {}).sessionId ?? '').trim();
  if (!sessionId) throw new ValidationError('sessionId is required — a project is cloned into a workspace');

  // Build the command but do NOT mark the project cloned yet — generating the
  // command is not the same as the clone succeeding. The caller runs it in the
  // devbox and confirms via POST /:id/cloned only when git exits 0, so a failed
  // clone (e.g. a private repo linked without a credential) never leaves the
  // project looking "in workspace" with an empty/nonexistent checkout.
  const { command, redacted } = await buildCloneCommand(project);
  res.json({ command, redacted, checkout: checkoutPath(project), cwd: project.workspacePath });
}));

// Confirm a successful clone. The portal calls this after the clone command
// exits 0 in the devbox — only then is the project actually in a workspace.
agentProjectsRouter.post('/:id/cloned', writeGate, asyncHandler(async (req, res) => {
  const project = await getAgentProject(String(req.params['id'] ?? ''));
  if (!project) throw new NotFoundError('No such project');
  const sessionId = String((req.body as { sessionId?: string } ?? {}).sessionId ?? '').trim();
  if (!sessionId) throw new ValidationError('sessionId is required');
  await markCloned(project.id, sessionId);
  res.json({ ok: true });
}));

// ─── Runs ────────────────────────────────────────────────────────────────────

agentProjectsRouter.post('/:id/runs', writeGate, asyncHandler(async (req, res) => {
  const project = await getAgentProject(String(req.params['id'] ?? ''));
  if (!project) throw new NotFoundError('No such project');

  const body = (req.body ?? {}) as { prompt?: string; model?: string; sessionId?: string };
  const prompt = body.prompt?.trim();
  if (!prompt) throw new ValidationError('prompt is required');

  const sessionId = body.sessionId ?? project.sessionId;
  if (!sessionId) {
    throw new ValidationError('This project has no workspace — clone it before running anything against it');
  }

  // A run finishes on its own and, if it changed code, flows through
  // governance — capture, review, gates — without anyone submitting it. The
  // dispatch itself lives in one shared place so this and the review loop's
  // "address these findings" cannot diverge.
  const started = await dispatchGovernedRun({ project, prompt, model: body.model ?? null, sessionId });
  if (!started.ok) { res.status(503).json({ error: started.error }); return; }

  res.status(202).json({ run: { id: started.runId }, checkout: started.checkout });
}));

agentProjectsRouter.post('/runs/:runId/finish', writeGate, asyncHandler(async (req, res) => {
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
