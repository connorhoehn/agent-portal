// Assessment tenant — /api/assessment (mounted with requireTenant('assessment')
// by index.ts). Cedar gates:
//   reads                                  -> ViewAssessment
//   POST /teams, intake, scores/apply,
//     submissions commit                   -> ScoreAssessment
//   PATCH /teams/:id/exceptions/:dimId     -> ApproveException
//   PUT /configuration                     -> ManageAssessmentConfig
//   knowledge doc PUT/restore              -> ManageKnowledge
//   POST /runs                             -> RunAssessmentAgent
//   submissions parse/clear                -> ManageSubmissions
//
// Team/envelope ids are validated against ^TEAM-[A-Za-z0-9-]+$ (traversal
// guard, mirroring the source's _guard_team_id) before ever reaching the
// provider. More specific /teams/:id/... sub-routes are declared before the
// generic /teams/:id PATCH/DELETE — Express matches routes in registration
// order, so a literal segment could otherwise be swallowed by a param at the
// same depth.

import express, { Router } from 'express';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import { requireAction, requireTenant } from '../lib/authz.js';
import { ASSESSMENT_RUN_COMPLETE_SERVICE_AUTH, requireServiceAuth } from '../lib/service-auth.js';
import { ADMIN_ROLE } from '../lib/session.js';
import { logAuthz } from '../lib/audit.js';
import { initSSE, writeSSE, endSSE } from '../lib/sse.js';
import { assessmentBroker } from '../lib/assessment-broker.js';
import * as provider from '../providers/assessment.js';
import { isValidTeamId } from '../providers/assessment.js';
import { documentCommentTargetIds } from '../providers/document-comments.js';
import type { Cohort, MotionConfig, ScoringLogEntry } from '../mock/assessment.js';

export const assessmentRouter: Router = Router();

// Every route on this router is tenant-scoped and session-bearing EXCEPT
// POST /runs/:runId/complete below, which a deployed/local agent hits with
// no session (mirrors harnessRouter's /trace — see CLAUDE.md "Not every
// route on an observability/tooling router is human-facing"). index.ts used
// to apply requireTenant('assessment') ahead of this router at the mount,
// which would 401 that callback before requireRunCompleteAuth ever ran; the
// gate now lives here so the one exemption is possible.
// ⚠️ This pattern must match every path Express will route to the handler,
// or the exemption is narrower than the route it exempts. Express defaults to
// `strict: false, caseSensitive: false`, so `/runs/:id/complete/` and
// `/runs/:id/COMPLETE` both reach the handler — but an anchored, case-sensitive
// regex refused them, and the machine caller got a 403 blaming a tenant it does
// not have. A proxy that normalises a trailing slash would have turned a
// working agent callback into that 403 with nothing in the message to explain
// it. Hence `\/?$` and the `i` flag: same matching rules as the router.
const RUN_COMPLETE_PATH = /^\/runs\/[^/]+\/complete\/?$/i;
assessmentRouter.use((req, res, next) => {
  if (req.method === 'POST' && RUN_COMPLETE_PATH.test(req.path)) { next(); return; }
  requireTenant('assessment')(req, res, next);
});

const viewGate = requireAction('ViewAssessment');
const scoreGate = requireAction('ScoreAssessment');
const approveGate = requireAction('ApproveException');
const configGate = requireAction('ManageAssessmentConfig');
const knowledgeGate = requireAction('ManageKnowledge');
const runGate = requireAction('RunAssessmentAgent');
const submissionsGate = requireAction('ManageSubmissions');

