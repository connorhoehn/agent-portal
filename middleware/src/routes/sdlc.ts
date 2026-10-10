// AI SDLC governance — /api/sdlc
//
// The surface for code an agent wrote: the change requests it produced, the
// reviews and gates each passed, the human decisions on the ones that needed
// one, and the policies that decide all of it. Gated as a devbox-management
// action, because approving and delivering agent-written code is the same
// class of authority as running the agents in the first place.

import { Router } from 'express';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import {
  listPolicies, upsertPolicy, deletePolicy, seedDefaultPolicies,
  listChangeRequests, getChangeRequest, decideChange, evaluateChange,
  recordReview, markInReview,
} from '../providers/sdlc.js';
import { reviewDiff } from '../lib/change-reviewer.js';
import { deliverApprovedChange, dispatchGovernedRun } from '../lib/sdlc-pipeline.js';
import { getAgentProject, checkoutPath } from '../providers/agent-projects.js';
import { resolveDevboxArn, devboxDataClient } from '../lib/devbox-arn.js';
import type { PolicyKind, PolicyAction } from '../lib/sdlc-policy.js';

export const sdlcRouter: Router = Router();

// ─── Policies ─────────────────────────────────────────────────────────────────

// A silent clamp, kept out of `listPolicies()` itself: `evaluateChange` also
// calls that provider function with no args, and governance evaluation must
// see EVERY policy — capping it there would silently stop enforcing rules
// past the cut rather than just shortening a list on a page. The limit lives
// here, on the read-only listing this route ships, instead.
function clampPoliciesLimit(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : 200;
}

sdlcRouter.get('/policies', asyncHandler(async (req, res) => {
  // Seed defaults on first read, so a fresh environment is governed rather than
  // wide open the moment this surface is opened.
  await seedDefaultPolicies().catch(() => { /* seeding is best-effort; listing still works */ });
  const limit = clampPoliciesLimit(req.query['limit']);
  res.json({ policies: (await listPolicies()).slice(0, limit) });
}));

sdlcRouter.post('/policies', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as {
    id?: string; name?: string; enabled?: boolean; kind?: string;
    config?: Record<string, unknown>; action?: string;
  };
  if (!body.name?.trim()) throw new ValidationError('name is required');
  const validKinds: PolicyKind[] = ['require_review', 'protected_paths', 'max_files', 'model_allowlist', 'max_cost'];
  if (!validKinds.includes(body.kind as PolicyKind)) {
    throw new ValidationError(`kind must be one of: ${validKinds.join(', ')}`);
  }
  const policy = await upsertPolicy({
    ...(body.id ? { id: body.id } : {}),
    name: body.name.trim(),
    enabled: body.enabled !== false,
    kind: body.kind as PolicyKind,
    config: body.config ?? {},
    action: (body.action === 'block' ? 'block' : 'require_approval') as PolicyAction,
  });
  res.status(201).json({ policy });
}));

sdlcRouter.delete('/policies/:id', asyncHandler(async (req, res) => {
  const ok = await deletePolicy(String(req.params['id'] ?? ''));
  if (!ok) throw new NotFoundError('No such policy');
  res.json({ ok: true });
}));

// ─── Change requests ────────────────────────────────────────────────────────

sdlcRouter.get('/changes', asyncHandler(async (req, res) => {
  const projectId = req.query['projectId'] ? String(req.query['projectId']) : undefined;
  const open = req.query['open'] === 'true';
  res.json({
    changes: await listChangeRequests({ ...(projectId ? { projectId } : {}), ...(open ? { open } : {}) }),
  });
}));

sdlcRouter.get('/changes/:id', asyncHandler(async (req, res) => {
  const change = await getChangeRequest(String(req.params['id'] ?? ''));
  if (!change) throw new NotFoundError('No such change request');
  res.json({ change });
}));

// ── Human decision on a change that needs approval ──────────────────────────

