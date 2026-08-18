// Work surface API — the agentic loop's single front door.
//
//   /api/work/jobs        queue: enqueue, list, review, cancel, live stream
//   /api/work/findings    what scheduled sweeps noticed; promote → job
//   /api/work/proposals   agent-proposed graph writes; approve → applied
//   /api/work/summary     one call for the overview header
//
// Mounted at /api/work in index.ts.

import { Router } from 'express';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { requireAction } from '../lib/authz.js';
import { initSSE, writeSSE, endSSE } from '../lib/sse.js';
import {
  enqueueJob, listJobs, getJob, reviewJob, cancelJob, queueStats,
} from '../providers/agent-jobs.js';
import {
  runSweep, runAllSweeps, listFindings, setFindingStatus, getFinding, findingStats,
  remediationFor, reopenFindingForJob, releaseAbandonedFindings, SWEEP_NAMES, type SweepName,
} from '../providers/org-sweeps.js';
import {
  listProposals, decideProposal, proposeGraphChange, proposalStats,
} from '../providers/graph-proposals.js';
import { dispatcherEvents, dispatchOnce, busyBoxes } from '../lib/job-dispatcher.js';

export const workRouter = Router();

// ─── Summary ─────────────────────────────────────────────────────────────────

workRouter.get('/summary', asyncHandler(async (_req, res) => {
  const [jobs, proposals, findings] = await Promise.all([
    queueStats(),
    proposalStats(),
    listFindings({ status: 'open', limit: 300 }),
  ]);
  res.json({
    jobs,
    proposals,
    findings: {
      open: findings.length,
      critical: findings.filter((f) => f.severity === 'critical').length,
      warning: findings.filter((f) => f.severity === 'warning').length,
    },
    busyBoxes: busyBoxes(),
    sweeps: SWEEP_NAMES,
  });
}));

// ─── Jobs ────────────────────────────────────────────────────────────────────

workRouter.get('/jobs', asyncHandler(async (req, res) => {
  const status = typeof req.query['status'] === 'string' ? req.query['status'] : undefined;
  const limit = parseInt((req.query['limit'] as string) ?? '50', 10);
  res.json({ jobs: await listJobs({ ...(status ? { status } : {}), limit }) });
}));

workRouter.get('/jobs/:id', asyncHandler(async (req, res) => {
  const job = await getJob(String(req.params['id'] ?? ''));
  if (!job) { res.status(404).json({ error: 'job not found' }); return; }
  res.json(job);
}));

workRouter.post('/jobs', requireAction('ManageDevbox'), asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as {
    title?: string; prompt?: string; kind?: string; priority?: number;
    requiresReview?: boolean; findingId?: string;
  };
  const title = (body.title ?? '').trim();
  const prompt = (body.prompt ?? '').trim();
  if (!title) throw new ValidationError('title is required');
  if (!prompt) throw new ValidationError('prompt is required — it is what the worker runs');

  const job = await enqueueJob({
    kind: body.kind ?? 'devbox:task',
    title,
    payload: { prompt, requiresReview: body.requiresReview !== false },
    ...(body.priority !== undefined ? { priority: body.priority } : {}),
    createdBy: (req as { session?: { sub?: string } }).session?.sub ?? 'portal',
  });
  if (!job) { res.status(503).json({ error: 'queue unavailable (Aurora mocked or unreachable)' }); return; }

  // Promoting a finding records the link both ways so the finding stops
  // showing as open work and the job carries its provenance.
  if (body.findingId) await setFindingStatus(body.findingId, 'promoted', job.id);

  res.status(201).json(job);
}));

workRouter.post('/jobs/:id/review', requireAction('ManageDevbox'), asyncHandler(async (req, res) => {
  const { decision, note } = (req.body ?? {}) as { decision?: string; note?: string };
  if (decision !== 'accept' && decision !== 'reject') {
    throw new ValidationError("decision must be 'accept' or 'reject'");
  }
  const job = await reviewJob(String(req.params['id'] ?? ''), decision, note);
  if (!job) { res.status(404).json({ error: 'job not found or not awaiting review' }); return; }
  // Rejecting says the work did not solve it, so the finding goes back on the
  // board rather than staying pinned to output a human refused.
  if (decision === 'reject') await reopenFindingForJob(job.id);
  res.json(job);
}));

workRouter.delete('/jobs/:id', requireAction('ManageDevbox'), asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  const ok = await cancelJob(id);
  if (!ok) { res.status(409).json({ error: 'job is not cancellable (already running or finished)' }); return; }
  const reopened = await reopenFindingForJob(id);
  res.json({ cancelled: true, reopenedFindings: reopened });
}));

/** Kick a dispatch pass now instead of waiting for the next tick. */
workRouter.post('/dispatch', requireAction('ManageDevbox'), asyncHandler(async (_req, res) => {
  await dispatchOnce();
  res.json({ ok: true, stats: await queueStats() });
}));

/** Live queue activity — claim/running/done events as they happen. */
workRouter.get('/events', (req, res) => {
  initSSE(res);
  const onJob = (ev: unknown) => writeSSE(res, ev as Record<string, unknown>);
  dispatcherEvents.on('job', onJob);
  req.on('close', () => { dispatcherEvents.off('job', onJob); endSSE(res); });
});

// ─── Findings ────────────────────────────────────────────────────────────────