// Same silent-clamp convention routes/work-items.ts and routes/harness.ts
// already use: a non-numeric or missing `limit` falls back to a generous
// default rather than 400ing, and an oversized one is capped rather than
// honoured verbatim. `/teams` measured 168 rows under the `large` mock
// scenario with no query params at all — this exists so a live cluster that
// outgrows that isn't an unbounded read by default.
function clampLimit(raw: unknown, def: number, max: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

function requireTeamId(id: unknown): string {
  const value = typeof id === 'string' ? id : '';
  if (!value || !isValidTeamId(value)) throw new ValidationError('team id must match ^TEAM-[A-Za-z0-9-]+$');
  return value;
}

// A plain JSON object, as opposed to an array, string, number, null, etc. —
// guards a caller-supplied array element before the route reads properties
// off it (an element that's a string, null, or a bare number would otherwise
// 500 instead of 400: e.g. `null.team_id` throws).
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const VALID_COHORTS: Cohort[] = ['white_glove', 'self_service', 'general'];
const VALID_TEAM_STATUSES = new Set(['NEW', 'IN_PROGRESS', 'ASSESSED']);

// ─── Teams ──────────────────────────────────────────────────────────────────

assessmentRouter.get('/teams', viewGate, asyncHandler(async (req, res) => {
  const limit = clampLimit(req.query['limit'], 500, 2000);
  const teams = await provider.listTeams();
  res.json(teams.slice(0, limit));
}));

assessmentRouter.post('/teams', scoreGate, asyncHandler(async (req, res) => {
  const body = req.body as { name?: string; cohort?: Cohort; assessment_lead?: string };
  if (!body.name || typeof body.name !== 'string') throw new ValidationError('name is required');
  if (!body.cohort || !VALID_COHORTS.includes(body.cohort)) {
    throw new ValidationError(`cohort must be one of ${VALID_COHORTS.join(', ')}`);
  }
  const team = await provider.createTeam({ name: body.name, cohort: body.cohort, assessment_lead: body.assessment_lead });
  res.status(201).json(team);
}));

// GET /teams/recommendations is a distinct top-level route below; this is
// the per-team improvement plan.
assessmentRouter.get('/teams/:id/recommendations', viewGate, asyncHandler(async (req, res) => {
  const id = requireTeamId(req.params['id']);
  const plan = await provider.getTeamRecommendations(id);
  if (!plan) throw new NotFoundError(`team ${id} not found`);
  res.json(plan);
}));

assessmentRouter.get('/teams/:id/stories', viewGate, asyncHandler(async (req, res) => {
  const id = requireTeamId(req.params['id']);
  const stories = await provider.listStories(id);
  if (stories === null) throw new NotFoundError(`team ${id} not found`);
  res.json({ stories });
}));

assessmentRouter.get('/teams/:id/stories/:file', viewGate, asyncHandler(async (req, res) => {
  const id = requireTeamId(req.params['id']);
  const filename = String(req.params['file'] ?? '');
  const story = await provider.getStory(id, filename);
  if (!story) throw new NotFoundError('story not found');
  res.json(story);
}));

assessmentRouter.get('/teams/:id/evidence', viewGate, asyncHandler(async (req, res) => {
  const id = requireTeamId(req.params['id']);
  const evidence = await provider.listEvidence(id);
  if (evidence === null) throw new NotFoundError(`team ${id} not found`);
  res.json({ evidence });
}));

assessmentRouter.post('/teams/:id/evidence', scoreGate, asyncHandler(async (req, res) => {
  const id = requireTeamId(req.params['id']);
  const body = req.body as { dimension_id?: string | null; source_type?: string; excerpt?: string };
  if (!body.excerpt || typeof body.excerpt !== 'string') throw new ValidationError('excerpt is required');
  const validTypes = ['survey', 'transcript', 'document', 'artifact'];
  const sourceType = validTypes.includes(body.source_type ?? '') ? (body.source_type as 'survey' | 'transcript' | 'document' | 'artifact') : 'document';
  const item = await provider.uploadEvidence(id, { dimension_id: body.dimension_id ?? null, source_type: sourceType, excerpt: body.excerpt });
  if (!item) throw new NotFoundError(`team ${id} not found`);
  res.status(201).json(item);
}));

assessmentRouter.get('/teams/:id/exceptions', viewGate, asyncHandler(async (req, res) => {
  const id = requireTeamId(req.params['id']);
  const exceptions = await provider.listExceptions(id);
  if (!exceptions) throw new NotFoundError(`team ${id} not found`);
  res.json(exceptions);
}));

// Approve/deny is a lead-assessor (or above) decision — never the assessor
// who proposed the exception. Enforced by identity, not just role: the
// provider 409s when approved_by === the exception's requested_by. Only
// admin may push past that with an explicit { override: true }, and doing
// so is audit-logged (never silent).
assessmentRouter.patch('/teams/:id/exceptions/:dimensionId', approveGate, asyncHandler(async (req, res) => {
  const id = requireTeamId(req.params['id']);
  const dimensionId = String(req.params['dimensionId'] ?? '');
  const body = req.body as { status?: 'approved' | 'denied'; override?: boolean };
  if (body.status !== 'approved' && body.status !== 'denied') {
    throw new ValidationError('status must be "approved" or "denied"');
  }
  const approvedBy = req.session?.sub ?? 'unknown';
  const role = req.session?.role ?? 'unknown';
  if (body.override === true && role !== ADMIN_ROLE) {
    throw new ValidationError('override is only available to admin');
  }
  const override = body.override === true;
  const result = await provider.patchException(id, dimensionId, { status: body.status, approved_by: approvedBy, override });
  if (!result.ok) {
    if (result.status === 404) throw new NotFoundError(result.reason);
    res.status(409).json({ error: result.reason, gate: 'self-approval', confirmFlag: 'override' });
    return;
  }
  if (override) {
    logAuthz({
      decision: 'ALLOW', action: 'ApproveException.Override', sub: approvedBy, role, path: req.path,
      reason: `admin override of a self-approval refusal on ${id}/${dimensionId} (status=${body.status})`,
    });
  }
  res.json(result.exception);
}));

// Returns the lineage ledger — { team_id, items } — matching the portal's
// ProvenanceLedgerResponse (Evidence & Intake tab). Not a bare array: each
// row groups a capture event across however many evidence records it backs.
assessmentRouter.get('/teams/:id/provenance', viewGate, asyncHandler(async (req, res) => {
  const id = requireTeamId(req.params['id']);
  const ledger = await provider.getProvenance(id);
  if (!ledger) throw new NotFoundError(`team ${id} not found`);
  res.json(ledger);
}));

assessmentRouter.get('/teams/:id/scoring-logs', viewGate, asyncHandler(async (req, res) => {
  const id = requireTeamId(req.params['id']);
  const logs = await provider.listScoringLogs(id);
  if (!logs) throw new NotFoundError(`team ${id} not found`);
  res.json({ logs });
}));

assessmentRouter.get('/teams/:id/scoring-logs/:stamp', viewGate, asyncHandler(async (req, res) => {
  const id = requireTeamId(req.params['id']);
  const stamp = String(req.params['stamp'] ?? '');
  const log = await provider.getScoringLog(id, stamp);
  if (!log) throw new NotFoundError('scoring log not found');
  res.json(log);
}));

const INTAKE_TEXT_SOURCE_TYPES = new Set(['survey', 'transcript', 'document', 'artifact', 'touchpoint']);

assessmentRouter.post('/teams/:id/intake/text', scoreGate, asyncHandler(async (req, res) => {
  const id = requireTeamId(req.params['id']);
  const body = req.body as {
    dimension_id?: string | null; text?: string;
    source_type?: string; title?: string; captured_by?: string; captured_at?: string;
  };
  if (!body.text || typeof body.text !== 'string') throw new ValidationError('text is required');
  const sourceType = INTAKE_TEXT_SOURCE_TYPES.has(body.source_type ?? '')
    ? (body.source_type as 'survey' | 'transcript' | 'document' | 'artifact' | 'touchpoint')
    : undefined;
  const item = await provider.intakeText(id, {
    dimension_id: body.dimension_id ?? null, text: body.text, source_type: sourceType,
    title: body.title, captured_by: body.captured_by, captured_at: body.captured_at,
  });
  if (!item) throw new NotFoundError(`team ${id} not found`);
  res.status(201).json(item);
}));

assessmentRouter.post('/teams/:id/intake/image', scoreGate, asyncHandler(async (req, res) => {
  const id = requireTeamId(req.params['id']);
  const body = req.body as { dimension_id?: string | null; filename?: string };
  if (!body.filename || typeof body.filename !== 'string') throw new ValidationError('filename is required');
  const item = await provider.intakeImage(id, { dimension_id: body.dimension_id ?? null, filename: body.filename });
  if (!item) throw new NotFoundError(`team ${id} not found`);
  res.status(201).json(item);
}));

// The deterministic apply-scores seam: an agent's JSON output is validated
// and applied here — never written by the agent directly.
assessmentRouter.post('/teams/:id/scores/apply', scoreGate, asyncHandler(async (req, res) => {
  const id = requireTeamId(req.params['id']);
  const body = req.body as provider.ApplyScoresPayload;
  if (!Array.isArray(body?.scores)) throw new ValidationError('scores must be an array');
  if (!Array.isArray(body?.relevant_dimension_ids)) throw new ValidationError('relevant_dimension_ids must be an array');
  body.scores.forEach((entry, i) => {
    if (!isRecord(entry)) throw new ValidationError(`scores[${i}] must be an object`);
    if (entry['evidence_excerpts'] !== undefined && !Array.isArray(entry['evidence_excerpts'])) {
      throw new ValidationError(`scores[${i}].evidence_excerpts must be an array`);
    }
  });
  const result = await provider.applyScores(id, body, req.session?.sub);
  if (!result) throw new NotFoundError(`team ${id} not found`);
  res.json(result);
}));

assessmentRouter.post('/teams/:id/reset-assessment', scoreGate, asyncHandler(async (req, res) => {
  const id = requireTeamId(req.params['id']);
  const ok = await provider.resetAssessment(id);
  if (!ok) throw new NotFoundError(`team ${id} not found`);
  res.json({ ok: true });
}));

assessmentRouter.get('/teams/:id', viewGate, asyncHandler(async (req, res) => {
  const id = requireTeamId(req.params['id']);
  const detail = await provider.getTeamDetail(id);
  if (!detail) throw new NotFoundError(`team ${id} not found`);
  res.json(detail);
}));

assessmentRouter.patch('/teams/:id', scoreGate, asyncHandler(async (req, res) => {
  const id = requireTeamId(req.params['id']);
  const body = req.body as { name?: string; cohort?: Cohort; assessment_lead?: string; status?: string };
  // A bogus cohort or status here isn't just wrong on this team's card — every
  // caller of GET /rollup groups by cohort/status and throws on a value it
  // doesn't recognize, so one unvalidated PATCH could break the page for
  // everyone until the row was fixed by hand.
  if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
    throw new ValidationError('name must be a non-empty string');
  }
  if (body.cohort !== undefined && !VALID_COHORTS.includes(body.cohort)) {
    throw new ValidationError(`cohort must be one of ${VALID_COHORTS.join(', ')}`);
  }
  if (body.status !== undefined && !VALID_TEAM_STATUSES.has(body.status)) {
    throw new ValidationError(`status must be one of ${[...VALID_TEAM_STATUSES].join(', ')}`);
  }
  const team = await provider.patchTeam(id, body);
  if (!team) throw new NotFoundError(`team ${id} not found`);
  res.json(team);
}));