sdlcRouter.post('/changes/:id/decide', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as { decision?: string; note?: string };
  if (body.decision !== 'approve' && body.decision !== 'reject') {
    throw new ValidationError('decision must be approve or reject');
  }
  const out = await decideChange(String(req.params['id'] ?? ''), body.decision, {
    by: req.session?.sub ?? null,
    note: body.note ?? null,
  });
  if (!out.ok) throw new ValidationError(out.error ?? 'could not decide');
  // An approval left the queue (pipelines activity graph, content-free hint). Loaded lazily: the graph is a reader of this route, not its dependency.
  void import('../lib/work-graph/live.js').then(m => m.notifyPipelinesWorkGraphChanged(null, 'approval')).catch(() => undefined);
  res.json({ ok: true, status: out.status });
}));

// ── Re-run the reviewer and gates ───────────────────────────────────────────
//
// For a change that came back changes_requested or failed and someone wants a
// fresh judgment without a new agent run — the diff is already captured.

sdlcRouter.post('/changes/:id/rereview', asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  const change = await getChangeRequest(id);
  if (!change) throw new NotFoundError('No such change request');
  if (!change.diff) throw new ValidationError('This change has no stored diff to review.');

  await markInReview(id);
  const review = await reviewDiff({
    title: change.title, diff: change.diff, truncated: change.diffTruncated, taskPrompt: null,
  });
  await recordReview({
    changeId: id, model: review.model, verdict: review.verdict,
    summary: review.summary, findings: review.findings,
  });
  const evaluated = await evaluateChange(id);
  res.json({ ok: true, verdict: review.verdict, status: evaluated?.status });
}));

// ── Address a review — loop the feedback back to an agent ───────────────────
//
// The closing move of the SDLC loop: instead of a human hand-fixing what the
// reviewer flagged, dispatch a fresh agent run with the findings as its task.
// That run changes the code, which is captured and reviewed again — the review
// is not a dead end but a step that feeds the next iteration. Work performed by
// agents, governed each time round.

sdlcRouter.post('/changes/:id/address', asyncHandler(async (req, res) => {
  const change = await getChangeRequest(String(req.params['id'] ?? ''));
  if (!change) throw new NotFoundError('No such change request');

  const review = change.reviews[0];
  if (!review || review.verdict === 'approve') {
    throw new ValidationError('There is no review feedback to address on this change.');
  }

  const project = await getAgentProject(change.projectId);
  if (!project) throw new NotFoundError('The change\'s project no longer exists');
  if (!project.sessionId) {
    throw new ValidationError('This project has no live workspace — re-clone it before addressing the review.');
  }

  // Build the task from the reviewer's own words, so the agent is fixing the
  // stated objections rather than guessing what "changes requested" meant.
  const findings = review.findings.map((f) => `- ${f.file ? `${f.file}${f.line ? `:${f.line}` : ''}: ` : ''}${f.note}`).join('\n');
  const prompt = [
    `A reviewer asked for changes to your last edit of this repository, titled "${change.title}".`,
    review.summary ? `Reviewer summary: ${review.summary}` : '',
    findings ? `Specific points to address:\n${findings}` : '',
    'Apply the requested changes. Do not revert your earlier work unless a point explicitly asks you to.',
  ].filter(Boolean).join('\n\n');

  const started = await dispatchGovernedRun({
    project, prompt, model: (req.body as { model?: string })?.model ?? null, sessionId: project.sessionId,
  });
  if (!started.ok) { res.status(503).json({ error: started.error }); return; }
  res.status(202).json({ ok: true, runId: started.runId });
}));

// ── Deliver an approved change ──────────────────────────────────────────────

sdlcRouter.post('/changes/:id/deliver', asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  const change = await getChangeRequest(id);
  if (!change) throw new NotFoundError('No such change request');

  const project = await getAgentProject(change.projectId);
  if (!project) throw new NotFoundError('The change\'s project no longer exists');

  const arn = await resolveDevboxArn();
  if (!arn) { res.status(503).json({ error: 'the devbox runtime is not deployed' }); return; }

  const out = await deliverApprovedChange({
    client: devboxDataClient(),
    runtimeArn: arn,
    changeId: id,
    project: {
      sessionId: project.sessionId,
      checkout: checkoutPath(project),
      repoFullName: project.repoFullName,
      defaultBranch: project.defaultBranch,
      connectionName: project.connectionName,
    },
  });
  if (!out.ok) { res.status(409).json({ error: out.error }); return; }
  res.json({ ok: true, prUrl: out.prUrl });
}));
