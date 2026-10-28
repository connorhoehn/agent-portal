// AI SDLC governance — /api/sdlc
//
// The surface for code an agent wrote: the change requests it produced, the
// reviews and gates each passed, the human decisions on the ones that needed
// one, and the policies that decide all of it. Each route carries its own
// Cedar action (DE-42); separation of duties (DE-43) and versioned policy
// sets (DE-46) are enforced here and in lib/sdlc-policy-governance.ts.

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { requireInitiativeScope } from '../lib/initiative-scope.js';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import {
  listChangeRequests, getChangeRequest, decideChange, evaluateChange,
  recordReview, markInReview, listEvaluations,
} from '../providers/sdlc.js';
import {
  listPolicySetVersions, getPolicySetVersion, listPolicyProposals, ORG_SCOPE,
} from '../providers/sdlc-policy-sets.js';
import {
  submitPolicySet, decidePolicyProposal, effectivePolicySet, parsePolicySet, type PolicyWriteOutcome,
} from '../lib/sdlc-policy-governance.js';
import { reviewDiff } from '../lib/change-reviewer.js';
import { deliverApprovedChange, dispatchGovernedRun } from '../lib/sdlc-pipeline.js';
import { getAgentProject, checkoutPath } from '../providers/agent-projects.js';
import { resolveDevboxArn, devboxDataClient } from '../lib/devbox-arn.js';
import { requireAction, readForRolesElseAction, resolveSession, isAllowed } from '../lib/authz.js';
import { authorizeAgentAction } from '../lib/agent-actions.js';
import { logAuthz } from '../lib/audit.js';
import { normalizePolicy, withPolicy, withoutPolicy } from '../lib/sdlc-policy.js';
import type { Session } from '../lib/session.js';

export const sdlcRouter: Router = Router();

// Each route carries its own action (DE-42); the mount (index.ts) is only
// the floor, tenant scope plus a real session. Reads stay with the
// ManageDevbox holders who could read before the split.
const readGate = requireAction('ManageDevbox');

/** The session, or a 401 answered. No session never decides anything (DE-43). */
function sessionOr401(req: Request, res: Response): Session | null {
  const session = resolveSession(req);
  if (!session) res.status(401).json({ error: 'Unauthenticated', code: 'SESSION_INVALID' });
  return session;
}

/** A policy write's outcome on the wire: 201 applied, 202 pending a second person, 409 conflict. */
function answerPolicyWrite(res: Response, out: PolicyWriteOutcome | { kind: 'rejected' }, applied: (v: Extract<PolicyWriteOutcome, { kind: 'applied' }>) => unknown): void {
  switch (out.kind) {
    case 'applied': res.status(201).json(applied(out)); return;
    case 'pending':
      res.status(202).json({
        pending: true, proposal: out.proposal,
        message: 'This edit loosens governance, so it waits for a second person to approve it.',
      });
      return;
    case 'conflict':
      res.status(409).json({ error: 'the policy set changed since you loaded it', gate: 'stale-base', currentVersion: out.currentVersion });
      return;
    case 'refused':
      res.status(out.status).json({ error: out.error, ...(out.gate ? { gate: out.gate } : {}), ...(out.code ? { code: out.code } : {}) });
      return;
    default:
      res.status(200).json({ ok: true, status: 'rejected' });
  }
}

/**
 * EditSdlcPolicy (DE-42). Whether the caller is on the scope's initiative, or
 * org-wide for `org`, is the governance lib's question (submitPolicySet), so
 * Cedar is asked with the probe's attributes here.
 */
async function editGate(req: Request, res: Response): Promise<Session | null> {
  const session = sessionOr401(req, res);
  if (!session) return null;
  return await authorizeAgentAction(req, res, 'EditSdlcPolicy', { onInitiative: true }) ? session : null;
}

// ─── Policies (legacy single-policy surface) ──────────────────────────────────
//
// Kept for one release beside the versioned sets (DE-46 accept-both): each
// edit here is a whole new version of the `org` set, through the same rules
// as PUT /policy-sets/org. They answer 410 once the portal is on the sets.

function clampPoliciesLimit(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : 200;
}

sdlcRouter.get('/policies', readGate, asyncHandler(async (req, res) => {
  // The org set's current version — bootstrapped once, so a fresh environment
  // is governed rather than wide open the moment this surface is opened.
  const { effective } = await effectivePolicySet(ORG_SCOPE);
  const limit = clampPoliciesLimit(req.query['limit']);
  res.json({ policies: effective.policies.slice(0, limit), scope: effective.scope, version: effective.version });
}));

sdlcRouter.post('/policies', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as {
    id?: string; name?: string; enabled?: boolean; kind?: string;
    config?: Record<string, unknown>; action?: string; reason?: string; override?: boolean;
  };
  if (!body.name?.trim()) throw new ValidationError('name is required');
  const policy = normalizePolicy({ ...body, id: body.id?.trim() || randomUUID() });
  if (typeof policy === 'string') throw new ValidationError(policy.replace(/^policy \S+: /, ''));
  const session = await editGate(req, res);
  if (!session) return;
  const { own } = await effectivePolicySet(ORG_SCOPE);
  const out = await submitPolicySet({
    session, scope: ORG_SCOPE, policies: withPolicy(own!.policies, policy), baseVersion: own!.version,
    reason: body.reason?.trim() || `Edited "${policy.name}" (POST /api/sdlc/policies)`,
    ...(body.override === true ? { override: true } : {}),
  });
  answerPolicyWrite(res, out, () => ({ policy }));
}));