assessmentRouter.delete('/teams/:id', scoreGate, asyncHandler(async (req, res) => {
  const id = requireTeamId(req.params['id']);
  const ok = await provider.deleteTeam(id);
  if (!ok) throw new NotFoundError(`team ${id} not found`);
  res.json({ ok: true });
}));

// ─── Cross-team ─────────────────────────────────────────────────────────────

// One bulk read for the portfolio heatmap (ReportsPage's MaturityHeatmap) —
// replaces the N `GET /teams/:id` calls `useDimensionIndex` used to fire per
// team just to read each cell's verified/claimed level.
assessmentRouter.get('/dimension-index', viewGate, asyncHandler(async (_req, res) => {
  res.json(await provider.getDimensionIndex());
}));

assessmentRouter.get('/recommendations', viewGate, asyncHandler(async (req, res) => {
  const cohort = req.query['cohort'] as Cohort | undefined;
  res.json(await provider.listPortfolioRecommendations(cohort));
}));

assessmentRouter.get('/rollup', viewGate, asyncHandler(async (req, res) => {
  const cohort = req.query['cohort'] as Cohort | undefined;
  res.json(await provider.getRollup(cohort));
}));

// ─── Feedback (HITL) ────────────────────────────────────────────────────────

assessmentRouter.get('/feedback', viewGate, asyncHandler(async (req, res) => {
  const { status, team, kind } = req.query as { status?: string; team?: string; kind?: string };
  res.json({ tasks: await provider.listFeedback({ status, team, kind }) });
}));

assessmentRouter.post('/feedback', scoreGate, asyncHandler(async (req, res) => {
  const body = req.body as { team_id?: string | null; kind?: string; question?: string; dimension_id?: string | null };
  if (!body.question || typeof body.question !== 'string') throw new ValidationError('question is required');
  const task = await provider.createFeedback({ team_id: body.team_id ?? null, kind: body.kind ?? 'general', question: body.question, dimension_id: body.dimension_id ?? null });
  res.status(201).json(task);
}));

