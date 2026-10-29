// Agent projects — /api/agent-projects
//
// Link a repository, put it in a workspace, run an agent on it, see what
// changed. The route surface is small because the interesting question is
// narrow: not "what is happening in this repo" in the GitHub sense, but "what
// have the bots done to it".

import { Router } from 'express';
import { requireBoxAccess } from '../lib/devbox-visibility.js';
import { requireInitiativeScope } from '../lib/initiative-scope.js';
import { resolveDevboxArn, devboxDataClient } from '../lib/devbox-arn.js';
import { cloneIntoBox } from '../lib/devbox-git.js';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import { readForRolesElseAction, requireAction, resolveSession } from '../lib/authz.js';
import { authorizeAgentAction } from '../lib/agent-actions.js';
import {
  listAgentProjects, getAgentProject, linkAgentProject, unlinkAgentProject,
  markCloned, checkoutPath, finishRun, listRuns,
  listRecentRunsForProjects, getRunProjectId,
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
  // Repo-target bots inherit this initiative, so linking a codebase to one
  // redirects their spend there: the steward's call (DE-44 row 10).
  if (!await requireInitiativeScope(req, res, body.orgProjectId ?? null, { action: 'link codebases' })) return;
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
  const existing = await getAgentProject(String(req.params['id'] ?? ''));
  if (!existing) throw new NotFoundError('No such project');
  if (!await requireInitiativeScope(req, res, existing.orgProjectId, { action: 'unlink codebases' })) return;
  const ok = await unlinkAgentProject(String(req.params['id'] ?? ''));
  if (!ok) throw new NotFoundError('No such project');
  res.json({ ok: true });
}));

agentProjectsRouter.get('/:id/runs', readGate, asyncHandler(async (req, res) => {
  res.json({ runs: await listRuns(String(req.params['id'] ?? ''), 50) });
}));

/**
 * Clone a project into a devbox, run HERE rather than handed to the caller.
 *
 * This route used to return the clone command for the portal to post back to
 * `/api/devbox/:sid/command`. For a private repository that command carries
 * the connection's GitHub token in the URL, so every clone sent a live
 * credential to the browser (DE-44/DE-45). Now the command is built and run
 * server-side, the caller must be able to reach the box (the same check as
 * every devbox route), and only redacted text comes back: the command's
 * redacted form and git's output with URL credentials scrubbed, since git
 * echoes the URL verbatim in `fatal: unable to access '<url>'`.
 *
 * Still not marked cloned: the portal confirms via POST /:id/cloned once it
 * has read `ok`, so a failed clone never leaves a phantom checkout.
 */
agentProjectsRouter.post('/:id/clone-command', writeGate, asyncHandler(async (req, res) => {
  const project = await getAgentProject(String(req.params['id'] ?? ''));
  if (!project) throw new NotFoundError('No such project');

  const sessionId = String((req.body as { sessionId?: string } ?? {}).sessionId ?? '').trim();
  if (!sessionId) throw new ValidationError('sessionId is required — a project is cloned into a workspace');
  if (!await requireInitiativeScope(req, res, project.orgProjectId, { action: 'clone codebases' })) return;
  if (!await requireBoxAccess(req, res, sessionId)) return;
  const arn = await resolveDevboxArn();
  if (!arn) { res.status(503).json({ error: 'the devbox runtime is not deployed' }); return; }

  // Through the one clone function (lib/devbox-git.ts, DE-45): with the git
  // entrypoint on, a per-run read token minted for this repository goes in an
  // invoke payload and never in shell text; off, the legacy shell clone runs
  // as before. Either way only redacted text comes back.
  const outcome = await cloneIntoBox({
    client: devboxDataClient(), arn, sessionId, project,
    runRef: `clone:${sessionId}`, callerSub: resolveSession(req)?.sub ?? null,
  });
  if (!outcome.ok && outcome.error && !outcome.output) {
    res.status(502).json({ ok: false, error: outcome.error.startsWith('clone failed') ? outcome.error : `clone failed: ${outcome.error}`, redacted: outcome.redacted });
    return;
  }
  res.json({ ok: outcome.ok, output: outcome.output, redacted: outcome.redacted, checkout: outcome.checkout, cwd: project.workspacePath });
}));