sdlcRouter.delete('/policies/:id', asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  const session = await editGate(req, res);
  if (!session) return;
  const { own } = await effectivePolicySet(ORG_SCOPE);
  const target = own!.policies.find((p) => p.id === id);
  if (!target) throw new NotFoundError('No such policy');
  const next = withoutPolicy(own!.policies, id);
  const invalid = parsePolicySet(next);
  if (typeof invalid === 'string') throw new ValidationError(invalid);
  const out = await submitPolicySet({
    session, scope: ORG_SCOPE, policies: next, baseVersion: own!.version,
    reason: String((req.body as { reason?: string } | undefined)?.reason ?? '').trim() || `Removed "${target.name}" (DELETE /api/sdlc/policies)`,
  });
  if (out.kind === 'applied') { res.json({ ok: true, version: out.version.version }); return; }
  answerPolicyWrite(res, out, () => ({}));
}));

// ─── Policy sets, versioned (DE-46) ───────────────────────────────────────────
//
// `scope` is `org` or an initiative id. A read of an initiative with no set of
// its own returns the org set it inherits (`inherited: true`).

sdlcRouter.get('/policy-sets/:scope', readGate, asyncHandler(async (req, res) => {
  const scope = String(req.params['scope'] ?? '');
  const { own, effective } = await effectivePolicySet(scope);
  res.json({ scope, inherited: own === null, set: effective });
}));

sdlcRouter.get('/policy-sets/:scope/versions', readGate, asyncHandler(async (req, res) => {
  const scope = String(req.params['scope'] ?? '');
  res.json({ scope, versions: await listPolicySetVersions(scope) });
}));

sdlcRouter.get('/policy-sets/:scope/versions/:version', readGate, asyncHandler(async (req, res) => {
  const v = await getPolicySetVersion(String(req.params['scope'] ?? ''), parseInt(String(req.params['version'] ?? ''), 10));
  if (!v) throw new NotFoundError('No such policy set version');
  res.json({ set: v });
}));

sdlcRouter.put('/policy-sets/:scope', asyncHandler(async (req, res) => {
  const scope = String(req.params['scope'] ?? '').trim();
  const body = (req.body ?? {}) as { policies?: unknown; baseVersion?: unknown; reason?: unknown; override?: unknown };
  const policies = parsePolicySet(body.policies);
  if (typeof policies === 'string') throw new ValidationError(policies);
  const baseVersion = Number(body.baseVersion);
  if (!Number.isInteger(baseVersion) || baseVersion < 0) throw new ValidationError('baseVersion must be the version you edited (0 for a new set)');
  if (typeof body.reason !== 'string' || !body.reason.trim()) throw new ValidationError('reason is required');
  if (!scope) throw new ValidationError('scope is required');
  const session = await editGate(req, res);
  if (!session) return;
  // stewardsInitiative is asked inside submitPolicySet for an initiative scope.
  const out = await submitPolicySet({
    session, scope, policies, baseVersion, reason: body.reason,
    ...(body.override === true ? { override: true } : {}),
  });
  answerPolicyWrite(res, out, (o) => ({ set: o.version }));
}));

// ─── Loosening proposals (DE-43 §4) ───────────────────────────────────────────

sdlcRouter.get('/policy-proposals', readForRolesElseAction(['org-leader'], 'ManageDevbox'), asyncHandler(async (req, res) => {
  const scope = req.query['scope'] ? String(req.query['scope']) : undefined;
  const status = req.query['status'] ? String(req.query['status']) : undefined;
  res.json({ proposals: await listPolicyProposals({ ...(scope ? { scope } : {}), ...(status ? { status } : {}) }) });
}));

sdlcRouter.post('/policy-proposals/:id/decide', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as { decision?: string; note?: string; override?: boolean };
  if (body.decision !== 'approve' && body.decision !== 'reject') throw new ValidationError('decision must be approve or reject');
  const session = sessionOr401(req, res);
  if (!session) return;
  // A second EditSdlcPolicy holder, or an org-leader (DE-43 §4).
  if (session.role !== 'org-leader' && !await isAllowed(session, 'EditSdlcPolicy', { onInitiative: true })) {
    res.status(403).json({ error: 'Forbidden', action: 'EditSdlcPolicy', role: session.role, tenant: session.tenant });
    return;
  }
  // stewardsInitiative is asked inside decidePolicyProposal for the proposal's scope.
  const out = await decidePolicyProposal({
    session, id: String(req.params['id'] ?? ''), decision: body.decision, note: body.note ?? null,
    ...(body.override === true ? { override: true } : {}),
  });
  if (out.kind === 'applied') { res.json({ ok: true, status: 'approved', set: out.version }); return; }
  answerPolicyWrite(res, out, () => ({}));
}));