assessmentRouter.get('/feedback/:taskId', viewGate, asyncHandler(async (req, res) => {
  const task = await provider.getFeedbackTask(String(req.params['taskId']));
  if (!task) throw new NotFoundError('feedback task not found');
  res.json(task);
}));

assessmentRouter.post('/feedback/:taskId/resolve', scoreGate, asyncHandler(async (req, res) => {
  const body = req.body as { response?: string };
  if (!body.response || typeof body.response !== 'string') throw new ValidationError('response is required');
  const task = await provider.resolveFeedback(String(req.params['taskId']), body.response);
  if (!task) throw new NotFoundError('feedback task not found');
  res.json(task);
}));

assessmentRouter.post('/feedback/:taskId/dismiss', scoreGate, asyncHandler(async (req, res) => {
  const task = await provider.dismissFeedback(String(req.params['taskId']));
  if (!task) throw new NotFoundError('feedback task not found');
  res.json(task);
}));

// ─── Runs ───────────────────────────────────────────────────────────────────

const LAUNCHABLE_COMMANDS = new Set([
  'classify-transcript', 'score-dimensions', 'extract-enterprise-context', 'validate-outputs',
  'process-self-assessment', 'develop-jira-story', 'draft-confluence-page',
  'suggest-confluence-content', 'draw-diagram',
]);

assessmentRouter.get('/runs', viewGate, asyncHandler(async (req, res) => {
  const { command, team, status, limit } = req.query as { command?: string; team?: string; status?: string; limit?: string };
  const parsedLimit = limit ? parseInt(limit, 10) : undefined;
  res.json({ runs: await provider.listRuns({ command, team, status, limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined }) });
}));

// Launches the agent run — duplicate-guarded per (command, team) and capped
// at 3 concurrent, both enforced in the provider against the live ledger.
assessmentRouter.post('/runs', runGate, asyncHandler(async (req, res) => {
  const body = req.body as { command?: string; args?: Record<string, unknown>; team_id?: string | null };
  if (!body.command || !LAUNCHABLE_COMMANDS.has(body.command)) {
    throw new ValidationError(`command must be one of ${[...LAUNCHABLE_COMMANDS].join(', ')}`);
  }
  const teamId = body.team_id ?? null;
  if (teamId !== null && !isValidTeamId(teamId)) throw new ValidationError('team_id must match ^TEAM-[A-Za-z0-9-]+$');
  const result = await provider.launchRun(body.command, body.args ?? {}, teamId, req.session?.sub ?? null);
  if (!result.ok) { res.status(result.status).json({ error: result.reason }); return; }
  res.status(202).json({ run_id: result.run_id, started_at: result.started_at });
}));

// Every launchable command with the tool allowlist it runs under — shown,
// not hidden, because that allowlist is the security boundary.
assessmentRouter.get('/agent/commands', viewGate, asyncHandler(async (_req, res) => {
  res.json({ commands: await provider.listCommands() });
}));

assessmentRouter.post('/runs/:runId/stop', runGate, asyncHandler(async (req, res) => {
  const result = await provider.stopRun(String(req.params['runId']));
  if (!result.ok) { res.status(result.status).json({ error: result.reason }); return; }
  res.json(result.run);
}));

assessmentRouter.get('/runs/:runId', viewGate, asyncHandler(async (req, res) => {
  const run = await provider.getRun(String(req.params['runId']));
  if (!run) throw new NotFoundError('run not found');
  res.json(run);
}));

// POST /runs/:runId/complete is an AGENT CALLBACK, not a human-facing route:
// a deployed (or `agentcore dev`-run) orgiq-assessment-scorer hits this with
// no session when its command finishes, same shape as
// POST /api/observability/harness/trace (requireTraceAuth) and
// POST /api/observability/approvals/request (requireServiceAuth) — open when
// ASSESSMENT_RUN_COMPLETE_SECRET is unset (dev default), a constant-time
// header check when it's set. On the real Aurora path this is the ONLY way a
// launched run ever leaves `status: 'running'` (previously nothing called
// updateRunStatus outside of the operator-initiated /stop, so
// RUN_CONCURRENCY_CAP permanently exhausted after 3 real runs). The mock
// path accepts the same callback too — a locally-run agent can drive it
// directly instead of waiting on the fake 8s timer — without breaking that
// timer: completeRun's "must still be running" guard is the same one the
// timer's own completion closure already checks, so whichever finishes the
// run first wins and the other is a no-op 409.
//
// The compare itself is lib/service-auth.ts's — this was a private copy of it
// until 2026-09 (see that module's "ONE COMPARE, ONE PLACE"). Applied PER
// ROUTE, which is also why the requireTenant mount above has to skip this
// path: a blanket gate ahead of the router 401s the agent before this ever
// runs.
const requireRunCompleteAuth = requireServiceAuth(ASSESSMENT_RUN_COMPLETE_SERVICE_AUTH);

assessmentRouter.post('/runs/:runId/complete', requireRunCompleteAuth, asyncHandler(async (req, res) => {
  const runId = String(req.params['runId'] ?? '');
  const body = req.body as {
    status?: 'completed' | 'failed';
    summary?: string;
    error?: string;
    files_written?: unknown;
    scoring_log?: unknown;
  };
  if (body.status !== 'completed' && body.status !== 'failed') {
    throw new ValidationError('status must be "completed" or "failed"');
  }
  if (body.files_written !== undefined
    && (!Array.isArray(body.files_written) || !body.files_written.every((f) => typeof f === 'string'))) {
    throw new ValidationError('files_written must be an array of strings');
  }
  if (body.scoring_log !== undefined && !Array.isArray(body.scoring_log)) {
    throw new ValidationError('scoring_log must be an array');
  }
  const result = await provider.completeRun(runId, {
    status: body.status,
    ...(body.summary !== undefined && { summary: body.summary }),
    ...(body.error !== undefined && { error: body.error }),
    ...(body.files_written !== undefined && { files_written: body.files_written as string[] }),
    ...(body.scoring_log !== undefined && { scoring_log: body.scoring_log as ScoringLogEntry[] }),
  });
  if (!result.ok) { res.status(result.status).json({ error: result.reason }); return; }
  res.json(result.run);
}));