workRouter.get('/findings', asyncHandler(async (req, res) => {
  const status = typeof req.query['status'] === 'string' ? req.query['status'] : 'open';
  const sweep = typeof req.query['sweep'] === 'string' ? req.query['sweep'] : undefined;
  const limit = parseInt((req.query['limit'] as string) ?? '100', 10);
  res.json({ findings: await listFindings({ status, ...(sweep ? { sweep } : {}), limit }) });
}));

workRouter.post('/sweeps/run', requireAction('ManageDevbox'), asyncHandler(async (req, res) => {
  const name = (req.body ?? {} as { sweep?: string }).sweep as SweepName | undefined;
  if (name && !SWEEP_NAMES.includes(name)) {
    throw new ValidationError(`unknown sweep '${name}' — expected one of ${SWEEP_NAMES.join(', ')}`);
  }
  // A single-sweep run gets the same self-heal pass runAllSweeps does, so
  // "Run sweeps now" always means the same thing whichever path it takes.
  if (name) {
    const released = await releaseAbandonedFindings();
    res.json({ results: [await runSweep(name)], released });
    return;
  }
  res.json(await runAllSweeps());
}));

/**
 * Put a worker on a finding.
 *
 * The remedy comes from the sweep that produced the finding, not from the
 * caller — a client cannot dictate what the agent is told to do, and a new
 * sweep ships its own remediation with it. The caller may override priority
 * (an operator escalating something) but not the instructions.
 */
workRouter.post('/findings/:id/promote', requireAction('ManageDevbox'), asyncHandler(async (req, res) => {
  const finding = await getFinding(String(req.params['id'] ?? ''));
  if (!finding) { res.status(404).json({ error: 'finding not found' }); return; }
  if (finding.jobId && finding.status === 'promoted') {
    res.status(409).json({ error: 'finding already has a worker on it', jobId: finding.jobId });
    return;
  }

  const remedy = remediationFor(finding);
  const override = (req.body ?? {}) as { priority?: number };

  const job = await enqueueJob({
    kind: 'devbox:task',
    title: `Mitigate: ${finding.title}`,
    payload: { prompt: remedy.prompt, requiresReview: true, findingId: finding.id },
    priority: override.priority ?? remedy.priority,
    createdBy: (req as { session?: { sub?: string } }).session?.sub ?? 'portal',
  });
  if (!job) { res.status(503).json({ error: 'queue unavailable (Aurora mocked or unreachable)' }); return; }

  await setFindingStatus(finding.id, 'promoted', job.id);
  res.status(201).json(job);
}));

/** Counts by sweep/status/severity so the UI can group instead of listing 44 near-identical rows. */
workRouter.get('/findings/stats', asyncHandler(async (_req, res) => {
  res.json({ stats: await findingStats() });
}));

workRouter.post('/findings/:id/dismiss', requireAction('ManageDevbox'), asyncHandler(async (req, res) => {
  const ok = await setFindingStatus(String(req.params['id'] ?? ''), 'dismissed');
  if (!ok) { res.status(404).json({ error: 'finding not found' }); return; }
  res.json({ dismissed: true });
}));

// ─── Graph proposals ─────────────────────────────────────────────────────────

workRouter.get('/proposals', asyncHandler(async (req, res) => {
  const status = typeof req.query['status'] === 'string' ? req.query['status'] : undefined;
  res.json({ proposals: await listProposals({ ...(status ? { status } : {}) }) });
}));

workRouter.post('/proposals', requireAction('ManageDevbox'), asyncHandler(async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const kind = String(b['kind'] ?? '');
  const targetId = String(b['targetId'] ?? '');
  if (!kind || !targetId) throw new ValidationError('kind and targetId are required');
  const proposal = await proposeGraphChange({
    source: String(b['source'] ?? 'portal'),
    kind: kind as Parameters<typeof proposeGraphChange>[0]['kind'],
    targetType: String(b['targetType'] ?? 'person'),
    targetId,
    payload: (b['payload'] ?? {}) as Record<string, unknown>,
    ...(b['rationale'] ? { rationale: String(b['rationale']) } : {}),
    ...(b['evidence'] ? { evidence: b['evidence'] as Record<string, unknown> } : {}),
    ...(b['confidence'] !== undefined ? { confidence: Number(b['confidence']) } : {}),
    ...(b['jobId'] ? { jobId: String(b['jobId']) } : {}),
    ...(b['findingId'] ? { findingId: String(b['findingId']) } : {}),
  });
  if (!proposal) { res.status(503).json({ error: 'proposals unavailable (Aurora mocked or unreachable)' }); return; }
  res.status(201).json(proposal);
}));

workRouter.post('/proposals/:id/decide', requireAction('ManageDevbox'), asyncHandler(async (req, res) => {
  const { decision, note } = (req.body ?? {}) as { decision?: string; note?: string };
  if (decision !== 'approve' && decision !== 'reject') {
    throw new ValidationError("decision must be 'approve' or 'reject'");
  }
  const reviewer = (req as { session?: { sub?: string } }).session?.sub ?? 'portal';
  const proposal = await decideProposal(String(req.params['id'] ?? ''), decision, { reviewer, ...(note ? { note } : {}) });
  if (!proposal) { res.status(404).json({ error: 'proposal not found or already decided' }); return; }
  res.json(proposal);
}));
