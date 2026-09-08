// Prompt History — version log + experiment outcomes for /iq/history.
//
// Reads from:
//   observability.canary_experiments  (one row per completed A/B run)
//   observability.canary_decisions    (per-tick decision log, Sprint 5)
//   observability.prompt_version_meta (description + lifecycle status)
//
// Also exposes POST /experiments/:id/complete so the canary controller can
// seal an experiment row when it reaches PROMOTE / ROLLBACK / HALT.
//
// Mounted at /api/iq/prompts (see index.ts).

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { requireAction } from '../lib/authz.js';
import {
  PROMPT_KINDS, PROMPT_TIERS, EMPTY_CONTRACT,
  type PromptContract, type PromptKind, type PromptTier,
} from '../lib/prompt-contract.js';
import { exec } from '../providers/aurora.js';

export const promptHistoryRouter = Router();

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}
function p(name: string, value: string): SqlParameter {
  return { name, value: { stringValue: value } };
}
function pn(name: string, value: number | null): SqlParameter {
  return value === null
    ? { name, value: { isNull: true } }
    : { name, value: { doubleValue: value } };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /history/:promptId
//   Returns the version timeline for one prompt: each Bedrock version enriched
//   with prompt_version_meta lifecycle data and the experiments that used it.
//
// Response: { versions: VersionEntry[] }
// ─────────────────────────────────────────────────────────────────────────────

promptHistoryRouter.get('/history/:promptId', asyncHandler(async (req, res) => {
  const promptId = str(req.params['promptId']);
  if (!promptId) throw new ValidationError('promptId required');

  // Fetch version metadata rows
  const metaRows = await exec(
    `SELECT version, description, author_email, published_at,
            deployed_at, superseded_at, lifecycle_status,
            kind, tier, contract::text AS contract, owner_email, eval_pass_rate
     FROM observability.prompt_version_meta
     WHERE prompt_id = :promptId
     ORDER BY
       CASE WHEN version = 'DRAFT' THEN 0 ELSE 1 END,
       CAST(NULLIF(regexp_replace(version, '[^0-9]','','g'),'') AS int) DESC NULLS LAST`,
    [p('promptId', promptId)],
  ).catch(() => [] as Record<string, unknown>[]);

  // For each version, fetch experiments where it was used as A or B
  const expRows = await exec(
    `SELECT experiment_id, prompt_version_a, prompt_version_b,
            started_at, finished_at, final_action,
            final_score_a, final_score_b, score_delta, decision_count
     FROM observability.canary_experiments
     WHERE prompt_id = :promptId
     ORDER BY started_at DESC
     LIMIT 100`,
    [p('promptId', promptId)],
  ).catch(() => [] as Record<string, unknown>[]);

  // Group experiments by which version they involve
  const expByVersion: Record<string, typeof expRows> = {};
  for (const exp of expRows) {
    const va = str(exp['prompt_version_a']);
    const vb = str(exp['prompt_version_b']);
    for (const v of [va, vb]) {
      if (!expByVersion[v]) expByVersion[v] = [];
      expByVersion[v].push(exp);
    }
  }

  const versions = metaRows.map(row => ({
    version: str(row['version']),
    description: str(row['description']),
    authorEmail: str(row['author_email']),
    publishedAt: str(row['published_at']),
    deployedAt: str(row['deployed_at']),
    supersededAt: str(row['superseded_at']),
    lifecycleStatus: str(row['lifecycle_status'], 'published'),
    // The contract travels with the version — Studio needs it to render the
    // right inputs, and the release gate needs it to decide deployability.
    kind: str(row['kind'], 'prompt'),
    tier: str(row['tier'], 'sandbox'),
    contract: parseContract(safeJson(row['contract'])),
    ownerEmail: row['owner_email'] != null ? str(row['owner_email']) : null,
    evalPassRate: row['eval_pass_rate'] != null ? Number(row['eval_pass_rate']) : null,
    experiments: (expByVersion[str(row['version'])] ?? []).map(e => ({
      experimentId: str(e['experiment_id']),
      versionA: str(e['prompt_version_a']),
      versionB: str(e['prompt_version_b']),
      startedAt: str(e['started_at']),
      finishedAt: str(e['finished_at']),
      finalAction: str(e['final_action']),
      scoreA: num(e['final_score_a']),
      scoreB: num(e['final_score_b']),
      scoreDelta: num(e['score_delta']),
      decisionCount: num(e['decision_count']) ?? 0,
    })),
  }));

  res.json({ versions });
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /experiments
//   All completed experiments, newest-first, with outcome summary.
//
// Response: { experiments: ExperimentSummary[] }
// ─────────────────────────────────────────────────────────────────────────────

promptHistoryRouter.get('/experiments', asyncHandler(async (_req, res) => {
  const rows = await exec(
    `SELECT e.experiment_id, e.prompt_id, e.canary_name,
            e.prompt_version_a, e.prompt_version_b,
            e.started_at, e.finished_at, e.final_action,
            e.final_score_a, e.final_score_b, e.score_delta,
            e.decision_count, e.halt_reason,
            m.description AS description_b
     FROM observability.canary_experiments e
     LEFT JOIN observability.prompt_version_meta m
       ON m.prompt_id = e.prompt_id AND m.version = e.prompt_version_b
     ORDER BY e.started_at DESC
     LIMIT 200`,
    [],
  ).catch(() => [] as Record<string, unknown>[]);

  const experiments = rows.map(r => ({
    experimentId: str(r['experiment_id']),
    promptId: str(r['prompt_id']),
    canaryName: str(r['canary_name']),
    versionA: str(r['prompt_version_a']),
    versionB: str(r['prompt_version_b']),
    descriptionB: str(r['description_b']),
    startedAt: str(r['started_at']),
    finishedAt: str(r['finished_at']),
    finalAction: str(r['final_action']),
    scoreA: num(r['final_score_a']),
    scoreB: num(r['final_score_b']),
    scoreDelta: num(r['score_delta']),
    decisionCount: num(r['decision_count']) ?? 0,
    haltReason: str(r['halt_reason']),
  }));

  res.json({ experiments });
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /experiments/:experimentId
//   Full experiment detail with the per-tick decision log.
// ─────────────────────────────────────────────────────────────────────────────

promptHistoryRouter.get('/experiments/:experimentId', asyncHandler(async (req, res) => {
  const experimentId = str(req.params['experimentId']);

  const [expRows, decisionRows] = await Promise.all([
    exec(
      `SELECT * FROM observability.canary_experiments WHERE experiment_id = :id`,
      [p('id', experimentId)],
    ).catch(() => [] as Record<string, unknown>[]),
    exec(
      `SELECT decided_at, action, weight_b_before, weight_b_after,
              composite_a, composite_b, reason
       FROM observability.canary_decisions
       WHERE prompt_version_a_arn = (
           SELECT prompt_arn_a FROM observability.canary_experiments WHERE experiment_id = :id
       ) AND prompt_version_b_arn = (
           SELECT prompt_arn_b FROM observability.canary_experiments WHERE experiment_id = :id
       )
       ORDER BY decided_at ASC`,
      [p('id', experimentId)],
    ).catch(() => [] as Record<string, unknown>[]),
  ]);

  if (!expRows.length) {
    res.status(404).json({ error: 'Experiment not found' });
    return;
  }

  const e = expRows[0]!;
  res.json({
    experiment: {
      experimentId: str(e['experiment_id']),
      promptId: str(e['prompt_id']),
      versionA: str(e['prompt_version_a']),
      versionB: str(e['prompt_version_b']),
      startedAt: str(e['started_at']),
      finishedAt: str(e['finished_at']),
      finalAction: str(e['final_action']),
      scoreA: num(e['final_score_a']),
      scoreB: num(e['final_score_b']),
      scoreDelta: num(e['score_delta']),
      decisionCount: num(e['decision_count']) ?? 0,
      haltReason: str(e['halt_reason']),
    },
    decisions: decisionRows.map(d => ({
      decidedAt: str(d['decided_at']),
      action: str(d['action']),
      weightBefore: num(d['weight_b_before']),
      weightAfter: num(d['weight_b_after']),
      scoreA: num(d['composite_a']),
      scoreB: num(d['composite_b']),
      reason: str(d['reason']),
    })),
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /experiments/:experimentId/complete   Cedar-gated.
//   Called by the canary controller when an experiment concludes.
//   Upserts canary_experiments + updates prompt_version_meta lifecycle status.
// ─────────────────────────────────────────────────────────────────────────────

interface CompleteBody {
  promptId?: unknown;
  promptArnA?: unknown;
  promptArnB?: unknown;
  versionA?: unknown;
  versionB?: unknown;
  startedAt?: unknown;
  finalAction?: unknown;
  finalWeightB?: unknown;
  scoreA?: unknown;
  scoreB?: unknown;
  decisionCount?: unknown;
  haltReason?: unknown;
}

promptHistoryRouter.post(
  '/experiments/:experimentId/complete',
  requireAction('ManageCanary'),
  asyncHandler(async (req, res) => {
    const experimentId = str(req.params['experimentId']) || randomUUID();
    const body = (req.body ?? {}) as CompleteBody;

    const promptId = str(body.promptId);
    const versionA = str(body.versionA);
    const versionB = str(body.versionB);
    if (!promptId || !versionA || !versionB) {
      throw new ValidationError('promptId, versionA, versionB required');
    }

    const VALID_ACTIONS = ['PROMOTE', 'ROLLBACK', 'HALTED', 'IN_PROGRESS'];
    const finalAction = str(body.finalAction, 'IN_PROGRESS');
    if (!VALID_ACTIONS.includes(finalAction)) {
      throw new ValidationError(`finalAction must be one of ${VALID_ACTIONS.join(', ')}`);
    }

    const scoreA = typeof body.scoreA === 'number' ? body.scoreA : null;
    const scoreB = typeof body.scoreB === 'number' ? body.scoreB : null;
    const scoreDelta = scoreA !== null && scoreB !== null ? scoreB - scoreA : null;
    const decisionCount = typeof body.decisionCount === 'number' ? body.decisionCount : 0;

    await exec(
      `INSERT INTO observability.canary_experiments
         (experiment_id, prompt_id, prompt_version_a, prompt_version_b,
          prompt_arn_a, prompt_arn_b,
          started_at, finished_at, final_action, final_weight_b,
          final_score_a, final_score_b, score_delta, decision_count, halt_reason)
       VALUES
         (:id, :promptId, :versionA, :versionB,
          :arnA, :arnB,
          COALESCE(:startedAt::timestamptz, now()), now(),
          :finalAction, :finalWeightB,
          :scoreA, :scoreB, :scoreDelta, :decisionCount, :haltReason)
       ON CONFLICT (experiment_id) DO UPDATE SET
         finished_at    = now(),
         final_action   = EXCLUDED.final_action,
         final_weight_b = EXCLUDED.final_weight_b,
         final_score_a  = EXCLUDED.final_score_a,
         final_score_b  = EXCLUDED.final_score_b,
         score_delta    = EXCLUDED.score_delta,
         decision_count = EXCLUDED.decision_count,
         halt_reason    = EXCLUDED.halt_reason`,
      [
        p('id', experimentId),
        p('promptId', promptId),
        p('versionA', versionA),
        p('versionB', versionB),
        p('arnA', str(body.promptArnA)),
        p('arnB', str(body.promptArnB)),
        p('startedAt', str(body.startedAt)),
        p('finalAction', finalAction),
        { name: 'finalWeightB', value: typeof body.finalWeightB === 'number' ? { longValue: body.finalWeightB } : { isNull: true } },
        pn('scoreA', scoreA),
        pn('scoreB', scoreB),
        pn('scoreDelta', scoreDelta),
        { name: 'decisionCount', value: { longValue: decisionCount } },
        p('haltReason', str(body.haltReason)),
      ],
    );

    // Update lifecycle_status on both versions
    if (finalAction === 'PROMOTE') {
      // B is promoted → becomes new production; A is superseded
      await exec(
        `INSERT INTO observability.prompt_version_meta (prompt_id, version, lifecycle_status, deployed_at)
         VALUES (:promptId, :version, 'promoted', now())
         ON CONFLICT (prompt_id, version) DO UPDATE
         SET lifecycle_status = 'promoted'`,
        [p('promptId', promptId), p('version', versionB)],
      ).catch(() => undefined);
      await exec(
        `UPDATE observability.prompt_version_meta
         SET lifecycle_status = 'superseded', superseded_at = now()
         WHERE prompt_id = :promptId AND version = :version`,
        [p('promptId', promptId), p('version', versionA)],
      ).catch(() => undefined);
    } else if (finalAction === 'ROLLBACK') {
      await exec(
        `INSERT INTO observability.prompt_version_meta (prompt_id, version, lifecycle_status)
         VALUES (:promptId, :version, 'rolled_back')
         ON CONFLICT (prompt_id, version) DO UPDATE
         SET lifecycle_status = 'rolled_back'`,
        [p('promptId', promptId), p('version', versionB)],
      ).catch(() => undefined);
    }

    res.json({ ok: true, experimentId });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// PUT /meta/:promptId/:version   Cedar-gated.
//   Upserts prompt_version_meta (description + author written at publish time).
// ─────────────────────────────────────────────────────────────────────────────

interface MetaBody {
  description?: unknown;
  authorEmail?: unknown;
  lifecycleStatus?: unknown;
  kind?: unknown;
  tier?: unknown;
  contract?: unknown;
  ownerEmail?: unknown;
  evalPassRate?: unknown;
}

/** A jsonb column arrives as text over the Data API. A malformed blob must
 *  degrade to the empty contract, never throw a read. */
function safeJson(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Accept only a shape the contract module understands; anything else falls
 *  back to the empty contract rather than being written through unvalidated —
 *  a malformed contract would silently disable fencing at render time. */
function parseContract(raw: unknown): PromptContract {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_CONTRACT;
  const o = raw as Record<string, unknown>;
  const kind = PROMPT_KINDS.includes(o['kind'] as PromptKind) ? (o['kind'] as PromptKind) : 'prompt';
  const tier = PROMPT_TIERS.includes(o['tier'] as PromptTier) ? (o['tier'] as PromptTier) : 'sandbox';
  const variables = Array.isArray(o['variables'])
    ? (o['variables'] as unknown[]).filter((v): v is Record<string, unknown> =>
        v != null && typeof v === 'object' && typeof (v as Record<string, unknown>)['name'] === 'string')
      .map((v) => ({
        name: String(v['name']),
        type: String(v['type'] ?? 'text'),
        required: v['required'] === true,
        source: String(v['source'] ?? 'untrusted'),
        ...(typeof v['default'] === 'string' ? { default: v['default'] } : {}),
        ...(typeof v['description'] === 'string' ? { description: v['description'] } : {}),
        ...(Array.isArray(v['options']) ? { options: (v['options'] as unknown[]).map(String) } : {}),
      }))
    : [];
  return {
    kind, tier,
    variables: variables as PromptContract['variables'],
    guardrailId: typeof o['guardrailId'] === 'string' ? o['guardrailId'] : null,
  };
}

promptHistoryRouter.put(
  '/meta/:promptId/:version',
  requireAction('ManageCanary'),
  asyncHandler(async (req, res) => {
    const promptId = str(req.params['promptId']);
    const version = str(req.params['version']);
    const body = (req.body ?? {}) as MetaBody;

    const description = typeof body.description === 'string' ? body.description : null;
    const authorEmail = typeof body.authorEmail === 'string' ? body.authorEmail : null;

    const VALID_STATUSES = ['draft', 'published', 'deployed', 'promoted', 'rolled_back', 'superseded'];
    const rawStatus = str(body.lifecycleStatus, 'published');
    const lifecycleStatus = VALID_STATUSES.includes(rawStatus) ? rawStatus : 'published';

    // The contract rides the same upsert: it is another portal-side fact about
    // this version, and writing it separately would let the two drift.
    const contract = parseContract(body.contract);
    const ownerEmail = typeof body.ownerEmail === 'string' ? body.ownerEmail : null;
    const evalPassRate = typeof body.evalPassRate === 'number' && Number.isFinite(body.evalPassRate)
      ? body.evalPassRate : null;

    await exec(
      `INSERT INTO observability.prompt_version_meta
         (prompt_id, version, description, author_email, lifecycle_status, published_at,
          kind, tier, contract, owner_email, eval_pass_rate)
       VALUES
         (:promptId, :version, :description, :authorEmail, :lifecycleStatus, now(),
          :kind, :tier, :contract::jsonb, :ownerEmail, :evalPassRate)
       ON CONFLICT (prompt_id, version) DO UPDATE SET
         description      = COALESCE(EXCLUDED.description, prompt_version_meta.description),
         author_email     = COALESCE(EXCLUDED.author_email, prompt_version_meta.author_email),
         lifecycle_status = EXCLUDED.lifecycle_status,
         kind             = EXCLUDED.kind,
         tier             = EXCLUDED.tier,
         contract         = EXCLUDED.contract,
         owner_email      = COALESCE(EXCLUDED.owner_email, prompt_version_meta.owner_email),
         eval_pass_rate   = COALESCE(EXCLUDED.eval_pass_rate, prompt_version_meta.eval_pass_rate)`,
      [
        p('promptId', promptId),
        p('version', version),
        { name: 'description', value: description ? { stringValue: description } : { isNull: true } },
        { name: 'authorEmail', value: authorEmail ? { stringValue: authorEmail } : { isNull: true } },
        p('lifecycleStatus', lifecycleStatus),
        p('kind', contract.kind),
        p('tier', contract.tier),
        p('contract', JSON.stringify(contract)),
        { name: 'ownerEmail', value: ownerEmail ? { stringValue: ownerEmail } : { isNull: true } },
        { name: 'evalPassRate', value: evalPassRate != null ? { doubleValue: evalPassRate } : { isNull: true } },
      ],
    );

    res.json({ ok: true });
  }),
);