// ─── Reports ────────────────────────────────────────────────────────────────

// Publishing a report is a lead's call (PublishReport). Under mock this
// records the act — who, when, what the rollup said at that moment — rather
// than pushing to Confluence; the page's button pointed here and got a 404.
assessmentRouter.post('/reports/publish', requireAction('PublishReport'), asyncHandler(async (req, res) => {
  const rollup = await provider.getRollup();
  const record = {
    published_at: new Date().toISOString(),
    published_by: req.session?.sub ?? 'unknown',
    target_level: rollup.target_level,
    teams_total: rollup.teams_total,
    at_or_above_target: rollup.at_or_above_target,
    claims_open: rollup.claims_open,
  };
  res.status(201).json(record);
}));

// ─── Configuration ──────────────────────────────────────────────────────────

assessmentRouter.get('/configuration', viewGate, asyncHandler(async (_req, res) => {
  res.json(await provider.getConfiguration());
}));

// Every required key of MotionConfig (mock/assessment.ts), all strings, plus
// cohort restricted to the same set POST /teams accepts — the cast this
// replaced (`motions?: never`) let a shape mismatch sail through to
// the configuration fixture and break whatever page reads it back out.
function isValidMotion(m: unknown): m is MotionConfig {
  if (!isRecord(m)) return false;
  return VALID_COHORTS.includes(m['cohort'] as Cohort)
    && typeof m['title'] === 'string'
    && typeof m['tag'] === 'string'
    && typeof m['accent'] === 'string'
    && typeof m['description'] === 'string';
}

assessmentRouter.put('/configuration', configGate, asyncHandler(async (req, res) => {
  const body = req.body as { target_level?: number; motions?: unknown };
  if (body.target_level !== undefined
    && (typeof body.target_level !== 'number' || !Number.isInteger(body.target_level) || body.target_level < 0 || body.target_level > 5)) {
    throw new ValidationError('target_level must be an integer between 0 and 5');
  }
  if (body.motions !== undefined) {
    if (!Array.isArray(body.motions) || !body.motions.every(isValidMotion)) {
      throw new ValidationError('motions must be an array of {cohort, title, tag, accent, description}');
    }
  }
  res.json(await provider.updateConfiguration(body as { target_level?: number; motions?: MotionConfig[] }));
}));

// ─── Submissions ────────────────────────────────────────────────────────────

assessmentRouter.get('/submissions', viewGate, asyncHandler(async (_req, res) => {
  res.json(await provider.listSubmissions());
}));

assessmentRouter.post('/submissions/parse', submissionsGate, asyncHandler(async (req, res) => {
  const body = req.body as {
    rows?: Array<{ team_name_raw: string; team_id?: string }>;
    source_file?: string;
    records?: Array<Record<string, string>>;
  };

  // Legacy shape: a caller-classified row list (still exercised by
  // assessment-routes.test.ts / assessment-validation.test.ts).
  if (body.rows !== undefined) {
    if (!Array.isArray(body.rows)) throw new ValidationError('rows must be an array');
    body.rows.forEach((row, i) => {
      if (!isRecord(row) || typeof row['team_name_raw'] !== 'string') {
        throw new ValidationError(`rows[${i}] must be an object with a string team_name_raw`);
      }
    });
    res.json(await provider.parseSubmission({ rows: body.rows }));
    return;
  }

  // Real shape: the portal's DropStep parses the CSV client-side and posts
  // the header->value records for a Microsoft Forms export.
  if (!Array.isArray(body.records)) throw new ValidationError('records must be an array');
  body.records.forEach((record, i) => {
    if (!isRecord(record)) throw new ValidationError(`records[${i}] must be an object`);
  });
  res.json(await provider.parseSubmission({ source_file: body.source_file, records: body.records }));
}));

assessmentRouter.post('/submissions/commit', scoreGate, asyncHandler(async (req, res) => {
  const body = req.body as {
    team_id?: string;
    envelope_ids?: string[];
    staging_token?: string;
    selections?: Array<{ row_index: number; team_id: string }>;
  };

  // Real shape: commit a subset of a staged parse (see /submissions/parse).
  if (body.staging_token !== undefined || body.selections !== undefined) {
    if (typeof body.staging_token !== 'string' || !body.staging_token) {
      throw new ValidationError('staging_token is required');
    }
    if (!Array.isArray(body.selections) || body.selections.length === 0) {
      throw new ValidationError('selections must be a non-empty array');
    }
    body.selections.forEach((selection, i) => {
      if (!isRecord(selection) || typeof selection['row_index'] !== 'number') {
        throw new ValidationError(`selections[${i}] must include a numeric row_index`);
      }
      requireTeamId(selection['team_id']);
    });
    const result = await provider.commitSubmissions({ staging_token: body.staging_token, selections: body.selections });
    // A conflicting row means a concurrent commit already won the race for
    // that envelope_id (see commitSubmissions' atomic supersede+insert) —
    // a real "someone else already did this", not a validation failure, so
    // it's a 409 rather than the raw 500 an uncaught unique-violation used
    // to produce.
    if (result.results?.some((r) => r.conflict)) { res.status(409).json(result); return; }
    res.json(result);
    return;
  }

  // Legacy shape: commit already-staged envelope ids directly.
  const teamId = requireTeamId(body.team_id);
  if (!Array.isArray(body.envelope_ids) || body.envelope_ids.length === 0) {
    throw new ValidationError('envelope_ids must be a non-empty array');
  }
  res.json(await provider.commitSubmissions({ team_id: teamId, envelope_ids: body.envelope_ids }));
}));

