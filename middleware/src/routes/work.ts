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
import { resolveSession, requireAction, requireSession } from '../lib/authz.js';
import { type Session } from '../lib/session.js';
import { getUser } from '../providers/identity.js';
import { searchWorkItems, getWorkItem } from '../providers/work-items.js';
import { stewardsInitiative } from '../lib/initiative-scope.js';
import { rankSuggestions, askSuggestionsFrom, seesEveryInitiative } from '../lib/work-suggestions.js';
import { initSSE, writeSSE, endSSE } from '../lib/sse.js';
import {
  enqueueJob, listJobs, getJob, reviewJob, cancelJob, queueStats,
  requeueJob,
} from '../providers/agent-jobs.js';
import {
  runSweep, runAllSweeps, listFindings, setFindingStatus, getFinding, findingStats,
  remediationFor, reopenFindingForJob, releaseAbandonedFindings, initiativeIdForFinding,
  SWEEP_NAMES, type SweepName,
} from '../providers/org-sweeps.js';
import { grantScopedDispatchVerdict } from '../lib/bot-runner.js';
import {
  listProposals, decideProposal, proposeGraphChange, proposalStats,
} from '../providers/graph-proposals.js';
import { dispatcherEvents, dispatchOnce, busyBoxes } from '../lib/job-dispatcher.js';
import { analyzeDocumentLinks, analyzeDocumentFindings } from '../providers/doc-linker.js';
import { listConsults } from '../providers/lab.js';
import { LOCAL_JOB_KINDS } from '../lib/local-work.js';

export const workRouter = Router();

/**
 * The kinds a person may put on the queue.
 *
 * `devbox:task` is the cloud fleet's kind and the default. The `local:*` kinds
 * are claimable ONLY by a paired workstation that registered for them, so
 * queueing one is a deliberate choice to spend a machine's own capacity instead
 * of an initiative's budget — which is why they are offered here rather than
 * being reachable only from a script. What is NOT offered is a free-form string:
 * see the note at the call site.
 */
const QUEUEABLE_KINDS: readonly string[] = ['devbox:task', ...LOCAL_JOB_KINDS];

// ─── Summary ─────────────────────────────────────────────────────────────────