// Confirm a successful clone. The portal calls this after the clone command
// exits 0 in the devbox — only then is the project actually in a workspace.
agentProjectsRouter.post('/:id/cloned', writeGate, asyncHandler(async (req, res) => {
  const project = await getAgentProject(String(req.params['id'] ?? ''));
  if (!project) throw new NotFoundError('No such project');
  const sessionId = String((req.body as { sessionId?: string } ?? {}).sessionId ?? '').trim();
  if (!sessionId) throw new ValidationError('sessionId is required');
  // Repointing a codebase at a box: the caller must reach that box (row 13).
  if (!await requireBoxAccess(req, res, sessionId)) return;
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
  // A run spends on the codebase's initiative and executes in a box: steward,
  // the grant an SME spends under, and access to that box (DE-44 row 14).
  if (!await requireInitiativeScope(req, res, project.orgProjectId, { spend: true, action: 'run agents' })) return;
  if (!await requireBoxAccess(req, res, sessionId)) return;
  // Running Claude Code on the box is RunDevboxTask (DE-42); the scope checks
  // above already put the caller on the initiative.
  if (!await authorizeAgentAction(req, res, 'RunDevboxTask', { onInitiative: true })) return;

  // A run finishes on its own and, if it changed code, flows through
  // governance — capture, review, gates — without anyone submitting it. The
  // dispatch itself lives in one shared place so this and the review loop's
  // "address these findings" cannot diverge.
  const started = await dispatchGovernedRun({
    project, prompt, model: body.model ?? null, sessionId,
    // The change this run captures answers to the person who started it (DE-43).
    dispatchedBy: resolveSession(req)?.sub ?? null,
  });
  if (!started.ok) {
    // An unlisted model (DE-40) is the caller's mistake: 400 with the allowed set.
    if (started.code === 'MODEL_NOT_ALLOWED') {
      res.status(400).json({ error: started.error, code: started.code, allowedModels: started.allowedModels ?? [] });
      return;
    }
    // A money refusal (DE-34) is the same 409 / 403 / 503 the dispatch route
    // answers; anything else is the runtime's 503.
    const r = started.refusal;
    if (r?.kind === 'confirm') {
      res.status(409).json({
        error: r.reason, gate: r.gate, confirmFlag: r.confirmFlag, confidence: r.confidence,
        ...(r.allocation ? { allocation: r.allocation } : {}),
        ...(r.envelope ? { envelope: r.envelope } : {}),
      });
      return;
    }
    if (r?.kind === 'refused') { res.status(403).json({ error: started.error, gate: 'spend-hold' }); return; }
    res.status(503).json({ error: started.error, ...(r ? { gate: 'spend-hold' } : {}) });
    return;
  }

  res.status(202).json({ run: { id: started.runId }, checkout: started.checkout });
}));

agentProjectsRouter.post('/runs/:runId/finish', writeGate, asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as {
    status?: string; filesChanged?: number; diffSummary?: string; error?: string;
  };
  const status = body.status === 'failed' ? 'failed' : 'done';
  // Setting a run's outcome is the codebase's steward's call (DE-44 row 15).
  const projectId = await getRunProjectId(String(req.params['runId'] ?? ''));
  if (projectId) {
    const project = await getAgentProject(projectId);
    if (!await requireInitiativeScope(req, res, project?.orgProjectId ?? null, { action: 'finish runs' })) return;
  }
  await finishRun(String(req.params['runId'] ?? ''), {
    status,
    filesChanged: body.filesChanged ?? null,
    diffSummary: body.diffSummary ?? null,
    error: body.error ?? null,
  });
  res.json({ ok: true });
}));