assessmentRouter.post('/submissions/clear', submissionsGate, asyncHandler(async (req, res) => {
  const body = req.body as { targets?: Array<{ team_id: string; envelope_id: string }>; reset?: boolean };
  if (!Array.isArray(body.targets)) throw new ValidationError('targets must be an array');
  for (const t of body.targets) {
    if (!isRecord(t)) throw new ValidationError('each entry in targets must be an object');
    requireTeamId(t['team_id']);
  }
  res.json(await provider.clearSubmissions({ targets: body.targets, reset: body.reset }));
}));

// `dimension_id` alone can't identify every link — it's nullable on an
// unmatched link (see EnvelopeLink in mock/assessment.ts) — so the portal
// sends `url` too; either identifier is accepted (url takes precedence in
// the provider's matching) as long as one of them is present.
assessmentRouter.patch('/submissions/:team/:envelope/links', submissionsGate, asyncHandler(async (req, res) => {
  const teamId = requireTeamId(req.params['team']);
  const envelopeId = String(req.params['envelope'] ?? '');
  const body = req.body as { url?: string; dimension_id?: string | null; status?: 'fetched' | 'skipped' };
  if (body.status !== 'fetched' && body.status !== 'skipped') {
    throw new ValidationError('status ("fetched"|"skipped") is required');
  }
  const url = typeof body.url === 'string' && body.url ? body.url : undefined;
  const dimensionId = typeof body.dimension_id === 'string' && body.dimension_id ? body.dimension_id : undefined;
  if (!url && !dimensionId) {
    throw new ValidationError('at least one of url or dimension_id is required to identify the link');
  }
  const env = await provider.updateSubmissionLink(teamId, envelopeId, { url, dimension_id: dimensionId, status: body.status });
  if (!env) throw new NotFoundError('submission not found');
  res.json(env);
}));

assessmentRouter.get('/submissions/:team/:envelope', viewGate, asyncHandler(async (req, res) => {
  const teamId = requireTeamId(req.params['team']);
  const envelopeId = String(req.params['envelope'] ?? '');
  const env = await provider.getSubmissionDetail(teamId, envelopeId);
  if (!env) throw new NotFoundError('submission not found');
  res.json(env);
}));

assessmentRouter.delete('/submissions/:team/:envelope', submissionsGate, asyncHandler(async (req, res) => {
  const teamId = requireTeamId(req.params['team']);
  const envelopeId = String(req.params['envelope'] ?? '');
  const ok = await provider.deleteSubmission(teamId, envelopeId);
  if (!ok) throw new NotFoundError('submission not found');
  res.json({ ok: true });
}));

// ─── Knowledge ──────────────────────────────────────────────────────────────

assessmentRouter.get('/knowledge/tree', viewGate, asyncHandler(async (_req, res) => {
  res.json(await provider.getKnowledgeTree());
}));

// Alias of the knowledge tree for the workspace explorer page.
assessmentRouter.get('/workspace', viewGate, asyncHandler(async (_req, res) => {
  res.json(await provider.getKnowledgeTree());
}));

assessmentRouter.get('/knowledge/doc/versions', viewGate, asyncHandler(async (req, res) => {
  const id = String(req.query['id'] ?? '');
  if (!id) throw new ValidationError('id is required');
  const versions = await provider.getKnowledgeDocVersions(id);
  if (!versions) throw new NotFoundError('document not found');
  res.json({ versions });
}));

assessmentRouter.get('/knowledge/doc/version', viewGate, asyncHandler(async (req, res) => {
  const id = String(req.query['id'] ?? '');
  const stamp = String(req.query['stamp'] ?? '');
  if (!id || !stamp) throw new ValidationError('id and stamp are required');
  const version = await provider.getKnowledgeDocVersion(id, stamp);
  if (!version) throw new NotFoundError('version not found');
  res.json(version);
}));

assessmentRouter.post('/knowledge/doc/restore', knowledgeGate, asyncHandler(async (req, res) => {
  const body = req.body as { id?: string; stamp?: string };
  if (!body.id || !body.stamp) throw new ValidationError('id and stamp are required');
  const result = await provider.restoreKnowledgeDocVersion(body.id, body.stamp, req.session?.sub ?? 'unknown');
  if (!result) throw new NotFoundError('document or version not found');
  res.json(result);
}));

assessmentRouter.get('/knowledge/doc', viewGate, asyncHandler(async (req, res) => {
  const id = String(req.query['id'] ?? '');
  if (!id) throw new ValidationError('id is required');
  const doc = await provider.getKnowledgeDoc(id);
  if (!doc) throw new NotFoundError('document not found');
  res.json(doc);
}));

assessmentRouter.put('/knowledge/doc', knowledgeGate, asyncHandler(async (req, res) => {
  const body = req.body as { id?: string; markdown?: string; label?: string | null };
  if (!body.id || typeof body.markdown !== 'string') throw new ValidationError('id and markdown are required');
  const result = await provider.putKnowledgeDoc(body.id, body.markdown, {
    label: body.label ?? null, actor: req.session?.sub ?? 'unknown',
  });
  if (!result) throw new NotFoundError('document not found');
  res.json(result);
}));

