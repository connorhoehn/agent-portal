// Environments — /api/environments
//
// Where an initiative's code runs, and who may get inside it.
//
// The surface is split three ways on purpose:
//
//   READ is wide. An environment row names an account, a region, a cluster and
//   an IAM role — a map, not a key. Any signed-in member of the tenant may see
//   it, because hiding the map from the people working on the initiative buys
//   no security and costs them the ability to reason about their own system.
//
//   MUTATION is narrow (ManageEnvironments). Editing the record is how the org
//   states what exists; a wrong row misdirects whoever reads it next.
//
//   ACCESS is narrower still and is NOT a mutation (EnterEnvironment). It is
//   the one question that depends on the specific environment, so it is the one
//   route that cannot ride the router's read gate — see the handler.
//
// What is deliberately absent: anything that changes an environment. No
// deploy, no restart, no scale, no promote. The linked repositories have
// GitHub Actions doing that already, and GET /:id/runs REPORTS those runs —
// read-only, no dispatch, no re-run, no webhook. A second CI system arguing
// with the real one about what shipped is worse than no CI system here at all.

import { Router } from 'express';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import {
  readForRolesElseAction, requireAction, requireSession, resolveSession,
  isAllowed, environmentAttrs,
} from '../lib/authz.js';
import { logAuthz, eventFromSession } from '../lib/audit.js';
import {
  listEnvironments, getEnvironment, createEnvironment, updateEnvironment,
  deleteEnvironment, repoForInitiative,
  ENVIRONMENT_KINDS, ENVIRONMENT_STATUSES, type EnvironmentInput,
} from '../providers/environments.js';
import { listWorkflowRuns } from '../lib/github-connector.js';

export const environmentsRouter: Router = Router();

// Every tenant role may read; anything else needs ManageEnvironments. Listing
// the roles explicitly rather than using a bare requireSession keeps the write
// fallthrough on one gate, so a mutation can never reach a handler ungated.
const readGate = readForRolesElseAction(
  ['member', 'sme', 'org-leader', 'hr-admin'],
  'ManageEnvironments',
);
const writeGate = requireAction('ManageEnvironments');

const ACCOUNT_RE = /^\d{12}$/;
const REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const ROLE_ARN_RE = /^arn:aws[a-z-]*:iam::\d{12}:role\/.+$/;

function assertShape(body: Record<string, unknown>, partial: boolean): void {
  const kind = body['kind'];
  if (kind !== undefined && !ENVIRONMENT_KINDS.includes(String(kind) as never)) {
    throw new ValidationError(`kind must be one of ${ENVIRONMENT_KINDS.join(', ')}`);
  }
  const status = body['status'];
  if (status !== undefined && !ENVIRONMENT_STATUSES.includes(String(status) as never)) {
    throw new ValidationError(`status must be one of ${ENVIRONMENT_STATUSES.join(', ')}`);
  }
  const account = body['awsAccountId'];
  if ((account !== undefined || !partial) && !ACCOUNT_RE.test(String(account ?? ''))) {
    throw new ValidationError('awsAccountId must be a 12-digit AWS account id');
  }
  const region = body['awsRegion'];
  if (region !== undefined && !REGION_RE.test(String(region))) {
    throw new ValidationError('awsRegion must look like us-east-1');
  }
  // Validated because a malformed role ARN fails at assume-time, in a devbox,
  // in front of whoever was trying to get into a cluster — far from the typo.
  // Null is allowed and means "not wired for access yet".
  const role = body['accessRoleArn'];
  if (role !== undefined && role !== null && !ROLE_ARN_RE.test(String(role))) {
    throw new ValidationError('accessRoleArn must be an IAM role ARN');
  }
}

environmentsRouter.get('/', readGate, asyncHandler(async (req, res) => {
  const orgProjectId = req.query['orgProjectId'];
  const environments = await listEnvironments(
    typeof orgProjectId === 'string' && orgProjectId ? orgProjectId : null,
  );
  res.json({ environments });
}));

environmentsRouter.get('/:id', readGate, asyncHandler(async (req, res) => {
  const env = await getEnvironment(String(req.params['id'] ?? ''));
  if (!env) throw new NotFoundError('No such environment');
  res.json({ environment: env });
}));

