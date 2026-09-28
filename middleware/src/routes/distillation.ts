// Distillation — /api/distillation. The shared-memory store's compaction
// state: level sizes and lag, ingest pressure, compaction health, the human
// sample dial, and the compaction job history underneath all of it. See
// providers/distillation.ts for why this is modeled as an LSM tree rather
// than a run log, and how it differs from /api/promotions (the human inbox).
//
// Reads are open — an operator needs to see a stalled level or an
// undersampled dial without asking, the same rationale promotions and the
// old distillation log used. Only forcing a compaction pass costs anything
// (compute, and it moves state), so that's the one route gated — same
// authority as standing up a fleet mission: ManageBots.

import { Router } from 'express';
import { assetRelationships } from '../providers/asset-relationships.js';
import { asyncHandler, NotFoundError, ValidationError } from '../lib/async-handler.js';
import { requireAction, resolveSession } from '../lib/authz.js';
import {
  compactNow, ingest, levelsView, listCompactions, getCompaction, sampling, samplingVerdict,
  listFacets, itemSources, getSession, procedureRuns, replicationStatus,
  listItems, getItem, lineageFor, isLineageRoot, listArtifacts, factLineage, listReview, decideReview, libraryProvenance,
  publishArtifact, sampleForReview,
  listProcedures, getProcedure, listApplications, applyProcedure, guideFor,
  type CompactableLevel, type CompactionStatus, type Level,
  type ArtifactStatus, type ArtifactType, type ReviewVerdict, type ReviewTargetKind, type ApplicationOutcome,
} from '../providers/distillation.js';

// obs-123, cl-004, art-001, fact-011, papp-001, orgiq-supervisor-system-prompt,
// lib-csrf-check, skill-flaky-test-triage — every id in this domain (and
// every Library asset id it links to) is lowercase-letters-then-dash
// followed by alnum/dash.
const ID_RE = /^[a-z]+-[A-Za-z0-9-]+$/;
// owner/name, the GitHub shape every repo in this domain carries.
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LEVELS = ['L0', 'L1', 'L2'] as const;
const ARTIFACT_STATUSES = ['draft', 'published', 'retired'] as const;
const ARTIFACT_TYPES = ['runbook', 'insight', 'convention', 'decision', 'procedure'] as const;
const REVIEW_VERDICTS = ['pending', 'agree', 'disagree'] as const;
const REVIEW_TARGET_KINDS = ['cluster', 'artifact'] as const;
const APPLICATION_OUTCOMES = ['succeeded', 'failed', 'abandoned'] as const;

function requireId(raw: string, field = 'id'): string {
  if (!ID_RE.test(raw)) throw new ValidationError(`${field} must match ${ID_RE.source}`);
  return raw;
}

/** `limit`/`depth` — a query param that must be an integer in [min, max] when
 *  present, or the given default when absent. */