// Reparents / reorders one node. This is what `TreeView`'s `onReorder` needs
// to exist for — the library has shipped drag-and-drop the whole time and had
// nowhere to put the result. Refuses a move inside a synced section, across
// sections, onto a leaf, or into the node's own subtree; each of those would
// leave the tree saying something untrue (see the provider for which).
assessmentRouter.post('/knowledge/doc/move', knowledgeGate, asyncHandler(async (req, res) => {
  const body = req.body as { id?: string; parentId?: string | null; position?: number };
  if (!body.id) throw new ValidationError('id is required');
  if (body.parentId !== null && typeof body.parentId !== 'string') {
    throw new ValidationError('parentId is required (null for the section root)');
  }
  if (typeof body.position !== 'number') throw new ValidationError('position is required');
  const result = await provider.moveKnowledgeNode(
    body.id, body.parentId, body.position, req.session?.sub ?? 'unknown',
  );
  if (!result.ok) { res.status(result.status).json({ error: result.reason }); return; }
  res.json(result);
}));

// Renames one node's display title. The id is a path that the doc, its
// versions, its comment channel and any shared URL all reference, so a rename
// deliberately does not touch it — see the provider.
assessmentRouter.post('/knowledge/doc/rename', knowledgeGate, asyncHandler(async (req, res) => {
  const body = req.body as { id?: string; title?: string };
  if (!body.id) throw new ValidationError('id is required');
  if (typeof body.title !== 'string') throw new ValidationError('title is required');
  const result = await provider.renameKnowledgeNode(body.id, body.title, req.session?.sub ?? 'unknown');
  if (!result.ok) { res.status(result.status).json({ error: result.reason }); return; }
  res.json(result);
}));

// Pushes one local doc up into the synced section — "publish" is always
// explicit, never implied by a save (docs/assessment-tenant.md "Workspace
// page"). Fires knowledge.published; the tree refetches once the portal sees
// the event.
assessmentRouter.post('/knowledge/doc/publish', knowledgeGate, asyncHandler(async (req, res) => {
  const body = req.body as { id?: string };
  if (!body.id) throw new ValidationError('id is required');
  const result = await provider.publishKnowledgeDoc(body.id, req.session?.sub ?? 'unknown');
  if (!result.ok) { res.status(result.status).json({ error: result.reason }); return; }
  res.status(202).json(result);
}));

// Kicks off a mock Confluence pull for one synced section. Responds
// immediately ("accepted") — the portal's Pull button watches GET /events
// for the matching knowledge.pulled to clear its pending state.
assessmentRouter.post('/knowledge/pull', knowledgeGate, asyncHandler(async (req, res) => {
  const body = req.body as { section?: string };
  if (!body.section) throw new ValidationError('section is required');
  const result = await provider.pullKnowledgeSection(body.section);
  if (!result.ok) { res.status(result.status).json({ error: result.reason }); return; }
  res.status(202).json({ ok: true });
}));

// Per-document comment. The thread itself lives in the realtime gateway's
// chat store (assessment:doc:<id> channel) — this is the server-side echo
// so GET /events carries it to viewers not currently on that channel.
// The thread on one document. There was an INSERT and no SELECT, so a comment
// was write-only: the pane rebuilt its thread from live echoes and the gateway
// channel, and with the gateway offline a reload lost it under a drawer saying
// "No comments on this document yet".
assessmentRouter.get('/knowledge/doc/comments', viewGate, asyncHandler(async (req, res) => {
  const id = String(req.query['id'] ?? '');
  if (!id) throw new ValidationError('id is required');
  const comments = await provider.listKnowledgeComments(id);
  if (!comments) throw new NotFoundError('document not found');
  res.json({ comments });
}));

// Reactions on a document and on its comments. Durable, unlike the realtime
// gateway's own reaction feature, which has no endpoint and no persistence —
// so with the gateway down a reaction could not reach anything at all.
assessmentRouter.get('/knowledge/doc/reactions', viewGate, asyncHandler(async (req, res) => {
  const id = String(req.query['id'] ?? '');
  if (!id) throw new ValidationError('id is required');
  const reactions = await provider.listKnowledgeReactions(id, req.session ? await documentCommentTargetIds(id, req.session) : []);
  if (!reactions) throw new NotFoundError('document not found');
  res.json({ reactions });
}));

assessmentRouter.post('/knowledge/doc/reaction', viewGate, asyncHandler(async (req, res) => {
  const body = req.body as { id?: string; targetId?: string; emoji?: string };
  if (!body.id) throw new ValidationError('id is required');
  if (!body.targetId) throw new ValidationError('targetId is required');
  if (typeof body.emoji !== 'string') throw new ValidationError('emoji is required');
  const result = await provider.toggleKnowledgeReaction(
    body.id, body.targetId, body.emoji, req.session?.sub ?? 'unknown',
    req.session ? await documentCommentTargetIds(body.id, req.session) : [],
  );
  if (!result.ok) { res.status(result.status).json({ error: result.reason }); return; }
  res.json(result);
}));

// Edit / remove one comment. Authorship comes from the SESSION, never the
// body, so a caller cannot change someone else's words by naming them. Delete
// is soft: the row keeps its place and the panel renders a tombstone, because
// a hard delete leaves a hole in a thread other people are reading.
assessmentRouter.patch('/knowledge/doc/comment', viewGate, asyncHandler(async (req, res) => {
  const body = req.body as { commentId?: string; body?: string };
  if (!body.commentId) throw new ValidationError('commentId is required');
  if (typeof body.body !== 'string') throw new ValidationError('body is required');
  const result = await provider.editKnowledgeComment(body.commentId, body.body, req.session?.sub ?? 'unknown');
  if (!result.ok) { res.status(result.status).json({ error: result.reason }); return; }
  res.json(result);
}));