/**
 * "May I reach this environment, and how?"
 *
 * The one route that asks Cedar about a SPECIFIC environment rather than about
 * the router. It cannot use `readGate`: that gate fast-paths any GET from a
 * tenant role straight past Cedar, which is right for reading the record and
 * catastrophically wrong here — a member would be told yes. So this takes only
 * a session floor and then evaluates EnterEnvironment itself, passing the
 * environment's properties as resource attributes (lib/authz.ts
 * environmentAttrs explains why properties and not identity).
 *
 * A denial is a 200 with `allowed: false`, not a 403. The caller is asking a
 * question, not attempting the thing — an SME opening an environment they
 * can't enter should see it greyed out with a reason, not an error toast. The
 * decision is still audit-logged either way, because "who asked whether they
 * could reach prod" is worth knowing.
 *
 * On allow it returns `accessRoleArn` — the role a devbox assumes to get in.
 * That is a role NAME, and returning it grants nothing on its own: STS still
 * has to allow the devbox's identity to assume it. Two independent gates.
 */
environmentsRouter.get('/:id/access', requireSession('EnterEnvironment'), asyncHandler(async (req, res) => {
  const env = await getEnvironment(String(req.params['id'] ?? ''));
  if (!env) throw new NotFoundError('No such environment');

  const session = resolveSession(req);
  if (!session) throw new NotFoundError('No such environment');

  const allowed = await isAllowed(session, 'EnterEnvironment', environmentAttrs(env));
  logAuthz(eventFromSession(session, 'EnterEnvironment', allowed ? 'ALLOW' : 'DENY', {
    path: req.path,
    reason: `${env.orgProjectId}/${env.name}`,
  }));

  if (!allowed) {
    res.json({
      allowed: false,
      environmentId: env.id,
      reason: env.status === 'retired'
        ? 'This environment is retired — it is recorded for history, not for access.'
        : `The ${session.role} role cannot reach environments.`,
    });
    return;
  }

  if (!env.accessRoleArn) {
    // Authorized, but there is nothing to assume. Distinguished from a denial
    // because the remedy is completely different: describe the role, don't
    // change anybody's permissions.
    res.json({
      allowed: true,
      environmentId: env.id,
      accessRoleArn: null,
      reason: 'No access role is recorded for this environment yet.',
    });
    return;
  }

  res.json({
    allowed: true,
    environmentId: env.id,
    accessRoleArn: env.accessRoleArn,
    awsAccountId: env.awsAccountId,
    awsRegion: env.awsRegion,
    clusterName: env.clusterName,
    namespace: env.namespace,
  });
}));

/**
 * The latest GitHub Actions runs for the repository that delivers this
 * environment's initiative. Reporting only — see the file header.
 *
 * Errors from GitHub are reported as an empty list, not a 5xx: a missing
 * credential or a repo with no Actions is an ordinary state of the world, and
 * failing the whole environment view over it would be a worse answer than "no
 * runs to show, here's why".
 *
 * But an empty list is only half an answer, and for a long time it was the
 * only half. Every outcome below — no repository, no history, GitHub
 * unreachable — came back as `{ runs: [] }` with a `note` that was sometimes a
 * fact about the org and sometimes an exception message, so a reader could not
 * tell a broken integration from an idle repository and neither could any
 * check we have: the wire capture recorded a cheerful `200` for the failure
 * too. `degraded` is the fix, borrowed verbatim from routes/cost.ts, which
 * lost the same distinction between "no spend in this window" and "the
 * database is gone" and rendered $0.0000 for both.
 *
 * Four distinguishable answers, and the marker appears on exactly one:
 *
 *   { runs: [], repo: null, note }             nothing is linked — a fact
 *   { runs: [], repo, note }                   linked, no history — a fact
 *   { runs: [...], repo }                      history
 *   { runs: [], repo, degraded: true, error }  we could not ask
 *
 * The upstream being unreachable is a STATED degraded state, never an empty
 * list, and never a 500 in a reader's face either.
 */