function intInRange(raw: unknown, field: string, min: number, max: number, def: number): number {
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(`${field} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function enumOrUndefined<T extends string>(raw: unknown, field: string, allowed: readonly T[]): T | undefined {
  const s = String(raw ?? '').trim();
  if (!s) return undefined;
  if (!(allowed as readonly string[]).includes(s)) {
    throw new ValidationError(`${field} must be one of ${allowed.join(', ')}`);
  }
  return s as T;
}

export const distillationRouter: Router = Router();

// Cross-surface links retain the source records and their own approval gates.
distillationRouter.get('/relationships/:kind/:id', asyncHandler(async (req, res) => {
  const kind = String(req.params['kind']);
  if (kind !== 'knowledge' && kind !== 'library' && kind !== 'promotion') throw new ValidationError('unknown relationship kind');
  const links = await assetRelationships(kind, String(req.params['id']));
  if (!links) throw new NotFoundError('record not found');
  res.json({ links });
}));

const manageGate = requireAction('ManageBots');

// GET /api/distillation/levels — L0/L1/L2 with the computed health verdict
// attached per level, so the portal renders a judgment made in one place
// rather than re-deriving the lag/stall thresholds client-side. Each tier also
// carries writers, backlog, lastCompletedAt, its Merkle digest and
// health {state, reason, lagSeconds}; `health[]` stays for existing readers.
// The distill:levels channel pushes this same `levels` array.
distillationRouter.get('/levels', asyncHandler(async (_req, res) => {
  res.json(await levelsView());
}));

// GET /api/distillation/replication — the L2 read replica against its
// primary: digests, lag, last anti-entropy sweep, keys repaired.
distillationRouter.get('/replication', asyncHandler(async (_req, res) => {
  res.json(await replicationStatus());
}));

// GET /api/distillation/ingest — write pressure right now.
distillationRouter.get('/ingest', asyncHandler(async (_req, res) => {
  res.json(await ingest());
}));

// GET /api/distillation/compactions?level=&status=
distillationRouter.get('/compactions', asyncHandler(async (req, res) => {
  const levelRaw = String(req.query['level'] ?? '').trim();
  const statusRaw = String(req.query['status'] ?? '').trim();
  const level = (['L0', 'L1', 'L2'] as const).includes(levelRaw as Level) ? (levelRaw as Level) : undefined;
  const status = (['queued', 'running', 'succeeded', 'failed'] as const).includes(statusRaw as CompactionStatus)
    ? (statusRaw as CompactionStatus) : undefined;
  const jobs = await listCompactions({ ...(level ? { level } : {}), ...(status ? { status } : {}) });
  res.json({ jobs });
}));

// GET /api/distillation/sampling — the human-review dial plus the computed
// verdict (undersampled/calibrated/oversampled), same "decide it once,
// server-side" pattern as /levels.
distillationRouter.get('/sampling', asyncHandler(async (_req, res) => {
  const s = await sampling();
  res.json({ ...s, verdict: samplingVerdict(s) });
}));

// POST /api/distillation/compact — force a pass ahead of the background
// scheduler. L0 is the write head, not a valid target: nothing compacts
// into it, so that's a 400, not a silent no-op.
//
// The pass is put on the message queue (distill-compact-l1|l2) and answered
// `queued`; a consumer claims it and the distill:jobs channel carries it from
// there. `repo` (optional) scopes the pass to one repository — and is its FIFO
// message group, so two passes over one repo never run at once.
distillationRouter.post('/compact', manageGate, asyncHandler(async (req, res) => {
  const body = req.body as { level?: unknown; repo?: unknown } | undefined;
  const level = String(body?.level ?? '');
  if (level !== 'L1' && level !== 'L2') {
    throw new ValidationError("level must be 'L1' or 'L2' — L0 is the write head, nothing compacts into it");
  }
  const repoRaw = body?.repo === undefined || body?.repo === null ? '' : String(body.repo).trim();
  if (repoRaw && !REPO_RE.test(repoRaw)) throw new ValidationError('repo must look like owner/name');
  const session = resolveSession(req);
  const job = await compactNow(level as CompactableLevel, session?.name ?? session?.sub ?? 'someone', repoRaw || null);
  res.status(201).json(job);
}));

// GET /api/distillation/compactions/:id — one job, with its run log.
distillationRouter.get('/compactions/:id', asyncHandler(async (req, res) => {
  const id = requireId(String(req.params['id']));
  const job = await getCompaction(id);
  if (!job) throw new NotFoundError(`compaction ${id} not found`);
  res.json(job);
}));

// ─── Navigable knowledge: items, lineage, artifacts, facts, review ─────────
// Open reads, same rationale as the operational routes above — provenance is
// exactly what a person needs to see without asking. Only deciding a review
// sample (below) moves state, so that's the one route gated here too.

// GET /api/distillation/items?level=&repo=&initiative=&q=&limit=&cursor=
distillationRouter.get('/items', asyncHandler(async (req, res) => {
  const level = enumOrUndefined(req.query['level'], 'level', LEVELS);
  const limit = intInRange(req.query['limit'], 'limit', 1, 200, 50);
  const repo = req.query['repo'] !== undefined ? String(req.query['repo']) : undefined;
  const initiative = req.query['initiative'] !== undefined ? String(req.query['initiative']) : undefined;
  const q = req.query['q'] !== undefined ? String(req.query['q']) : undefined;
  const cursor = req.query['cursor'] !== undefined ? String(req.query['cursor']) : undefined;
  const result = await listItems({
    ...(level ? { level } : {}),
    ...(repo ? { repo } : {}),
    ...(initiative ? { initiative } : {}),
    ...(q ? { q } : {}),
    ...(cursor ? { cursor } : {}),
    limit,
  });
  res.json(result);
}));

// GET /api/distillation/facets?level= — the repos, initiatives and kinds
// present in a level, each counted the way /items would filter it.
distillationRouter.get('/facets', asyncHandler(async (req, res) => {
  const level = enumOrUndefined(req.query['level'], 'level', LEVELS);
  res.json(await listFacets(level));
}));

// GET /api/distillation/items/:id — kind-discriminated by `level`. An L2
// record also carries `guide` { approach, based_on, run_warning }, derived
// from rows on this read (providers/distillation.ts guideFor) so the plain
// "how to use it" view never lags the runs recorded against it. L0/L1 carry
// no `guide` key at all — they are not guides.
distillationRouter.get('/items/:id', asyncHandler(async (req, res) => {
  const id = requireId(String(req.params['id']));
  const item = await getItem(id);
  if (!item) throw new NotFoundError(`item ${id} not found`);
  if (item.level === 'L2') {
    res.json({ ...item, guide: await guideFor(id) });
    return;
  }
  res.json(item);
}));

// GET /api/distillation/items/:id/sources — the item's direct evidence:
// L2 → its patterns + their run notes, L1 → member notes, L0 → its session.
distillationRouter.get('/items/:id/sources', asyncHandler(async (req, res) => {
  const id = requireId(String(req.params['id']));
  const sources = await itemSources(id);
  if (!sources) throw new NotFoundError(`item ${id} not found`);
  res.json({ sources });
}));

// GET /api/distillation/sessions/:id — a run-note session and its notes.
distillationRouter.get('/sessions/:id', asyncHandler(async (req, res) => {
  const id = requireId(String(req.params['id']));
  const session = await getSession(id);
  if (!session) throw new NotFoundError(`session ${id} not found`);
  res.json(session);
}));

// GET /api/distillation/items/:id/lineage?depth=1-4
distillationRouter.get('/items/:id/lineage', asyncHandler(async (req, res) => {
  const id = requireId(String(req.params['id']));
  const depth = intInRange(req.query['depth'], 'depth', 1, 4, 2);
  if (!(await isLineageRoot(id))) throw new NotFoundError(`item ${id} not found`);
  res.json(await lineageFor(id, depth));
}));

// GET /api/distillation/artifacts?status=&type=&q=
distillationRouter.get('/artifacts', asyncHandler(async (req, res) => {
  const status = enumOrUndefined<ArtifactStatus>(req.query['status'], 'status', ARTIFACT_STATUSES);
  const type = enumOrUndefined<ArtifactType>(req.query['type'], 'type', ARTIFACT_TYPES);
  const q = req.query['q'] !== undefined ? String(req.query['q']) : undefined;
  const artifacts = await listArtifacts({
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
    ...(q ? { q } : {}),
  });
  res.json({ artifacts });
}));

// POST /api/distillation/artifacts/:id/publish — draft -> published. The
// enterprise-asset row card's "Publish" quick action (docs/
// distillation-concept-audit-2026-09-16.md §3): moves ArtifactStatus, same
// authority as deciding a review sample (ManageBots) since it changes what
// every reader of this artifact sees.
distillationRouter.post('/artifacts/:id/publish', manageGate, asyncHandler(async (req, res) => {
  const id = requireId(String(req.params['id']));
  const session = resolveSession(req);
  const artifact = await publishArtifact(id, session?.name ?? session?.sub ?? 'someone');
  res.json(artifact);
}));

// GET /api/distillation/facts/:id/lineage
distillationRouter.get('/facts/:id/lineage', asyncHandler(async (req, res) => {
  const id = requireId(String(req.params['id']), 'id');
  if (!id.startsWith('fact-')) throw new ValidationError('id must be a fact id (fact-…)');
  const lineage = await factLineage(id);
  if (lineage.nodes.length === 0) throw new NotFoundError(`fact ${id} not found`);
  res.json(lineage);
}));

// GET /api/distillation/review?verdict=pending|agree|disagree
distillationRouter.get('/review', asyncHandler(async (req, res) => {
  const verdict = enumOrUndefined<ReviewVerdict>(req.query['verdict'], 'verdict', REVIEW_VERDICTS);
  const samples = await listReview({ ...(verdict ? { verdict } : {}) });
  res.json({ samples });
}));

// POST /api/distillation/review { target_kind: 'cluster'|'artifact', target_id }
// Adds a target to the human sample queue by hand — the enterprise-asset row
// card's "Request review" quick action. Same authority as deciding a sample:
// it moves the queue depth every reader of the sampling dial sees.
distillationRouter.post('/review', manageGate, asyncHandler(async (req, res) => {
  const body = req.body as { target_kind?: unknown; target_id?: unknown } | undefined;
  const targetKind = enumOrUndefined<ReviewTargetKind>(body?.target_kind, 'target_kind', REVIEW_TARGET_KINDS);
  if (!targetKind) throw new ValidationError(`target_kind must be one of ${REVIEW_TARGET_KINDS.join(', ')}`);
  const targetId = requireId(String(body?.target_id ?? ''), 'target_id');
  const session = resolveSession(req);
  const sample = await sampleForReview(targetKind, targetId, session?.name ?? session?.sub ?? 'someone');
  res.status(201).json(sample);
}));

// POST /api/distillation/review/:id { verdict: 'agree'|'disagree', note? }
// Moves state (records a human judgment against the sample), same authority
// as forcing a compaction pass: ManageBots.
distillationRouter.post('/review/:id', manageGate, asyncHandler(async (req, res) => {
  const id = requireId(String(req.params['id']));
  const body = req.body as { verdict?: unknown; note?: unknown } | undefined;
  const verdict = enumOrUndefined<'agree' | 'disagree'>(body?.verdict, 'verdict', ['agree', 'disagree']);
  if (!verdict) throw new ValidationError("verdict must be one of agree, disagree");
  const note = body?.note === undefined || body?.note === null ? null : String(body.note);
  const session = resolveSession(req);
  const sample = await decideReview(id, { verdict, note }, session?.name ?? session?.sub ?? 'someone');
  res.json(sample);
}));

// GET /api/distillation/library/:libraryItemId/provenance
distillationRouter.get('/library/:libraryItemId/provenance', asyncHandler(async (req, res) => {
  const id = requireId(String(req.params['libraryItemId']), 'libraryItemId');
  const provenance = await libraryProvenance(id);
  if (!provenance) throw new NotFoundError(`no artifact links to library item ${id}`);
  res.json(provenance);
}));

// ─── Procedures: ordered steps, and whether they still hold ────────────────
// Reads are open like every other read here. Recording a run moves state
// (it changes the procedure's counted health for everyone), so it takes the
// same ManageBots gate as deciding a review sample.

// GET /api/distillation/procedures — server-sorted: drifting, unproven,
// proven, then most recently run first, so the list opens on what needs a
// person's attention.
distillationRouter.get('/procedures', asyncHandler(async (_req, res) => {
  res.json({ procedures: await listProcedures() });
}));

// GET /api/distillation/procedures/:id — 404 for an id that is not a
// procedure artifact, a runbook included: it has no steps to prove.
distillationRouter.get('/procedures/:id', asyncHandler(async (req, res) => {
  const id = requireId(String(req.params['id']));
  const view = await getProcedure(id);
  if (!view) throw new NotFoundError(`procedure ${id} not found`);
  res.json(view);
}));

// GET /api/distillation/procedures/:id/applications — newest first.
distillationRouter.get('/procedures/:id/applications', asyncHandler(async (req, res) => {
  const id = requireId(String(req.params['id']));
  const applications = await listApplications(id);
  if (!applications) throw new NotFoundError(`procedure ${id} not found`);
  res.json({ applications });
}));

// GET /api/distillation/procedures/:id/runs — each run with per-step
// outcomes, newest first (the procedure's Runs tab).
distillationRouter.get('/procedures/:id/runs', asyncHandler(async (req, res) => {
  const id = requireId(String(req.params['id']));
  const runs = await procedureRuns(id);
  if (!runs) throw new NotFoundError(`procedure ${id} not found`);
  res.json({ runs });
}));

// POST /api/distillation/procedures/:id/apply
//   { outcome: 'succeeded'|'failed'|'abandoned', failed_at_step_id?, note?,
//     advice?, plain_reason? }
// `advice`/`plain_reason` are the plain-language warning a failed or
// abandoned run leaves on the guide (≤200 chars each, trimmed; the provider
// 400s them on a succeeded run).
// The session is the caller's own (from the cookie, never the body — the
// same attribution rule bot_runs.dispatched_by follows) and the box is the
// portal, since a run reported through this route was driven by hand.
distillationRouter.post('/procedures/:id/apply', manageGate, asyncHandler(async (req, res) => {
  const id = requireId(String(req.params['id']));
  const body = req.body as {
    outcome?: unknown; failed_at_step_id?: unknown; note?: unknown; advice?: unknown; plain_reason?: unknown;
  } | undefined;
  const outcome = enumOrUndefined<ApplicationOutcome>(body?.outcome, 'outcome', APPLICATION_OUTCOMES);
  if (!outcome) throw new ValidationError(`outcome must be one of ${APPLICATION_OUTCOMES.join(', ')}`);
  const failedAtStepId = body?.failed_at_step_id === undefined || body?.failed_at_step_id === null
    ? null : requireId(String(body.failed_at_step_id), 'failed_at_step_id');
  const note = body?.note === undefined || body?.note === null ? null : String(body.note);
  const optionalText = (value: unknown, field: string): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
    return value;
  };
  const advice = optionalText(body?.advice, 'advice');
  const plainReason = optionalText(body?.plain_reason, 'plain_reason');
  const session = resolveSession(req);
  const application = await applyProcedure(
    id,
    { outcome, failed_at_step_id: failedAtStepId, note, advice, plain_reason: plainReason },
    { sessionId: session?.sub ?? 'someone', boxId: 'portal' },
  );
  res.status(201).json(application);
}));