assessmentRouter.delete('/knowledge/doc/comment', viewGate, asyncHandler(async (req, res) => {
  const body = req.body as { commentId?: string };
  if (!body.commentId) throw new ValidationError('commentId is required');
  const result = await provider.deleteKnowledgeComment(body.commentId, req.session?.sub ?? 'unknown');
  if (!result.ok) { res.status(result.status).json({ error: result.reason }); return; }
  res.json(result);
}));

assessmentRouter.post('/knowledge/doc/comment', viewGate, asyncHandler(async (req, res) => {
  const body = req.body as { id?: string; body?: string; parentId?: unknown };
  if (!body.id || !body.body || typeof body.body !== 'string') throw new ValidationError('id and body are required');
  if (body.parentId != null && (typeof body.parentId !== 'string' || !body.parentId.trim())) throw new ValidationError('Invalid reply parent');
  const result = await provider.createKnowledgeComment(body.id, body.body, req.session?.sub ?? 'unknown', (body.parentId as string | null | undefined) ?? null);
  if (!result) throw new NotFoundError('document not found');
  if (!result.ok && result.status === 409) { res.status(409).json({ error: result.reason, code: 'comments_moved' }); return; }
  if (!result.ok) throw new ValidationError(result.reason);
  res.status(201).json(result);
}));

// One tab announcing itself on one document — the piece that was missing
// for presence to work at all (see DocPane's useChannel(...).presence,
// which only ever LISTENED for a roster, never announced this viewer into
// one). Identity comes from the session, never the body, so a tab can't
// claim to be another user. The broker (assessment-broker.ts) keeps a
// per-doc, per-tab_id roster with a 45s TTL and publishes knowledge.presence
// only when the visible roster actually changes — DocPane calls this on
// open ('enter'), every 15s ('heartbeat'), and on unmount/pagehide
// ('leave', via navigator.sendBeacon since the page may be tearing down).
const PRESENCE_ACTIONS = new Set(['enter', 'heartbeat', 'leave']);

// `leave` arrives via navigator.sendBeacon during page teardown, which the
// browser may send as text/plain — express.json() leaves that body unparsed
// (undefined), and reading `.doc_id` off it was a 500 on every tab close.
// Accept both encodings here and fail as a 400, never a TypeError.
assessmentRouter.post('/knowledge/presence', viewGate, express.text({ type: 'text/plain' }), asyncHandler(async (req, res) => {
  const raw: unknown = req.body;
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { throw new ValidationError('presence body must be JSON'); }
  }
  if (!isRecord(parsed)) throw new ValidationError('presence body must be a JSON object');
  const body = parsed as { doc_id?: string; tab_id?: string; action?: string; sequence?: number };
  if (!body.doc_id || typeof body.doc_id !== 'string') throw new ValidationError('doc_id is required');
  if (!body.tab_id || typeof body.tab_id !== 'string') throw new ValidationError('tab_id is required');
  if (!body.action || !PRESENCE_ACTIONS.has(body.action)) {
    throw new ValidationError(`action must be one of ${[...PRESENCE_ACTIONS].join(', ')}`);
  }
  if (body.sequence !== undefined && (!Number.isSafeInteger(body.sequence) || body.sequence < 0)) throw new ValidationError('sequence must be a nonnegative safe integer');
  const sub = req.session?.sub ?? 'unknown';
  const name = req.session?.name ?? sub;
  if (body.action === 'leave') {
    assessmentBroker.leave(body.doc_id, body.tab_id, Date.now(), body.sequence);
  } else {
    assessmentBroker.touch(body.doc_id, body.tab_id, sub, name, Date.now(), body.sequence);
  }
  res.status(204).end();
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /events — Long-lived SSE stream of assessment lifecycle events
// (knowledge pull/publish/save/comment/presence, agent run started/progress/
// completed/failed). Mirrors canary.ts's /events exactly, plus Last-Event-ID
// catch-up: a reconnecting EventSource sends back the last `id:` line it saw.
//
// Fixed for DEFECTS #5 (assessor) / #8 (lead-assessor) / #7 (program-lead,
// admin): a FRESH tab (no prior connection, so no Last-Event-ID header at
// all) used to get `assessmentBroker.replay(undefined)` — the whole ring
// buffer, unconditionally, no matter how old its contents — which is how a
// brand-new tab was told about a save from 101 minutes ago as if it just
// happened. `assessmentBroker.catchUp` (assessment-broker.ts's `decideReplay`)
// replaces that: no Last-Event-ID means no history at all, only what's
// published live from here on; a genuine reconnect (Last-Event-ID present)
// still gets its gap filled in, but bounded by `REPLAY_MAX_AGE_MS` — a
// buffer sized by event count, not age, can otherwise hold something from
// hours ago on a quiet tenant. Either kind of drop (ring-buffer eviction or
// the age bound) is surfaced to the client as a `stream.gap` frame.
// ─────────────────────────────────────────────────────────────────────────────

assessmentRouter.get('/events', viewGate, (req, res) => {
  initSSE(res);
  const lastEventId = req.headers['last-event-id'];
  // Frame ids are `<epoch>-<seq>`; an id from a previous process life is
  // not a valid floor and is treated the same as no Last-Event-ID at all
  // (see broker) — a fresh start, not a catch-up.
  const afterSeq = assessmentBroker.afterSeqFromLastEventId(typeof lastEventId === 'string' ? lastEventId : undefined);
  const { events, gapped } = assessmentBroker.catchUp(afterSeq);
  if (gapped) {
    const gap = assessmentBroker.gapFrame();
    writeSSE(res, gap.event, gap.id);
  }
  for (const { seq, event } of events) {
    writeSSE(res, event, assessmentBroker.frameId(seq));
  }
  const unsubscribe = assessmentBroker.subscribe(({ seq, event }) => writeSSE(res, event, assessmentBroker.frameId(seq)));
  req.on('close', () => {
    unsubscribe();
    endSSE(res);
  });
});
