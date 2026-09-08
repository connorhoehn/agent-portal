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
import { asyncHandler, NotFoundError, ValidationError } from '../lib/async-handler.js';
import { requireAction, resolveSession } from '../lib/authz.js';
import {
  compactionHealth, compactNow, ingest, levels, listCompactions, sampling, samplingVerdict,
  listItems, getItem, lineageFor, listArtifacts, factLineage, listReview, decideReview, libraryProvenance,
  type CompactableLevel, type CompactionStatus, type Level,
  type ArtifactStatus, type ArtifactType, type ReviewVerdict,
} from '../providers/distillation.js';

// obs-123, cl-004, art-001, fact-011, orgiq-supervisor-system-prompt,
// lib-csrf-check, skill-flaky-test-triage — every id in this domain (and
// every Library asset id it links to) is lowercase-letters-then-dash
// followed by alnum/dash.
const ID_RE = /^[a-z]+-[A-Za-z0-9-]+$/;
const LEVELS = ['L0', 'L1', 'L2'] as const;
const ARTIFACT_STATUSES = ['draft', 'published', 'retired'] as const;
const ARTIFACT_TYPES = ['runbook', 'insight', 'convention', 'decision'] as const;
const REVIEW_VERDICTS = ['pending', 'agree', 'disagree'] as const;

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

const manageGate = requireAction('ManageBots');

// GET /api/distillation/levels — L0/L1/L2 with the computed health verdict
// attached per level, so the portal renders a judgment made in one place
// rather than re-deriving the lag/stall thresholds client-side.
distillationRouter.get('/levels', asyncHandler(async (_req, res) => {
  const [ls, jobs] = await Promise.all([levels(), listCompactions()]);
  res.json({ levels: ls, health: compactionHealth(ls, jobs) });
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
  const status = (['running', 'succeeded', 'failed'] as const).includes(statusRaw as CompactionStatus)
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
distillationRouter.post('/compact', manageGate, asyncHandler(async (req, res) => {
  const level = String((req.body as { level?: unknown } | undefined)?.level ?? '');
  if (level !== 'L1' && level !== 'L2') {
    throw new ValidationError("level must be 'L1' or 'L2' — L0 is the write head, nothing compacts into it");
  }
  const session = resolveSession(req);
  const job = await compactNow(level as CompactableLevel, session?.name ?? session?.sub ?? 'someone');
  res.status(201).json(job);
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

// GET /api/distillation/items/:id — kind-discriminated by `level`.
distillationRouter.get('/items/:id', asyncHandler(async (req, res) => {
  const id = requireId(String(req.params['id']));
  const item = await getItem(id);
  if (!item) throw new NotFoundError(`item ${id} not found`);
  res.json(item);
}));

// GET /api/distillation/items/:id/lineage?depth=1-4
distillationRouter.get('/items/:id/lineage', asyncHandler(async (req, res) => {
  const id = requireId(String(req.params['id']));
  const depth = intInRange(req.query['depth'], 'depth', 1, 4, 2);
  const item = await getItem(id);
  if (!item) throw new NotFoundError(`item ${id} not found`);
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