// ─── Change requests ────────────────────────────────────────────────────────

sdlcRouter.get('/changes', readGate, asyncHandler(async (req, res) => {
  const projectId = req.query['projectId'] ? String(req.query['projectId']) : undefined;
  const open = req.query['open'] === 'true';
  res.json({
    changes: await listChangeRequests({ ...(projectId ? { projectId } : {}), ...(open ? { open } : {}) }),
  });
}));

sdlcRouter.get('/changes/:id', readGate, asyncHandler(async (req, res) => {
  const change = await getChangeRequest(String(req.params['id'] ?? ''));
  if (!change) throw new NotFoundError('No such change request');
  res.json({ change });
}));

/** Every evaluation of a change, each with the set version that judged it (DE-46). */
sdlcRouter.get('/changes/:id/evaluations', readGate, asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  const change = await getChangeRequest(id);
  if (!change) throw new NotFoundError('No such change request');
  res.json({ changeId: id, evaluations: await listEvaluations(id) });
}));

/** The initiative a change belongs to: its codebase's initiative (DE-44). */
async function changeInitiative(change: { projectId: string }): Promise<string | null> {
  return (await getAgentProject(change.projectId))?.orgProjectId ?? null;
}

// ── Human decision on a change that needs approval ──────────────────────────

sdlcRouter.post('/changes/:id/decide', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as { decision?: string; note?: string; override?: boolean };
  if (body.decision !== 'approve' && body.decision !== 'reject') {
    throw new ValidationError('decision must be approve or reject');
  }
  // No session means no decider, and a decision nobody made is not recorded
  // (DE-43): 401, never a null decided_by.
  const session = sessionOr401(req, res);
  if (!session) return;
  if (body.override === true && session.role !== 'admin') {
    throw new ValidationError('override is only available to admin');
  }
  const change = await getChangeRequest(String(req.params['id'] ?? ''));
  if (!change) throw new NotFoundError('No such change request');
  if (!await requireInitiativeScope(req, res, await changeInitiative(change), { action: 'decide changes' })) return;
  // Self-approval is refused before Cedar is asked, so both modes answer the
  // same 409 (production's forbid on isAuthor would otherwise make it a 403).
  const isAuthor = !!change.requestedBy && change.requestedBy === session.sub;
  const override = body.override === true && isAuthor;
  if (isAuthor && !override) {
    res.status(409).json({ error: 'you caused this change, so someone else must decide it', gate: 'self-approval', confirmFlag: 'override' });
    return;
  }
  if (!await authorizeAgentAction(req, res, 'DecideAgentChange', { onInitiative: true, isAuthor })) return;
  const out = await decideChange(String(req.params['id'] ?? ''), body.decision, {
    by: session.sub, role: session.role, note: body.note ?? null, override,
  });
  if (!out.ok && out.gate) { res.status(409).json({ error: out.error, gate: out.gate }); return; }
  if (!out.ok) throw new ValidationError(out.error ?? 'could not decide');
  if (override) {
    logAuthz({
      decision: 'ALLOW', action: 'DecideAgentChange.Override', sub: session.sub, role: session.role,
      tenant: session.tenant, path: req.path,
      reason: `admin override of a self-approval refusal on change ${change.id} (decision=${body.decision})`,
    });
  }
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
  if (!await requireInitiativeScope(req, res, await changeInitiative(change), { action: 're-review changes' })) return;
  if (!await authorizeAgentAction(req, res, 'RunDevboxTask', { onInitiative: true })) return;
  // `repin: true` judges the change under the latest policy set instead of
  // the one it was captured under (DE-46); the response says it did.
  const repin = (req.body as { repin?: unknown } | undefined)?.repin === true;

  await markInReview(id);
  const review = await reviewDiff({
    title: change.title, diff: change.diff, truncated: change.diffTruncated, taskPrompt: null,
  });
  await recordReview({
    changeId: id, model: review.model, verdict: review.verdict,
    summary: review.summary, findings: review.findings,
  });
  const evaluated = await evaluateChange(id, { repin });
  res.json({
    ok: true, verdict: review.verdict, status: evaluated?.status,
    policyScope: evaluated?.policyScope, policyVersion: evaluated?.policyVersion,
    evaluationSeq: evaluated?.evaluationSeq, repinned: evaluated?.repinned ?? false,
  });
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
  // Addressing dispatches a run that spends on the initiative.
  if (!await requireInitiativeScope(req, res, project.orgProjectId, { spend: true, action: 'address reviews' })) return;
  if (!await authorizeAgentAction(req, res, 'RunDevboxTask', { onInitiative: true })) return;
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
    // The re-run is a new change, requested by whoever pressed Address (DE-43).
    dispatchedBy: resolveSession(req)?.sub ?? null,
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
  // Delivery pushes to GitHub with the connection's token.
  if (!await requireInitiativeScope(req, res, project.orgProjectId, { action: 'deliver changes' })) return;
  if (!await authorizeAgentAction(req, res, 'DeliverAgentChange', { onInitiative: true })) return;

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