environmentsRouter.get('/:id/runs', readGate, asyncHandler(async (req, res) => {
  const env = await getEnvironment(String(req.params['id'] ?? ''));
  if (!env) throw new NotFoundError('No such environment');

  const repo = await repoForInitiative(env.orgProjectId);
  if (!repo) {
    res.json({ runs: [], repo: null, note: 'No repository is linked to this initiative.' });
    return;
  }

  const limitRaw = Number(req.query['limit'] ?? 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 10;

  try {
    const runs = await listWorkflowRuns(repo.repoFullName, limit, {
      connectionName: repo.connectionName,
    });
    if (runs.length === 0) {
      // Said out loud rather than left to inference, because the shape of this
      // response is otherwise byte-identical to the degraded one above it.
      res.json({
        runs: [], repo: repo.repoFullName,
        note: `${repo.repoFullName} has no workflow runs to report.`,
      });
      return;
    }
    res.json({ runs, repo: repo.repoFullName });
  } catch (err) {
    // First line only, so a multi-line upstream error stays a label — same
    // trim as cost.ts, for the same reason.
    const error = (err as Error).message.split('\n')[0]?.slice(0, 160) ?? 'workflow runs unavailable';
    console.warn(`[environments] workflow runs for ${repo.repoFullName} failed:`, error);
    res.json({ runs: [], repo: repo.repoFullName, degraded: true, error });
  }
}));

environmentsRouter.post('/', writeGate, asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const orgProjectId = String(body['orgProjectId'] ?? '').trim();
  const name = String(body['name'] ?? '').trim();
  if (!orgProjectId) throw new ValidationError('orgProjectId is required');
  if (!name) throw new ValidationError('name is required');
  assertShape(body, false);

  const input: EnvironmentInput = {
    orgProjectId,
    name,
    awsAccountId: String(body['awsAccountId']),
    ...(body['kind'] !== undefined ? { kind: String(body['kind']) } : {}),
    ...(body['awsRegion'] !== undefined ? { awsRegion: String(body['awsRegion']) } : {}),
    ...(body['status'] !== undefined ? { status: String(body['status']) } : {}),
    clusterName: body['clusterName'] == null ? null : String(body['clusterName']),
    clusterArn: body['clusterArn'] == null ? null : String(body['clusterArn']),
    namespace: body['namespace'] == null ? null : String(body['namespace']),
    accessRoleArn: body['accessRoleArn'] == null ? null : String(body['accessRoleArn']),
    ...(typeof body['rank'] === 'number' ? { rank: body['rank'] } : {}),
  };
  res.status(201).json({ environment: await createEnvironment(input) });
}));

environmentsRouter.patch('/:id', writeGate, asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  assertShape(body, true);

  // Only keys actually present are forwarded — the provider distinguishes
  // "absent" (leave alone) from "null" (clear), and collapsing the two here
  // would let a partial edit silently revoke an environment's access role.
  const patch: Partial<Omit<EnvironmentInput, 'orgProjectId'>> = {};
  if (body['name'] !== undefined) patch.name = String(body['name']);
  if (body['kind'] !== undefined) patch.kind = String(body['kind']);
  if (body['awsAccountId'] !== undefined) patch.awsAccountId = String(body['awsAccountId']);
  if (body['awsRegion'] !== undefined) patch.awsRegion = String(body['awsRegion']);
  if (body['status'] !== undefined) patch.status = String(body['status']);
  if (typeof body['rank'] === 'number') patch.rank = body['rank'];
  for (const key of ['clusterName', 'clusterArn', 'namespace', 'accessRoleArn'] as const) {
    if (body[key] !== undefined) patch[key] = body[key] == null ? null : String(body[key]);
  }

  const env = await updateEnvironment(String(req.params['id'] ?? ''), patch);
  if (!env) throw new NotFoundError('No such environment');
  res.json({ environment: env });
}));

environmentsRouter.delete('/:id', writeGate, asyncHandler(async (req, res) => {
  const ok = await deleteEnvironment(String(req.params['id'] ?? ''));
  if (!ok) throw new NotFoundError('No such environment');
  res.json({ ok: true });
}));