workRouter.get('/summary', asyncHandler(async (_req, res) => {
  const [jobs, proposals, findings, pendingConsults] = await Promise.all([
    queueStats(),
    proposalStats(),
    listFindings({ status: 'open', limit: 300 }),
    // A waiting consult is a blocked AGENT — the most urgent kind of
    // "needs you" the queue has, since a computer is sitting on it.
    listConsults({ status: 'pending' }),
  ]);
  res.json({
    jobs,
    proposals,
    consults: { pending: pendingConsults.length },
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

/**
 * What agent work is worth suggesting to this person, right now.
 *
 * The composer below it takes a free-typed prompt, which is the right primitive
 * and a poor starting point: dispatching an agent meant facing an empty box and
 * already knowing what to type, with nothing on the page connecting it to your
 * initiatives or your sprint. These are two or three concrete things a computer
 * could do next, with the prompt already written — a way in, not a queue.
 *
 * Scoped like everything else: org-wide roles see the whole program, an `sme`
 * sees the initiatives they own or contribute to. Read-only and cheap, so it
 * sits behind the session floor rather than ManageDevbox — seeing what could be
 * done is not dispatching it, and the composer is already gated.
 */
/**
 * The scoped, ranked work for this caller — shared by /suggestions (dispatch
 * cards on Work) and /ask-suggestions (question cards on Ask). One query,
 * then filter in memory: the candidate set is the open work on a handful of
 * initiatives, and a per-initiative query would be N round trips to rank
 * four cards.
 */
async function rankedWorkFor(session: Session | null) {
  const personId = session?.sub ? (await getUser(session.sub))?.personId ?? null : null;
  const items = await searchWorkItems({ limit: 200 });

  let candidates = items;
  if (!seesEveryInitiative(session)) {
    const attached = new Set<string>();
    await Promise.all([...new Set(items.map((i) => i.projectId))].map(async (id) => {
      if (await stewardsInitiative(session, id)) attached.add(id);
    }));
    candidates = items.filter((i) => attached.has(i.projectId));
  }

  return rankSuggestions(
    candidates.map((i) => ({
      id: i.id,
      projectId: i.projectId,
      projectName: i.projectName,
      type: i.type,
      title: i.title,
      description: i.description,
      status: i.status,
      priority: i.priority,
      assigneeId: i.assigneeId,
      storyPoints: i.storyPoints,
      estimatedCostUsd: i.estimatedCostUsd ?? null,
      sprintId: i.sprintId ?? null,
      labels: i.labels ?? [],
    })),
    { personId },
  );
}

workRouter.get('/suggestions', requireSession('WorkSuggestions'), asyncHandler(async (req, res) => {
  res.json({ suggestions: await rankedWorkFor(req.session ?? null) });
}));

/**
 * The same ranked work, re-voiced as QUESTIONS for the Ask surface — "who can
 * unblock X?", not "go investigate X". Ask's empty state was four static demo
 * prompts connected to nothing the caller was doing; these come from their
 * own board. Same session floor as /suggestions: seeing what to ask is not
 * dispatching anything.
 */
workRouter.get('/ask-suggestions', requireSession('WorkSuggestions'), asyncHandler(async (req, res) => {
  res.json({ suggestions: askSuggestionsFrom(await rankedWorkFor(req.session ?? null)) });
}));

/** `sg-<workItemId>` — the only place that shape is known outside the ranker. */
function decodeSuggestionId(id: string): string | null {
  return id.startsWith('sg-') && id.length > 3 ? id.slice(3) : null;
}

/**
 * What this job is for, resolved from the board.
 *
 * Returns the payload fragment the queue row renders as its chip: the item,
 * its title, and the initiative it belongs to. The initiative comes from the
 * item rather than the request because the whole point of the chip is to be
 * trustworthy — "Serving X · Auth Migration" is only worth showing if the
 * board agrees that X is on Auth Migration.
 */
async function servedWorkItem(body: { workItemId?: string; suggestionId?: string }): Promise<{
  workItemId?: string; workItemTitle?: string; initiativeId?: string; initiativeName?: string;
}> {
  const id = (body.workItemId ?? '').trim()
    || (body.suggestionId ? decodeSuggestionId(body.suggestionId.trim()) ?? '' : '');
  if (!id) return {};
  try {
    const item = await getWorkItem(id);
    if (!item) return {};
    return {
      workItemId: item.id,
      workItemTitle: item.title,
      initiativeId: item.projectId,
      initiativeName: item.projectName,
    };
  } catch (err) {
    // Attribution is a nicety; dispatching the work is not.
    console.warn(`[work] could not resolve work item ${id} for a queued job:`, (err as Error).message);
    return {};
  }
}

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

/**
 * Queue a job — and record what it serves.
 *
 * The complaint this answers: "it's not intuitive what queue a job means in
 * regards to the projects the user is working on." A queued job used to be an
 * orphan. You picked a suggestion drawn from your sprint, the composer filled
 * in a prompt, and the moment you pressed the button every trace of *why* was
 * gone — the queue row was a title and a status, indistinguishable from
 * something typed from scratch, and nothing on the page tied the run back to
 * the item it was meant to move.
 *
 * The contract, and why it is this way:
 *
 *   - `workItemId` is the canonical field. A work item is a durable row other
 *     surfaces already know how to talk about; it is the fact worth storing.
 *   - `suggestionId` is accepted as a convenience and **decoded here**, not on
 *     the client. Suggestion ids are `sg-<workItemId>` (lib/work-suggestions),
 *     which makes them the ranker's handle for a card — a UI-facing id whose
 *     shape is ours to change. Teaching the browser to slice a prefix off it
 *     would hard-code that shape into the portal and make it a public format;
 *     decoding server-side keeps the id space where it is minted.
 *   - Either way the item is **looked up before it is stored**. A caller
 *     cannot assert a link to an item that does not exist, and the lookup is
 *     what supplies the initiative — so the chip on the queue row names the
 *     initiative from the board, not from whatever the client believed.
 *
 * An unknown or non-existent id is dropped rather than fatal: the job is still
 * worth running, and refusing to dispatch real work over a stale attribution
 * would be the wrong trade.
 */
workRouter.post('/jobs', requireAction('ManageDevbox'), asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as {
    title?: string; prompt?: string; kind?: string; priority?: number;
    requiresReview?: boolean; findingId?: string;
    workItemId?: string; suggestionId?: string;
  };
  const title = (body.title ?? '').trim();
  const prompt = (body.prompt ?? '').trim();
  if (!title) throw new ValidationError('title is required');
  if (!prompt) throw new ValidationError('prompt is required — it is what the worker runs');
  // Validated rather than passed through, because a kind nothing claims is a row
  // that sits in `queued` forever looking like pending work. Two executors read
  // this table and each takes a disjoint set: the in-process dispatcher claims
  // everything EXCEPT `local:*` (providers/agent-jobs.ts `claimNextJob`), and a
  // paired workstation claims only `local:*` and only what it registered for. A
  // typo'd kind belongs to neither, and there is nothing downstream that would
  // ever report it as stuck.
  const kind = (body.kind ?? 'devbox:task').trim();
  if (!QUEUEABLE_KINDS.includes(kind)) {
    throw new ValidationError(`kind must be one of ${QUEUEABLE_KINDS.join(', ')}`);
  }

  const job = await enqueueJob({
    kind,
    title,
    payload: {
      prompt,
      requiresReview: body.requiresReview !== false,
      ...(await servedWorkItem(body)),
    },
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

// Requeue a dead-lettered job — the DLQ's one verb. The server clones the
// original (kind/title/payload) so the caller never has to re-supply a prompt;
// 409 when the job is not in a terminal failed/cancelled state.
workRouter.post('/jobs/:id/requeue', requireAction('ManageDevbox'), asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  const session = resolveSession(req);
  const job = await requeueJob(id, session?.sub);
  if (!job) {
    const dead = await getJob(id);
    if (!dead) { res.status(404).json({ error: 'job not found' }); return; }
    res.status(409).json({ error: `only failed or cancelled jobs can be requeued (this one is ${dead.status})` });
    return;
  }
  res.status(201).json(job);
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

/**
 * "Run sweeps now" only reads the graph and (re)writes the `findings` cache —
 * org-sweeps.ts makes no Bedrock call and enqueues no agent job, so it spends
 * nothing and dispatches nothing. `ManageDevbox` (the Computer Lab / devbox
 * capability) was the wrong gate for that: it is a read-tier action, exactly
 * like the mount-level `requireSession('ViewWork')` floor GET /findings
 * already relies on, so this drops to the same floor rather than a specific
 * capability (program-owner.md defect #4 — auditing the surrounding gates).
 */
workRouter.post('/sweeps/run', requireSession('RunSweeps'), asyncHandler(async (req, res) => {
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
 *
 * Grant-scoped the same as `POST /api/bots/dispatch-work`: this is a second
 * front door onto the same spend, and an ungranted sme must be refused here
 * exactly as they are there — same helper (`grantScopedDispatchVerdict`),
 * same deny text, same bypass for org-leader/hr-admin/admin. A finding with no
 * initiative in its evidence is unscoped (see `initiativeIdForFinding`) and
 * the gate never fires for it, matching the money gates' own posture: no
 * context is not a denial to invent.
 *
 * Gated `DispatchAgentRun`, not `ManageDevbox` (program-owner.md defect #4):
 * promoting a finding enqueues an agent job — the same act as
 * `POST /api/bots/dispatch-work` — and `DispatchAgentRun` is the capability
 * Cedar grants for exactly that (sme, program-owner, org-leader, hr-admin).
 * `ManageDevbox` is the Computer Lab / devbox-driving capability, which is
 * unrelated: it 403'd program-owner here while the same role could already
 * authorize the identical spend from initiative-detail's Estimate flow.
 */
workRouter.post('/findings/:id/promote', requireAction('DispatchAgentRun'), asyncHandler(async (req, res) => {
  const finding = await getFinding(String(req.params['id'] ?? ''));
  if (!finding) { res.status(404).json({ error: 'finding not found' }); return; }
  if (finding.jobId && finding.status === 'promoted') {
    res.status(409).json({ error: 'finding already has a worker on it', jobId: finding.jobId });
    return;
  }

  const initiativeId = initiativeIdForFinding(finding);
  if (initiativeId) {
    const verdict = await grantScopedDispatchVerdict(initiativeId, resolveSession(req) ?? undefined);
    if (verdict.kind === 'deny') { res.status(403).json({ error: verdict.reason }); return; }
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

/**
 * Ask the linker what a document should be connected to.
 *
 * This is the other way to act on a finding: instead of putting a worker on it
 * to write about the problem, extract the links the document is missing and
 * propose them. Output is pending proposals — approval still gates the graph.
 * `dryRun` returns what it would propose without writing any.
 */
workRouter.post('/findings/:id/analyze', requireAction('ManageDevbox'), asyncHandler(async (req, res) => {
  const finding = await getFinding(String(req.params['id'] ?? ''));
  if (!finding) { res.status(404).json({ error: 'finding not found' }); return; }
  if (finding.entityType !== 'document' || !finding.entityId) {
    res.status(400).json({
      error: `only document findings can be link-analysed (this one targets ${finding.entityType ?? 'nothing'})`,
    });
    return;
  }
  const dryRun = Boolean((req.body as { dryRun?: boolean } | undefined)?.dryRun);
  const analysis = await analyzeDocumentLinks(finding.entityId, { findingId: finding.id, dryRun });
  res.json(analysis);
}));

/**
 * Analyse a batch of open document findings.
 *
 * The provider picks the documents: open findings with no live proposal yet,
 * so pressing this twice makes progress instead of re-analysing the same head
 * of the list. `remaining` reports what is left after this pass.
 *
 * Stays `ManageDevbox` (program-owner.md defect #4 — audited, not changed):
 * unlike sweeps/run, this calls Bedrock per document (real spend) and writes
 * `graph_proposals` rows — the same write `POST /proposals` (manual proposal
 * creation, also `ManageDevbox`) makes. It is not agent-job dispatch, so
 * `DispatchAgentRun` would be the wrong capability; it is a graph-write-
 * adjacent action, so it keeps the same gate as its manual counterpart.
 */
workRouter.post('/findings/analyze-batch', requireAction('ManageDevbox'), asyncHandler(async (req, res) => {
  const { limit, sweep } = (req.body ?? {}) as { limit?: number; sweep?: string };
  res.json(await analyzeDocumentFindings(limit ?? 10, sweep ?? 'stale_docs'));
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
