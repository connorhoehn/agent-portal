// Assessment tenant — Aurora-backed persistence primitives.
//
// This module is deliberately "dumb": it maps rows to/from the exact
// interfaces mock/assessment.ts already defines (MockTeam, MockDimensionScore,
// TeamException, MockRun, FeedbackTask, ScoringLog, AssessmentConfiguration,
// EvidenceLogItem, Provenance) so the pure logic in providers/assessment.ts
// (certification, applyScores validation, provenance-ledger assembly,
// recommendation classification) runs unchanged whether it was fed mock
// fixtures or Aurora rows. Orchestration (which queries to run, in what order,
// and when to call the shared pure helpers) stays in providers/assessment.ts;
// this file only issues SQL and maps rows.
//
// Schema: schema/assessment_schema.sql. Every statement is parameterized
// (RDS Data API named params, never string interpolation of caller input).
// ⚠️ None of this SQL has been run against a live Aurora cluster — there is
// no reachable database in this environment. It is typed, mirrors the
// existing aurora.ts / budgets.ts conventions exactly, and is covered by
// jest tests that assert on the SQL text and row-mapping, but the only real
// verification will be the first live call.

import { exec as rawExec, withTransaction, type TxExec } from './aurora.js';
import { AsyncLocalStorage } from 'node:async_hooks';

// A completion owns one transaction across all assessment persistence helpers.
// Async-local context isolates concurrent requests without a global executor.
const transactionContext = new AsyncLocalStorage<TxExec>();
const exec: TxExec = (sql, params) => (transactionContext.getStore() ?? rawExec)(sql, params);

async function withAssessmentTransaction<T>(work: () => Promise<T>): Promise<T> {
  if (transactionContext.getStore()) return work();
  return withTransaction(async tx => {
    // Data API rejects overlapping statements on one transaction.
    let pending: Promise<unknown> = Promise.resolve();
    const serial: TxExec = (sql, params) => {
      const result = pending.then(() => tx(sql, params));
      pending = result;
      return result;
    };
    return transactionContext.run(serial, work);
  });
}

export async function withRunTransaction<T>(runId: string, work: () => Promise<T>): Promise<T> {
  return withAssessmentTransaction(async () => {
    await exec('SELECT id FROM assessment_runs WHERE id = :id FOR UPDATE', [{ name: 'id', value: { stringValue: runId } }]);
    return work();
  });
}

export async function withTeamTransaction<T>(teamId: string, work: () => Promise<T>): Promise<T> {
  return withAssessmentTransaction(async () => {
    await exec('SELECT id FROM assessment_teams WHERE id = :id FOR UPDATE', [{ name: 'id', value: { stringValue: teamId } }]);
    return work();
  });
}
import { type SqlParameter } from '@aws-sdk/client-rds-data';
import * as M from '../mock/assessment.js';
import type { ApplyScoreInput, AppliedScore, ApplyScoresPayload } from './assessment.js';

// ─── Param + row helpers (same shapes as budgets.ts / aurora.ts) ───────────

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function nul(name: string): SqlParameter { return { name, value: { isNull: true } }; }
function maybe(name: string, v: string | null | undefined): SqlParameter { return v == null || v === '' ? nul(name) : s(name, v); }
function int(name: string, v: number): SqlParameter { return { name, value: { longValue: v } }; }
function maybeInt(name: string, v: number | null | undefined): SqlParameter { return v == null ? nul(name) : int(name, v); }
function bool(name: string, v: boolean): SqlParameter { return { name, value: { booleanValue: v } }; }
function jsonp(name: string, v: unknown): SqlParameter { return { name, value: { stringValue: JSON.stringify(v ?? null) } }; }
function arrp(name: string, v: string[]): SqlParameter { return { name, value: { arrayValue: { stringValues: v } } }; }

function toStr(v: unknown, f = ''): string { return v === null || v === undefined ? f : String(v); }
function toNum(v: unknown, f = 0): number { const n = Number(v); return Number.isFinite(n) ? n : f; }
function toBool(v: unknown): boolean { return v === true || v === 't' || v === 'true'; }
function toStrOrNull(v: unknown): string | null { return v === null || v === undefined ? null : String(v); }
function toStrArr(v: unknown): string[] { return Array.isArray(v) ? v.map(String) : []; }
function parseJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  try { return JSON.parse(String(v)) as T; } catch { return fallback; }
}

function emptyDimensionScore(dimensionId: string): M.MockDimensionScore {
  return {
    dimension_id: dimensionId, current_level: null, is_na: false, confidence: 'low',
    self_claimed_level: null, evidence_class: null, cap_applied: false,
    evidence: [], follow_up_questions: [], history: [], updated_at: new Date().toISOString(),
  };
}

// ─── Teams ──────────────────────────────────────────────────────────────────

const TEAM_COLUMNS = `id, name, cohort, status, workflow_step, assessment_lead, contacts, repos, contributors,
       archetype, rubric_version, created_at::text AS created_at, updated_at::text AS updated_at`;

function rowToException(r: Record<string, unknown>): M.TeamException {
  return {
    dimension_id: toStr(r['dimension_id']),
    status: toStr(r['status']) as M.ExceptionStatus,
    source: toStr(r['source']) as M.ExceptionSource,
    reason: toStr(r['reason']),
    approved_by: toStr(r['approved_by']),
    approved_at: r['approved_at'] == null ? '' : toStr(r['approved_at']),
    requested_by: r['requested_by'] == null ? undefined : toStr(r['requested_by']),
  };
}

function rowToTeam(r: Record<string, unknown>, exceptions: M.TeamException[]): M.MockTeam {
  return {
    id: toStr(r['id']),
    name: toStr(r['name']),
    cohort: toStr(r['cohort']) as M.Cohort,
    status: toStr(r['status']),
    workflow_step: toNum(r['workflow_step'], 1),
    assessment_lead: toStr(r['assessment_lead']),
    contacts: toStrArr(r['contacts']),
    repos: parseJson<M.RepoRef[]>(r['repos'], []),
    archetype: toStrOrNull(r['archetype']),
    // The column is NOT NULL DEFAULT 'v1', so a real row always has one; the
    // fallback is for a row read back from a database patched before the
    // column existed, which must not silently become an empty rubric name.
    rubric_version: r['rubric_version'] == null ? M.DEFAULT_RUBRIC_VERSION : toStr(r['rubric_version']),
    exceptions,
    created_at: toStr(r['created_at']),
    updated_at: toStr(r['updated_at']),
    contributors: parseJson<{ initials: string; name: string; avatarUrl?: string | null }[]>(r['contributors'], []),
  };
}

export async function teamExists(id: string): Promise<boolean> {
  const rows = await exec(`SELECT 1 AS x FROM assessment_teams WHERE id = :id`, [s('id', id)]);
  return rows.length > 0;
}

export async function fetchExceptions(teamId: string): Promise<M.TeamException[]> {
  const rows = await exec(
    `SELECT dimension_id, status, source, reason, approved_by, approved_at::text AS approved_at, requested_by
       FROM assessment_team_exceptions WHERE team_id = :tid`,
    [s('tid', teamId)],
  );
  return rows.map(rowToException);
}

/** Fetches the single 'requested' exception for (team, dimension), or null —
 * used by patchException to check `requested_by` BEFORE mutating, so the
 * self-approval refusal (finding: never the assessor who proposed it) can
 * happen without a write. */
export async function fetchRequestedException(teamId: string, dimensionId: string): Promise<M.TeamException | null> {
  const rows = await exec(
    `SELECT dimension_id, status, source, reason, approved_by, approved_at::text AS approved_at, requested_by
       FROM assessment_team_exceptions WHERE team_id = :tid AND dimension_id = :did AND status = 'requested'`,
    [s('tid', teamId), s('did', dimensionId)],
  );
  return rows.length ? rowToException(rows[0]!) : null;
}

export async function fetchTeam(id: string): Promise<M.MockTeam | null> {
  const rows = await exec(`SELECT ${TEAM_COLUMNS} FROM assessment_teams WHERE id = :id`, [s('id', id)]);
  if (rows.length === 0) return null;
  const exceptions = await fetchExceptions(id);
  return rowToTeam(rows[0]!, exceptions);
}

export async function fetchAllTeams(): Promise<M.MockTeam[]> {
  const [teamRows, excRows] = await Promise.all([
    exec(`SELECT ${TEAM_COLUMNS} FROM assessment_teams ORDER BY id`),
    exec(`SELECT team_id, dimension_id, status, source, reason, approved_by, approved_at::text AS approved_at, requested_by
            FROM assessment_team_exceptions`),
  ]);
  const excByTeam = new Map<string, M.TeamException[]>();
  for (const r of excRows) {
    const tid = toStr(r['team_id']);
    const list = excByTeam.get(tid) ?? [];
    list.push(rowToException(r));
    excByTeam.set(tid, list);
  }
  return teamRows.map((r) => rowToTeam(r, excByTeam.get(toStr(r['id'])) ?? []));
}

export async function nextTeamId(): Promise<string> {
  const rows = await exec(`SELECT id FROM assessment_teams`);
  const maxNum = Math.max(0, ...rows.map((r) => parseInt(toStr(r['id']).replace('TEAM-', ''), 10) || 0));
  return `TEAM-${String(maxNum + 1).padStart(3, '0')}`;
}

export async function createTeamRow(input: { id: string; name: string; cohort: M.Cohort; assessment_lead: string }): Promise<M.MockTeam> {
  await exec(
    `INSERT INTO assessment_teams (id, name, cohort, status, workflow_step, assessment_lead, contacts, repos, contributors, archetype)
     VALUES (:id, :name, :cohort, 'NEW', 1, :lead, '{}', '[]'::jsonb, '[]'::jsonb, NULL)`,
    [s('id', input.id), s('name', input.name), s('cohort', input.cohort), s('lead', input.assessment_lead)],
  );
  const team = await fetchTeam(input.id);
  return team!;
}

export async function patchTeamRow(
  id: string, patch: { name?: string; cohort?: M.Cohort; assessment_lead?: string; status?: string },
): Promise<M.MockTeam | null> {
  const existing = await fetchTeam(id);
  if (!existing) return null;
  await exec(
    `UPDATE assessment_teams
        SET name = :name, cohort = :cohort, assessment_lead = :lead, status = :status, updated_at = NOW()
      WHERE id = :id`,
    [
      s('id', id), s('name', patch.name ?? existing.name), s('cohort', patch.cohort ?? existing.cohort),
      s('lead', patch.assessment_lead ?? existing.assessment_lead),
      // `M.MockTeam.status` is optional now — every read derives it with
      // deriveTeamStatus — but the column is NOT NULL, so keep writing it.
      s('status', patch.status ?? existing.status ?? 'NEW'),
    ],
  );
  return fetchTeam(id);
}

export async function deleteTeamRow(id: string): Promise<boolean> {
  const rows = await exec(`DELETE FROM assessment_teams WHERE id = :id RETURNING id`, [s('id', id)]);
  return rows.length > 0;
}

/**
 * Resets scoring only. Evidence rows are left alone — mirrors the mock's
 * "evidence/lineage are untouched by a reset" comment (providers/assessment.ts
 * resetAssessment) — follow-ups and history are cleared, and any OPEN
 * feedback task for the team is dismissed.
 */
export async function resetTeamAssessment(id: string): Promise<boolean> {
  if (!(await teamExists(id))) return false;
  await exec(
    `UPDATE assessment_dimension_scores
        SET current_level = NULL, is_na = FALSE, confidence = 'low', self_claimed_level = NULL,
            evidence_class = NULL, cap_applied = FALSE, updated_at = NOW()
      WHERE team_id = :id`,
    [s('id', id)],
  );
  await exec(`DELETE FROM assessment_follow_up_questions WHERE team_id = :id`, [s('id', id)]);
  await exec(`DELETE FROM assessment_dimension_history WHERE team_id = :id`, [s('id', id)]);
  await exec(
    `UPDATE assessment_teams SET status = 'NEW', workflow_step = 1, updated_at = NOW() WHERE id = :id`,
    [s('id', id)],
  );
  await exec(
    `UPDATE assessment_feedback_tasks SET status = 'DISMISSED', resolved_at = NOW()
      WHERE team_id = :id AND status = 'OPEN'`,
    [s('id', id)],
  );
  return true;
}

export async function patchExceptionRow(
  teamId: string, dimensionId: string, patch: { status: 'approved' | 'denied'; approved_by: string },
): Promise<M.TeamException | null> {
  const rows = await exec(
    `UPDATE assessment_team_exceptions
        SET status = :status, approved_by = :by, approved_at = NOW()
      WHERE team_id = :tid AND dimension_id = :did AND status = 'requested'
      RETURNING dimension_id, status, source, reason, approved_by, approved_at::text AS approved_at, requested_by`,
    [s('status', patch.status), s('by', patch.approved_by), s('tid', teamId), s('did', dimensionId)],
  );
  return rows.length ? rowToException(rows[0]!) : null;
}

export async function touchTeamUpdatedAt(teamId: string, at: string): Promise<void> {
  await exec(`UPDATE assessment_teams SET updated_at = :at::timestamptz WHERE id = :id`, [s('at', at), s('id', teamId)]);
}

/** Writes the team's workflow status (M.deriveTeamStatus's output — always
 * NEW/IN_PROGRESS/ASSESSED) along with updated_at in one statement. Unlike
 * assessment_submissions.status, assessment_teams.status carries no CHECK
 * constraint, so this is a plain write, not a projection. */
export async function updateTeamStatus(teamId: string, status: string, at: string): Promise<void> {
  await exec(
    `UPDATE assessment_teams SET status = :status, updated_at = :at::timestamptz WHERE id = :id`,
    [s('status', status), s('at', at), s('id', teamId)],
  );
}

// ─── Dimension scores / evidence / follow-ups / history ────────────────────

function rowToEvidence(r: Record<string, unknown>): M.Evidence {
  return {
    evidence_id: toStr(r['evidence_id']), dimension_id: toStr(r['dimension_id']),
    source_type: toStr(r['source_type']) as M.EvidenceSourceType, excerpt: toStr(r['excerpt']),
    supports_level: r['supports_level'] == null ? null : toNum(r['supports_level']),
    captured_at: toStr(r['captured_at']), source_ref: toStr(r['source_ref']),
    scored: toBool(r['scored']), status: toStr(r['status']) as M.EvidenceStatus,
  };
}

function rowToEvidenceLogItem(r: Record<string, unknown>): M.EvidenceLogItem {
  return {
    evidence_id: toStr(r['evidence_id']), dimension_id: toStrOrNull(r['dimension_id']),
    source_type: toStr(r['source_type']) as M.EvidenceSourceType, excerpt: toStr(r['excerpt']),
    supports_level: r['supports_level'] == null ? null : toNum(r['supports_level']),
    captured_at: toStr(r['captured_at']), source_ref: toStr(r['source_ref']),
    scored: toBool(r['scored']), status: toStr(r['status']) as M.EvidenceStatus,
    title: r['title'] == null ? undefined : toStr(r['title']),
    captured_by: r['captured_by'] == null ? undefined : toStr(r['captured_by']),
  };
}

function rowToFollowUp(r: Record<string, unknown>): M.FollowUpQuestion {
  return {
    question_id: toStr(r['question_id']), dimension_id: toStr(r['dimension_id']), text: toStr(r['text']),
    target_audience: toStr(r['target_audience']), status: toStr(r['status']) as M.FollowUpStatus,
  };
}

function rowToHistory(r: Record<string, unknown>): M.DimensionHistoryEntry {
  return {
    from_level: r['from_level'] == null ? null : toNum(r['from_level']),
    to_level: r['to_level'] == null ? null : toNum(r['to_level']),
    is_na: toBool(r['is_na']),
    rationale: toStr(r['rationale']),
    evidence_ids: toStrArr(r['evidence_ids']),
    source_meeting: toStr(r['source_meeting']),
    changed_at: toStr(r['changed_at']),
    changed_by: toStr(r['changed_by']),
    na_claimed: toBool(r['na_claimed']),
  };
}

function groupIntoDimScores(
  scoreRows: Record<string, unknown>[], evidenceRows: Record<string, unknown>[],
  followupRows: Record<string, unknown>[], historyRows: Record<string, unknown>[],
): Map<string, Record<string, M.MockDimensionScore>> {
  const out = new Map<string, Record<string, M.MockDimensionScore>>();
  const ensure = (tid: string, did: string): M.MockDimensionScore => {
    let byTeam = out.get(tid);
    if (!byTeam) { byTeam = {}; out.set(tid, byTeam); }
    let score = byTeam[did];
    if (!score) { score = emptyDimensionScore(did); byTeam[did] = score; }
    return score;
  };
  for (const r of scoreRows) {
    const score = ensure(toStr(r['team_id']), toStr(r['dimension_id']));
    score.current_level = r['current_level'] == null ? null : toNum(r['current_level']);
    score.is_na = toBool(r['is_na']);
    score.confidence = toStr(r['confidence'], 'low') as M.Confidence;
    score.self_claimed_level = r['self_claimed_level'] == null ? null : toNum(r['self_claimed_level']);
    score.evidence_class = r['evidence_class'] == null ? null : (toStr(r['evidence_class']) as M.EvidenceClass);
    score.cap_applied = toBool(r['cap_applied']);
    score.updated_at = toStr(r['updated_at']);
  }
  for (const r of evidenceRows) {
    if (r['dimension_id'] == null) continue;
    ensure(toStr(r['team_id']), toStr(r['dimension_id'])).evidence.push(rowToEvidence(r));
  }
  for (const r of followupRows) {
    ensure(toStr(r['team_id']), toStr(r['dimension_id'])).follow_up_questions.push(rowToFollowUp(r));
  }
  for (const r of historyRows) {
    ensure(toStr(r['team_id']), toStr(r['dimension_id'])).history.push(rowToHistory(r));
  }
  return out;
}

const SCORE_COLS = 'team_id, dimension_id, current_level, is_na, confidence, self_claimed_level, evidence_class, cap_applied, updated_at::text AS updated_at';
const EVIDENCE_COLS = 'evidence_id, team_id, dimension_id, source_type, excerpt, supports_level, captured_at::text AS captured_at, source_ref, scored, status';
const FOLLOWUP_COLS = 'question_id, team_id, dimension_id, text, target_audience, status';
const HISTORY_COLS = 'team_id, dimension_id, from_level, to_level, is_na, na_claimed, rationale, evidence_ids, source_meeting, changed_at::text AS changed_at, changed_by';

export async function fetchDimensionScores(teamId: string): Promise<Record<string, M.MockDimensionScore>> {
  const [scoreRows, evidenceRows, followupRows, historyRows] = await Promise.all([
    exec(`SELECT ${SCORE_COLS} FROM assessment_dimension_scores WHERE team_id = :tid`, [s('tid', teamId)]),
    exec(`SELECT ${EVIDENCE_COLS} FROM assessment_evidence WHERE team_id = :tid AND scored = TRUE AND dimension_id IS NOT NULL`, [s('tid', teamId)]),
    exec(`SELECT ${FOLLOWUP_COLS} FROM assessment_follow_up_questions WHERE team_id = :tid`, [s('tid', teamId)]),
    exec(`SELECT ${HISTORY_COLS} FROM assessment_dimension_history WHERE team_id = :tid ORDER BY id ASC`, [s('tid', teamId)]),
  ]);
  const grouped = groupIntoDimScores(scoreRows, evidenceRows, followupRows, historyRows);
  return grouped.get(teamId) ?? {};
}

/** Bulk variant for cross-team reads (getRollup, listPortfolioRecommendations). */
export async function fetchAllDimensionScores(): Promise<Map<string, Record<string, M.MockDimensionScore>>> {
  const [scoreRows, evidenceRows, followupRows, historyRows] = await Promise.all([
    exec(`SELECT ${SCORE_COLS} FROM assessment_dimension_scores`),
    exec(`SELECT ${EVIDENCE_COLS} FROM assessment_evidence WHERE scored = TRUE AND dimension_id IS NOT NULL`),
    exec(`SELECT ${FOLLOWUP_COLS} FROM assessment_follow_up_questions`),
    exec(`SELECT ${HISTORY_COLS} FROM assessment_dimension_history ORDER BY id ASC`),
  ]);
  return groupIntoDimScores(scoreRows, evidenceRows, followupRows, historyRows);
}

export async function fetchEvidenceLog(teamId: string): Promise<M.EvidenceLogItem[]> {
  const rows = await exec(
    `SELECT evidence_id, dimension_id, source_type, excerpt, supports_level, captured_at::text AS captured_at,
            source_ref, scored, status, title, captured_by
       FROM assessment_evidence WHERE team_id = :tid AND scored = FALSE ORDER BY captured_at ASC`,
    [s('tid', teamId)],
  );
  return rows.map(rowToEvidenceLogItem);
}

export async function upsertDimensionScore(teamId: string, score: M.MockDimensionScore): Promise<void> {
  await exec(
    `INSERT INTO assessment_dimension_scores (team_id, dimension_id, current_level, is_na, confidence, self_claimed_level, evidence_class, cap_applied, updated_at)
     VALUES (:tid, :did, :level, :is_na, :confidence, :self, :eclass, :cap, :updated::timestamptz)
     ON CONFLICT (team_id, dimension_id) DO UPDATE SET
       current_level = EXCLUDED.current_level, is_na = EXCLUDED.is_na, confidence = EXCLUDED.confidence,
       self_claimed_level = EXCLUDED.self_claimed_level, evidence_class = EXCLUDED.evidence_class,
       cap_applied = EXCLUDED.cap_applied, updated_at = EXCLUDED.updated_at`,
    [
      s('tid', teamId), s('did', score.dimension_id), maybeInt('level', score.current_level),
      bool('is_na', score.is_na), s('confidence', score.confidence), maybeInt('self', score.self_claimed_level),
      score.evidence_class == null ? nul('eclass') : s('eclass', score.evidence_class),
      bool('cap', score.cap_applied), s('updated', score.updated_at),
    ],
  );
}

export async function insertEvidenceRow(teamId: string, ev: M.Evidence): Promise<void> {
  await exec(
    `INSERT INTO assessment_evidence (evidence_id, team_id, dimension_id, source_type, excerpt, supports_level, captured_at, source_ref, scored, status)
     VALUES (:id, :tid, :did, :stype, :excerpt, :level, :captured::timestamptz, :ref, :scored, :status)`,
    [
      s('id', ev.evidence_id), s('tid', teamId), s('did', ev.dimension_id), s('stype', ev.source_type),
      s('excerpt', ev.excerpt), maybeInt('level', ev.supports_level), s('captured', ev.captured_at),
      s('ref', ev.source_ref), bool('scored', ev.scored), s('status', ev.status),
    ],
  );
}

export async function insertEvidenceLogItem(teamId: string, item: M.EvidenceLogItem): Promise<void> {
  await exec(
    `INSERT INTO assessment_evidence (evidence_id, team_id, dimension_id, source_type, excerpt, supports_level, captured_at, source_ref, scored, status, title, captured_by)
     VALUES (:id, :tid, :did, :stype, :excerpt, :level, :captured::timestamptz, :ref, FALSE, :status, :title, :by)`,
    [
      s('id', item.evidence_id), s('tid', teamId), maybe('did', item.dimension_id), s('stype', item.source_type),
      s('excerpt', item.excerpt), maybeInt('level', item.supports_level), s('captured', item.captured_at),
      s('ref', item.source_ref), s('status', item.status), maybe('title', item.title ?? null), maybe('by', item.captured_by ?? null),
    ],
  );
}

export async function insertFollowUpRow(teamId: string, fu: M.FollowUpQuestion): Promise<void> {
  await exec(
    `INSERT INTO assessment_follow_up_questions (question_id, team_id, dimension_id, text, target_audience, status)
     VALUES (:id, :tid, :did, :text, :aud, :status)`,
    [s('id', fu.question_id), s('tid', teamId), s('did', fu.dimension_id), s('text', fu.text), s('aud', fu.target_audience), s('status', fu.status)],
  );
}

export async function insertHistoryRow(teamId: string, dimensionId: string, entry: M.DimensionHistoryEntry): Promise<void> {
  await exec(
    `INSERT INTO assessment_dimension_history (team_id, dimension_id, from_level, to_level, is_na, na_claimed, rationale, evidence_ids, source_meeting, changed_at, changed_by)
     VALUES (:tid, :did, :from, :to, :is_na, :na_claimed, :rationale, :evidence_ids, :meeting, :changed::timestamptz, :by)`,
    [
      s('tid', teamId), s('did', dimensionId), maybeInt('from', entry.from_level), maybeInt('to', entry.to_level),
      bool('is_na', entry.is_na), bool('na_claimed', !!entry.na_claimed), s('rationale', entry.rationale),
      arrp('evidence_ids', entry.evidence_ids), s('meeting', entry.source_meeting), s('changed', entry.changed_at), s('by', entry.changed_by),
    ],
  );
}

export async function requestExceptionRow(
  teamId: string, dimensionId: string, reason: string, requestedBy?: string | null,
): Promise<void> {
  await exec(
    `INSERT INTO assessment_team_exceptions (team_id, dimension_id, status, source, reason, approved_by, approved_at, requested_by)
     VALUES (:tid, :did, 'requested', 'manual', :reason, '', NULL, :requested_by)
     ON CONFLICT (team_id, dimension_id) DO UPDATE SET
       status = 'requested', source = 'manual', reason = EXCLUDED.reason, approved_by = '', approved_at = NULL,
       requested_by = EXCLUDED.requested_by`,
    [s('tid', teamId), s('did', dimensionId), s('reason', reason), maybe('requested_by', requestedBy ?? null)],
  );
}

// ─── applyScores — DB orchestration around the shared pure validator ───────
//
// The validation + per-entry compute logic (dimension id / confidence /
// evidence_class checks, the self-rating cap, N/A-never-self-granting) is
// NOT duplicated here — `computeEntry` is the exact same function
// providers/assessment.ts's mock-path applyScores uses, passed in as a
// parameter so this module never needs a (circular) value import of
// assessment.ts. This file only decides what to persist once a per-entry
// result comes back.
//
// Not wrapped in an explicit RDS Data API transaction — this loop's writes
// are a good deal more numerous and heterogeneous (score/evidence/followup/
// history/exception, up to 17 dimensions) than the two-statement supersede-
// then-insert `withTransaction` now wraps for commitSubmissions below, and a
// mid-loop failure here leaves a partial application, same class of risk
// already accepted elsewhere (budgets.ts, bots.ts, agent-jobs.ts all issue
// sequential autocommit statements too).

type ScoreComputationResult = {
  newScore: M.MockDimensionScore;
  historyEntry: M.DimensionHistoryEntry;
  newEvidence: M.Evidence[];
  newFollowups: M.FollowUpQuestion[];
  applied: AppliedScore;
  exceptionToRequest: { dimension_id: string; reason: string; requested_by?: string } | null;
};

export type ComputeScoreEntryFn = (
  entry: ApplyScoreInput,
  relevant: Set<string>,
  current: M.MockDimensionScore,
  hasApprovedException: boolean,
  hasRequestedException: boolean,
  now: string,
  teamId: string,
  requestedBy?: string,
) => { ok: false; reason: string } | { ok: true; result: ScoreComputationResult };

export async function auroraApplyScores(
  teamId: string,
  payload: ApplyScoresPayload,
  computeEntry: ComputeScoreEntryFn,
  requestedBy?: string,
): Promise<{ applied: AppliedScore[]; rejected: { dimension_id: string; reason: string }[] } | null> {
  const team = await fetchTeam(teamId);
  if (!team) return null;
  const dims = await fetchDimensionScores(teamId);
  const relevant = new Set(payload.relevant_dimension_ids ?? []);
  const applied: AppliedScore[] = [];
  const rejected: { dimension_id: string; reason: string }[] = [];
  const now = new Date().toISOString();
  let touched = false;

  for (const entry of payload.scores ?? []) {
    const current = dims[entry.dimension_id] ?? emptyDimensionScore(entry.dimension_id);
    const hasApproved = team.exceptions.some((e) => e.dimension_id === entry.dimension_id && e.status === 'approved');
    const hasRequested = team.exceptions.some((e) => e.dimension_id === entry.dimension_id && e.status === 'requested');
    const computed = computeEntry(entry, relevant, current, hasApproved, hasRequested, now, teamId, requestedBy);
    if (!computed.ok) { rejected.push({ dimension_id: entry.dimension_id, reason: computed.reason }); continue; }
    const { newScore, historyEntry, newEvidence, newFollowups, applied: appliedEntry, exceptionToRequest } = computed.result;

    await upsertDimensionScore(teamId, newScore);
    for (const ev of newEvidence) await insertEvidenceRow(teamId, ev);
    for (const fu of newFollowups) await insertFollowUpRow(teamId, fu);
    await insertHistoryRow(teamId, entry.dimension_id, historyEntry);
    if (exceptionToRequest) {
      await requestExceptionRow(teamId, exceptionToRequest.dimension_id, exceptionToRequest.reason, exceptionToRequest.requested_by ?? null);
      // Keep the in-memory copy in sync in case the same dimension appears
      // twice in one payload and both entries claim N/A.
      team.exceptions.push({
        dimension_id: exceptionToRequest.dimension_id, status: 'requested', source: 'manual',
        reason: exceptionToRequest.reason, approved_by: '', approved_at: '',
        requested_by: exceptionToRequest.requested_by,
      });
    }
    dims[entry.dimension_id] = newScore;
    applied.push(appliedEntry);
    touched = true;
  }
  // Same derivation as the mock path (providers/assessment.ts) — the team's
  // workflow status follows the dims just written, never a hand-set value.
  if (touched) await updateTeamStatus(teamId, M.deriveTeamStatus(dims), now);
  return { applied, rejected };
}

// ─── Provenance ─────────────────────────────────────────────────────────────

export async function fetchProvenanceRaw(teamId: string): Promise<{
  historical: M.Provenance[]; scoredEvidence: M.Evidence[]; pendingLog: M.EvidenceLogItem[];
}> {
  const [histRows, scoredRows, pendingRows] = await Promise.all([
    exec(`SELECT provenance_id, source_uri, captured_by, captured_at::text AS captured_at FROM assessment_provenance WHERE team_id = :tid`, [s('tid', teamId)]),
    exec(`SELECT ${EVIDENCE_COLS} FROM assessment_evidence WHERE team_id = :tid AND scored = TRUE`, [s('tid', teamId)]),
    exec(
      `SELECT evidence_id, dimension_id, source_type, excerpt, supports_level, captured_at::text AS captured_at,
              source_ref, scored, status, title, captured_by
         FROM assessment_evidence WHERE team_id = :tid AND scored = FALSE`,
      [s('tid', teamId)],
    ),
  ]);
  return {
    historical: histRows.map((r) => ({
      provenance_id: toStr(r['provenance_id']), source_uri: toStr(r['source_uri']),
      captured_by: toStr(r['captured_by']), captured_at: toStr(r['captured_at']),
    })),
    scoredEvidence: scoredRows.map(rowToEvidence),
    pendingLog: pendingRows.map(rowToEvidenceLogItem),
  };
}

// ─── Scoring logs ───────────────────────────────────────────────────────────

function rowToScoringLog(r: Record<string, unknown>): M.ScoringLog {
  return {
    team_id: toStr(r['team_id']), envelope_id: toStrOrNull(r['envelope_id']), stamp: toStr(r['stamp']),
    source: toStr(r['source']), scores: parseJson<M.ScoringLogEntry[]>(r['scores'], []),
    run_id: r['run_id'] == null ? undefined : toStr(r['run_id']),
  };
}

export async function fetchAllScoringLogs(): Promise<M.ScoringLog[]> {
  const rows = await exec(`SELECT team_id, stamp, envelope_id, source, run_id, scores FROM assessment_scoring_logs ORDER BY created_at DESC`);
  return rows.map(rowToScoringLog);
}

export async function fetchScoringLogs(teamId: string): Promise<M.ScoringLog[]> {
  const rows = await exec(
    `SELECT team_id, stamp, envelope_id, source, run_id, scores FROM assessment_scoring_logs WHERE team_id = :tid ORDER BY created_at DESC`,
    [s('tid', teamId)],
  );
  return rows.map(rowToScoringLog);
}

export async function fetchScoringLog(teamId: string, stamp: string): Promise<M.ScoringLog | null> {
  const rows = await exec(
    `SELECT team_id, stamp, envelope_id, source, run_id, scores FROM assessment_scoring_logs WHERE team_id = :tid AND stamp = :stamp`,
    [s('tid', teamId), s('stamp', stamp)],
  );
  return rows.length ? rowToScoringLog(rows[0]!) : null;
}

/**
 * Inserts (or replaces, on a rerun against the same team+stamp) one
 * ScoringLog — the sidecar a completed score-dimensions/process-self-
 * assessment run produces (see completeRun in providers/assessment.ts,
 * the Aurora run-completion path this backs). `run_id` is a real FK to
 * assessment_runs; nullable because seeded/manual logs predate having a run
 * behind them.
 */
export async function insertScoringLog(log: M.ScoringLog): Promise<void> {
  await exec(
    `INSERT INTO assessment_scoring_logs (team_id, stamp, envelope_id, source, run_id, scores)
     VALUES (:tid, :stamp, :envelope, :source, :run_id, :scores::jsonb)
     ON CONFLICT (team_id, stamp) DO UPDATE SET
       envelope_id = EXCLUDED.envelope_id, source = EXCLUDED.source, run_id = EXCLUDED.run_id, scores = EXCLUDED.scores`,
    [
      s('tid', log.team_id), s('stamp', log.stamp), maybe('envelope', log.envelope_id),
      s('source', log.source), maybe('run_id', log.run_id ?? null), jsonp('scores', log.scores),
    ],
  );
}

// ─── Runs ───────────────────────────────────────────────────────────────────

function rowToRun(r: Record<string, unknown>): M.MockRun {
  return {
    id: toStr(r['id']), command: toStr(r['command']), team_id: toStrOrNull(r['team_id']),
    args: parseJson<Record<string, unknown>>(r['args'], {}), status: toStr(r['status']) as M.RunStatus,
    source: toStr(r['source']), started_at: toStr(r['started_at']), finished_at: toStrOrNull(r['finished_at']),
    summary: toStr(r['summary']), error: toStrOrNull(r['error']), files_written: toStrArr(r['files_written']),
  };
}

const RUN_COLS = `id, command, team_id, args, status, source, started_at::text AS started_at,
                   finished_at::text AS finished_at, summary, error, files_written`;

export async function fetchRuns(filters: { command?: string; team?: string; status?: string; limit?: number }): Promise<M.MockRun[]> {
  const clauses: string[] = [];
  const params: SqlParameter[] = [];
  if (filters.command) { clauses.push('command = :command'); params.push(s('command', filters.command)); }
  if (filters.team) { clauses.push('team_id = :team'); params.push(s('team', filters.team)); }
  if (filters.status) { clauses.push('status = :status'); params.push(s('status', filters.status)); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const lim = Math.max(1, Math.min(filters.limit ?? 50, 500));
  params.push(int('lim', lim));
  const rows = await exec(`SELECT ${RUN_COLS} FROM assessment_runs ${where} ORDER BY started_at DESC LIMIT :lim`, params);
  return rows.map(rowToRun);
}

export async function fetchRun(id: string): Promise<M.MockRun | null> {
  const rows = await exec(`SELECT ${RUN_COLS} FROM assessment_runs WHERE id = :id`, [s('id', id)]);
  return rows.length ? rowToRun(rows[0]!) : null;
}

export async function insertRun(rec: M.MockRun, launchedBy: string | null = null, execute: TxExec = exec): Promise<void> {
  await execute(
    `INSERT INTO assessment_runs (id, command, team_id, args, status, source, started_at, finished_at, summary, error, files_written, launched_by)
     VALUES (:id, :command, :team, :args::jsonb, :status, :source, :started::timestamptz, :finished, :summary, :error, :files, :launched_by)`,
    [
      s('id', rec.id), s('command', rec.command), maybe('team', rec.team_id), jsonp('args', rec.args),
      s('status', rec.status), s('source', rec.source), s('started', rec.started_at),
      rec.finished_at == null ? nul('finished') : s('finished', rec.finished_at),
      s('summary', rec.summary), rec.error == null ? nul('error') : s('error', rec.error),
      arrp('files', rec.files_written), maybe('launched_by', launchedBy),
    ],
  );
}

/** Serialize admission globally across BFF replicas, including the cap. */
export async function reserveRun(
  rec: M.MockRun, launchedBy: string | null, dispatch: import('../lib/assessment-run-input.js').AssessmentDispatchInput,
  cap: number,
): Promise<'reserved' | 'duplicate' | 'capacity'> {
  return withTransaction(async tx => {
    await tx('LOCK TABLE assessment_runs IN SHARE ROW EXCLUSIVE MODE');
    const counts = await tx(`SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE command = :command AND team_id IS NOT DISTINCT FROM :team) AS duplicate
      FROM assessment_runs WHERE status = 'running'`, [s('command', rec.command), maybe('team', rec.team_id)]);
    if (toNum(counts[0]?.['duplicate']) > 0) return 'duplicate';
    if (toNum(counts[0]?.['total']) >= cap) return 'capacity';
    await insertRun(rec, launchedBy, tx);
    await tx('UPDATE assessment_runs SET dispatch_payload = :payload::jsonb WHERE id = :id',
      [jsonp('payload', dispatch), s('id', rec.id)]);
    return 'reserved';
  });
}

export async function claimAssessmentRun(): Promise<{ run: M.MockRun; dispatch: import('../lib/assessment-run-input.js').AssessmentDispatchInput } | null> {
  const rows = await exec(`UPDATE assessment_runs SET dispatch_claimed_at = NOW()
    WHERE id = (SELECT id FROM assessment_runs WHERE status = 'running'
      AND dispatch_payload IS NOT NULL AND dispatch_claimed_at IS NULL
      ORDER BY started_at FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING ${RUN_COLS}, dispatch_payload`);
  if (!rows.length) return null;
  return { run: rowToRun(rows[0]!), dispatch: parseJson(rows[0]!['dispatch_payload'], null)! };
}

export async function expireAssessmentClaims(): Promise<M.MockRun[]> {
  const rows = await exec(`UPDATE assessment_runs SET status = 'failed', finished_at = NOW(),
    error = 'Assessment worker lease expired; start a new run', summary = 'Worker interrupted before completion'
    WHERE status = 'running' AND COALESCE(dispatch_claimed_at,
      CASE WHEN dispatch_payload IS NULL THEN started_at END) < NOW() - INTERVAL '20 minutes'
    RETURNING ${RUN_COLS}`);
  return rows.map(rowToRun);
}

export async function countRunningDuplicates(command: string, teamId: string | null): Promise<number> {
  const rows = teamId === null
    ? await exec(`SELECT COUNT(*) AS cnt FROM assessment_runs WHERE command = :command AND status = 'running' AND team_id IS NULL`, [s('command', command)])
    : await exec(`SELECT COUNT(*) AS cnt FROM assessment_runs WHERE command = :command AND status = 'running' AND team_id = :team`, [s('command', command), s('team', teamId)]);
  return toNum(rows[0]?.['cnt'], 0);
}

export async function countRunningTotal(): Promise<number> {
  const rows = await exec(`SELECT COUNT(*) AS cnt FROM assessment_runs WHERE status = 'running'`);
  return toNum(rows[0]?.['cnt'], 0);
}

export async function updateRunStatus(
  runId: string,
  patch: { status: M.RunStatus; finished_at: string; summary?: string; error?: string | null; files_written?: string[] },
): Promise<void> {
  await exec(
    `UPDATE assessment_runs SET status = :status, finished_at = :fin::timestamptz,
            summary = COALESCE(:summary, summary), error = :error,
            files_written = COALESCE(:files, files_written)
      WHERE id = :id`,
    [
      s('status', patch.status), s('fin', patch.finished_at),
      patch.summary == null ? nul('summary') : s('summary', patch.summary),
      patch.error == null ? nul('error') : s('error', patch.error),
      patch.files_written == null ? nul('files') : arrp('files', patch.files_written),
      s('id', runId),
    ],
  );
}

// ─── Feedback (HITL tasks) ──────────────────────────────────────────────────

function rowToFeedbackTask(r: Record<string, unknown>): M.FeedbackTask {
  return {
    task_id: toStr(r['task_id']), team_id: toStrOrNull(r['team_id']), kind: toStr(r['kind']),
    status: toStr(r['status']) as M.FeedbackStatus, dimension_id: toStrOrNull(r['dimension_id']),
    question: toStr(r['question']), created_at: toStr(r['created_at']), resolved_at: toStrOrNull(r['resolved_at']),
    response: toStrOrNull(r['response']),
  };
}

const FEEDBACK_COLS = `task_id, team_id, kind, status, dimension_id, question, response,
                        created_at::text AS created_at, resolved_at::text AS resolved_at`;

export async function fetchFeedbackTasks(filters: { status?: string; team?: string; kind?: string }): Promise<M.FeedbackTask[]> {
  const clauses: string[] = [];
  const params: SqlParameter[] = [];
  if (filters.status) { clauses.push('status = :status'); params.push(s('status', filters.status)); }
  if (filters.team) { clauses.push('team_id = :team'); params.push(s('team', filters.team)); }
  if (filters.kind) { clauses.push('kind = :kind'); params.push(s('kind', filters.kind)); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await exec(`SELECT ${FEEDBACK_COLS} FROM assessment_feedback_tasks ${where} ORDER BY created_at DESC`, params);
  return rows.map(rowToFeedbackTask);
}

export async function fetchFeedbackTask(taskId: string): Promise<M.FeedbackTask | null> {
  const rows = await exec(`SELECT ${FEEDBACK_COLS} FROM assessment_feedback_tasks WHERE task_id = :id`, [s('id', taskId)]);
  return rows.length ? rowToFeedbackTask(rows[0]!) : null;
}

export async function insertFeedbackTask(task: M.FeedbackTask): Promise<void> {
  await exec(
    `INSERT INTO assessment_feedback_tasks (task_id, team_id, kind, status, dimension_id, question, created_at)
     VALUES (:id, :team, :kind, 'OPEN', :dim, :question, :created::timestamptz)`,
    [s('id', task.task_id), maybe('team', task.team_id), s('kind', task.kind), maybe('dim', task.dimension_id), s('question', task.question), s('created', task.created_at)],
  );
}

export async function resolveFeedbackTaskRow(taskId: string, response: string): Promise<M.FeedbackTask | null> {
  const rows = await exec(
    `UPDATE assessment_feedback_tasks SET status = 'RESOLVED', response = :resp, resolved_at = NOW()
       WHERE task_id = :id RETURNING ${FEEDBACK_COLS}`,
    [s('id', taskId), s('resp', response)],
  );
  return rows.length ? rowToFeedbackTask(rows[0]!) : null;
}

export async function dismissFeedbackTaskRow(taskId: string): Promise<M.FeedbackTask | null> {
  const rows = await exec(
    `UPDATE assessment_feedback_tasks SET status = 'DISMISSED', resolved_at = NOW()
       WHERE task_id = :id RETURNING ${FEEDBACK_COLS}`,
    [s('id', taskId)],
  );
  return rows.length ? rowToFeedbackTask(rows[0]!) : null;
}

export interface OpenFollowUpRow { question_id: string; team_id: string; dimension_id: string; text: string; created_at: string }

export async function fetchOpenFollowUps(): Promise<OpenFollowUpRow[]> {
  const rows = await exec(
    `SELECT question_id, team_id, dimension_id, text, created_at::text AS created_at
       FROM assessment_follow_up_questions WHERE status = 'OPEN'`,
  );
  return rows.map((r) => ({
    question_id: toStr(r['question_id']), team_id: toStr(r['team_id']),
    dimension_id: toStr(r['dimension_id']), text: toStr(r['text']), created_at: toStr(r['created_at']),
  }));
}

export async function findFollowUpQuestion(questionId: string): Promise<OpenFollowUpRow | null> {
  const rows = await exec(
    `SELECT question_id, team_id, dimension_id, text, created_at::text AS created_at
       FROM assessment_follow_up_questions WHERE question_id = :qid`,
    [s('qid', questionId)],
  );
  if (!rows.length) return null;
  const r = rows[0]!;
  return {
    question_id: toStr(r['question_id']), team_id: toStr(r['team_id']),
    dimension_id: toStr(r['dimension_id']), text: toStr(r['text']), created_at: toStr(r['created_at']),
  };
}

export async function setFollowUpStatus(questionId: string, status: 'ANSWERED' | 'DROPPED'): Promise<boolean> {
  const rows = await exec(
    `UPDATE assessment_follow_up_questions SET status = :status WHERE question_id = :qid RETURNING question_id`,
    [s('status', status), s('qid', questionId)],
  );
  return rows.length > 0;
}

// ─── Configuration ──────────────────────────────────────────────────────────

export async function fetchConfiguration(): Promise<M.AssessmentConfiguration> {
  const rows = await exec(`SELECT target_level, motions, updated_at::text AS updated_at FROM assessment_configuration WHERE key = 'default'`);
  if (!rows.length) return { target_level: 3, motions: [], updated_at: new Date(0).toISOString() };
  const r = rows[0]!;
  return {
    target_level: toNum(r['target_level'], 3),
    motions: parseJson<M.MotionConfig[]>(r['motions'], []),
    updated_at: toStr(r['updated_at']),
  };
}

export async function upsertConfiguration(patch: { target_level?: number; motions?: M.MotionConfig[] }): Promise<M.AssessmentConfiguration> {
  const current = await fetchConfiguration();
  const next = { target_level: patch.target_level ?? current.target_level, motions: patch.motions ?? current.motions };
  await exec(
    `INSERT INTO assessment_configuration (key, target_level, motions, updated_at)
     VALUES ('default', :target, :motions::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET target_level = EXCLUDED.target_level, motions = EXCLUDED.motions, updated_at = EXCLUDED.updated_at`,
    [int('target', next.target_level), jsonp('motions', next.motions)],
  );
  return fetchConfiguration();
}

// ─── Stories (one per recommendation acted on) ─────────────────────────────

const STORY_COLS = 'filename, team_id, dimension_id, title, markdown, status, jira_key, created_at::text AS created_at';

function rowToStory(r: Record<string, unknown>): M.StoryDraft {
  return {
    filename: toStr(r['filename']), team_id: toStr(r['team_id']), dimension_id: toStr(r['dimension_id']),
    title: toStr(r['title']), markdown: toStr(r['markdown']), status: toStr(r['status'], 'ready') as M.StoryStatus,
    jira_key: toStrOrNull(r['jira_key']), created_at: toStr(r['created_at']),
  };
}

export async function fetchStories(teamId: string): Promise<M.StoryDraft[]> {
  const rows = await exec(`SELECT ${STORY_COLS} FROM assessment_stories WHERE team_id = :tid ORDER BY created_at ASC`, [s('tid', teamId)]);
  return rows.map(rowToStory);
}

/** Bulk variant for listPortfolioRecommendations, same shape as fetchAllDimensionScores. */
export async function fetchAllStories(): Promise<Map<string, M.StoryDraft[]>> {
  const rows = await exec(`SELECT ${STORY_COLS} FROM assessment_stories ORDER BY created_at ASC`);
  const out = new Map<string, M.StoryDraft[]>();
  for (const r of rows) {
    const tid = toStr(r['team_id']);
    const list = out.get(tid) ?? [];
    list.push(rowToStory(r));
    out.set(tid, list);
  }
  return out;
}

export async function fetchStory(teamId: string, filename: string): Promise<M.StoryDraft | null> {
  const rows = await exec(
    `SELECT ${STORY_COLS} FROM assessment_stories WHERE team_id = :tid AND filename = :fn`,
    [s('tid', teamId), s('fn', filename)],
  );
  return rows.length ? rowToStory(rows[0]!) : null;
}

// ─── Submissions (Forms envelopes) ──────────────────────────────────────────
//
// The full envelope is stored whole in the `envelope` JSONB column (schema
// comment: "the full SubmissionEnvelope") — the lifted columns (team_id,
// status, revision, submitted_at, ...) exist only for filtering/ordering.
// Every read here parses `envelope` as the source of truth rather than
// reconstructing the object field-by-field from the lifted columns, so the
// wire shape is exactly what was written, never re-derived.

function rowToSubmission(r: Record<string, unknown>): M.SubmissionEnvelope {
  return parseJson<M.SubmissionEnvelope>(r['envelope'], {} as M.SubmissionEnvelope);
}

/** Bulk variant for listSubmissions. */
export async function fetchAllSubmissions(): Promise<Array<M.SubmissionEnvelope & { team_id: string }>> {
  const rows = await exec(`SELECT team_id, envelope FROM assessment_submissions ORDER BY ingested_at DESC`);
  return rows.map((r) => ({ ...rowToSubmission(r), team_id: toStr(r['team_id']) }));
}

export async function fetchSubmissionsForTeam(teamId: string): Promise<M.SubmissionEnvelope[]> {
  const rows = await exec(`SELECT envelope FROM assessment_submissions WHERE team_id = :tid`, [s('tid', teamId)]);
  return rows.map(rowToSubmission);
}

export async function fetchSubmission(teamId: string, envelopeId: string): Promise<M.SubmissionEnvelope | null> {
  const rows = await exec(
    `SELECT envelope FROM assessment_submissions WHERE team_id = :tid AND envelope_id = :eid`,
    [s('tid', teamId), s('eid', envelopeId)],
  );
  return rows.length ? rowToSubmission(rows[0]!) : null;
}

/** Persists a mutated envelope object wholesale (e.g. after updateSubmissionLink flips a link's status). */
export async function saveSubmissionEnvelope(envelope: M.SubmissionEnvelope): Promise<void> {
  await exec(
    `UPDATE assessment_submissions SET envelope = :env::jsonb, status = :status
      WHERE team_id = :tid AND envelope_id = :eid`,
    [jsonp('env', envelope), s('status', envelope.status), s('tid', envelope.team_id), s('eid', envelope.envelope_id)],
  );
}

export async function deleteSubmissionRow(teamId: string, envelopeId: string): Promise<boolean> {
  const rows = await exec(
    `DELETE FROM assessment_submissions WHERE team_id = :tid AND envelope_id = :eid RETURNING envelope_id`,
    [s('tid', teamId), s('eid', envelopeId)],
  );
  return rows.length > 0;
}

export async function markSubmissionCommitted(teamId: string, envelopeId: string): Promise<boolean> {
  const rows = await exec(
    `UPDATE assessment_submissions
        SET status = 'committed', envelope = jsonb_set(envelope, '{status}', '"committed"')
      WHERE team_id = :tid AND envelope_id = :eid RETURNING envelope_id`,
    [s('tid', teamId), s('eid', envelopeId)],
  );
  return rows.length > 0;
}

export async function markSubmissionSuperseded(teamId: string, envelopeId: string, run: TxExec = exec): Promise<void> {
  await run(
    `UPDATE assessment_submissions
        SET status = 'superseded', envelope = jsonb_set(envelope, '{status}', '"superseded"')
      WHERE team_id = :tid AND envelope_id = :eid`,
    [s('tid', teamId), s('eid', envelopeId)],
  );
}

/**
 * Inserts a newly-committed envelope (mirrors the mock's commitSubmissions
 * building one SubmissionEnvelope per staged row). `submittedAtIso` /
 * `assessmentDateIso` are pre-parsed by the caller (providers/assessment.ts's
 * `parseFormsTimestamp`) from the raw MS-Forms date string that the envelope
 * itself keeps verbatim in `submitted_at`/`assessment_date` — the DB columns
 * need a real timestamp/date, the JSON keeps the original wire string
 * unmodified so re-reads round-trip exactly what was submitted.
 *
 * Conflict-safe: `envelope_id` is client-computed (deterministic from
 * completion time + form id + submitter), so two concurrent commits for the
 * same row can race to insert the identical id. `ON CONFLICT DO NOTHING` +
 * `RETURNING` turns that race into a returned `false` (a 409-worthy
 * "someone already committed this") instead of an uncaught unique-violation
 * 500. Returns `true` iff a row was actually inserted.
 */
export async function insertSubmission(
  envelope: M.SubmissionEnvelope, submittedAtIso: string, assessmentDateIso: string | null, run: TxExec = exec,
): Promise<boolean> {
  const rows = await run(
    `INSERT INTO assessment_submissions
       (envelope_id, team_id, status, revision, supersedes, form_submission_id, submitted_at, ingested_at, assessment_date, self_certified, submitter, envelope)
     VALUES (:eid, :tid, :status, :rev, :supersedes, :formid, :submitted::timestamptz, :ingested::timestamptz, :adate::date, :selfcert, :submitter::jsonb, :envelope::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING envelope_id`,
    [
      s('eid', envelope.envelope_id), s('tid', envelope.team_id), s('status', envelope.status),
      int('rev', envelope.revision), maybe('supersedes', envelope.supersedes),
      maybe('formid', envelope.source?.form_submission_id ?? null),
      s('submitted', submittedAtIso), s('ingested', envelope.ingested_at),
      maybe('adate', assessmentDateIso), bool('selfcert', envelope.self_certified),
      jsonp('submitter', envelope.submitter), jsonp('envelope', envelope),
    ],
  );
  return rows.length > 0;
}

/**
 * Atomically supersede the prior envelope (if any) and insert its
 * replacement — the fix for the non-atomic three-round-trip commit path:
 * `fetchSubmissionsForTeam` (read) -> mark superseded -> insert used to be
 * three separate autocommit statements with no transaction, so a crash
 * between the second and third left a superseded envelope with nothing
 * replacing it (data loss), and two concurrent commits for the same
 * team+form could both pass the duplicate check before either insert
 * committed (crash on the second's unique-violation). Now: one transaction,
 * and the insert is conflict-safe (see insertSubmission) — returns `false`
 * instead of throwing when a concurrent commit already won the race, and
 * in that case the supersede is rolled back too, so the prior envelope is
 * never left superseded with nothing to replace it.
 */
export async function commitSubmissionEnvelope(
  envelope: M.SubmissionEnvelope, submittedAtIso: string, assessmentDateIso: string | null,
  priorEnvelopeId: string | null,
): Promise<boolean> {
  const conflict = new Error('submission conflict');
  try {
    return await withTransaction(async (tx) => {
      if (priorEnvelopeId) await markSubmissionSuperseded(envelope.team_id, priorEnvelopeId, tx);
      if (!(await insertSubmission(envelope, submittedAtIso, assessmentDateIso, tx))) throw conflict;
      return true;
    });
  } catch (err) {
    // Returning false inside the callback would COMMIT the supersede. Throw
    // through withTransaction first, so its rollback restores the old row.
    if (err === conflict) return false;
    throw err;
  }
}

/**
 * `{team_id}:{form_submission_id}` for every COMMITTED envelope — feeds
 * parseSubmission's per-row "already seen" classification without an N+1
 * query per row. The mock path answers the same question by scanning
 * the submissions fixture in memory (hasCommittedEnvelopeForForm).
 */
export async function fetchCommittedFormIds(): Promise<Set<string>> {
  const rows = await exec(
    `SELECT team_id, envelope->'source'->>'form_submission_id' AS form_id
       FROM assessment_submissions WHERE status = 'committed'`,
  );
  const out = new Set<string>();
  for (const r of rows) {
    const formId = toStr(r['form_id']);
    if (formId) out.add(`${toStr(r['team_id'])}:${formId}`);
  }
  return out;
}

// ─── Knowledge (Workspace / Enterprise / Rules / Prompts) ──────────────────

function rowToKnowledgeNode(r: Record<string, unknown>): M.KnowledgeNode {
  return {
    id: toStr(r['id']), title: toStr(r['title']), parent_id: toStrOrNull(r['parent_id']),
    is_dir: toBool(r['is_dir']),
    classification: r['classification'] == null ? undefined : toStr(r['classification']),
    editable: r['editable'] == null ? undefined : toBool(r['editable']),
    viewable: r['viewable'] == null ? undefined : toBool(r['viewable']),
    updated_at: r['updated_at'] == null ? undefined : toStr(r['updated_at']),
    page_id: r['page_id'] == null ? undefined : toStr(r['page_id']),
  };
}

const KNOWLEDGE_NODE_COLS = `id, section_key, parent_id, title, is_dir, classification, editable, viewable, page_id,
                              updated_at::text AS updated_at`;

export async function fetchKnowledgeTree(): Promise<M.KnowledgeSection[]> {
  const [sectionRows, nodeRows] = await Promise.all([
    exec(`SELECT key, title, kind, provider FROM assessment_knowledge_sections ORDER BY position, key`),
    exec(`SELECT ${KNOWLEDGE_NODE_COLS} FROM assessment_knowledge_nodes ORDER BY section_key, position, id`),
  ]);
  const nodesBySection = new Map<string, M.KnowledgeNode[]>();
  for (const r of nodeRows) {
    const key = toStr(r['section_key']);
    const list = nodesBySection.get(key) ?? [];
    list.push(rowToKnowledgeNode(r));
    nodesBySection.set(key, list);
  }
  return sectionRows.map((r) => ({
    key: toStr(r['key']), title: toStr(r['title']), kind: toStr(r['kind']) as M.KnowledgeSectionKind,
    provider: r['provider'] == null ? undefined : toStr(r['provider']),
    nodes: nodesBySection.get(toStr(r['key'])) ?? [],
  }));
}

export async function fetchKnowledgeNode(id: string): Promise<M.KnowledgeNode | null> {
  const rows = await exec(`SELECT ${KNOWLEDGE_NODE_COLS} FROM assessment_knowledge_nodes WHERE id = :id`, [s('id', id)]);
  return rows.length ? rowToKnowledgeNode(rows[0]!) : null;
}

const KNOWLEDGE_DOC_COLS = 'id, title, classification, markdown, editable, path, source_parent_id, published_page_id, updated_at::text AS updated_at';

function rowToKnowledgeDoc(r: Record<string, unknown>): M.KnowledgeDoc {
  return {
    id: toStr(r['id']), title: toStr(r['title']), classification: toStr(r['classification']),
    markdown: toStr(r['markdown']), editable: toBool(r['editable']), path: toStr(r['path']),
    updated_at: toStr(r['updated_at']), source_parent_id:toStrOrNull(r['source_parent_id']), published_page_id:toStrOrNull(r['published_page_id']),
  };
}

export async function fetchKnowledgeDoc(id: string): Promise<M.KnowledgeDoc | null> {
  const rows = await exec(`SELECT ${KNOWLEDGE_DOC_COLS} FROM assessment_knowledge_docs WHERE id = :id`, [s('id', id)]);
  return rows.length ? rowToKnowledgeDoc(rows[0]!) : null;
}

function rowToKnowledgeDocVersion(r: Record<string, unknown>): M.KnowledgeDocVersion {
  return {
    stamp: toStr(r['stamp']), label: toStrOrNull(r['label']), size: toNum(r['size']),
    saved_at: toStr(r['saved_at']), markdown: toStr(r['markdown']),
  };
}

export async function fetchKnowledgeDocVersions(docId: string): Promise<M.KnowledgeDocVersion[]> {
  const rows = await exec(
    `SELECT stamp, label, size, saved_at::text AS saved_at, markdown
       FROM assessment_knowledge_doc_versions WHERE doc_id = :id ORDER BY stamp DESC`,
    [s('id', docId)],
  );
  return rows.map(rowToKnowledgeDocVersion);
}

export async function fetchKnowledgeDocVersion(docId: string, stamp: string): Promise<M.KnowledgeDocVersion | null> {
  const rows = await exec(
    `SELECT stamp, label, size, saved_at::text AS saved_at, markdown
       FROM assessment_knowledge_doc_versions WHERE doc_id = :id AND stamp = :stamp`,
    [s('id', docId), s('stamp', stamp)],
  );
  return rows.length ? rowToKnowledgeDocVersion(rows[0]!) : null;
}

export async function insertKnowledgeDocVersion(
  docId: string,
  snapshot: { stamp: string; label: string | null; size: number; savedAt: string; markdown: string; savedBy?: string | null },
): Promise<void> {
  await exec(
    `INSERT INTO assessment_knowledge_doc_versions (doc_id, stamp, label, size, saved_at, saved_by, markdown)
     VALUES (:id, :stamp, :label, :size, :saved::timestamptz, :by, :markdown)`,
    [
      s('id', docId), s('stamp', snapshot.stamp), maybe('label', snapshot.label), int('size', snapshot.size),
      s('saved', snapshot.savedAt), maybe('by', snapshot.savedBy ?? null), s('markdown', snapshot.markdown),
    ],
  );
}

/**
 * Saves a doc's new markdown and bumps updated_at. The pre-save snapshot of
 * the OLD content is a separate insertKnowledgeDocVersion call the caller
 * makes first — mirrors putKnowledgeDoc's mock-path ordering exactly
 * (snapshot what's about to be overwritten, then overwrite).
 */
export async function updateKnowledgeDocMarkdown(id: string, markdown: string, updatedAt: string): Promise<void> {
  await exec(
    `UPDATE assessment_knowledge_docs SET markdown = :markdown, updated_at = :updated::timestamptz WHERE id = :id`,
    [s('markdown', markdown), s('updated', updatedAt), s('id', id)],
  );
}

/**
 * Bumps every non-directory node's updated_at in a synced section (the mock
 * "Confluence pull" — there is no real Confluence to sync from). Returns the
 * section with its nodes so the caller can report a plausible pages/
 * files_pulled count without a second round trip; null if the section
 * doesn't exist or isn't a synced one.
 */
export async function touchSyncedSectionNodes(sectionKey: string, updatedAt: string): Promise<M.KnowledgeSection | null> {
  const sectionRows = await exec(
    `SELECT key, title, kind, provider FROM assessment_knowledge_sections WHERE key = :key AND kind = 'synced'`,
    [s('key', sectionKey)],
  );
  if (!sectionRows.length) return null;
  await exec(
    `UPDATE assessment_knowledge_nodes SET updated_at = :updated::timestamptz WHERE section_key = :key AND is_dir = FALSE`,
    [s('updated', updatedAt), s('key', sectionKey)],
  );
  const nodeRows = await exec(`SELECT ${KNOWLEDGE_NODE_COLS} FROM assessment_knowledge_nodes WHERE section_key = :key`, [s('key', sectionKey)]);
  const r = sectionRows[0]!;
  return {
    key: toStr(r['key']), title: toStr(r['title']), kind: toStr(r['kind']) as M.KnowledgeSectionKind,
    provider: r['provider'] == null ? undefined : toStr(r['provider']), nodes: nodeRows.map(rowToKnowledgeNode),
  };
}

/** First synced section (kind = 'synced') to publish a local doc into, matching the mock's `find(s => s.kind === 'synced')`. */
export async function fetchFirstSyncedSectionKey(): Promise<string | null> {
  const rows = await exec(`SELECT key FROM assessment_knowledge_sections WHERE kind = 'synced' ORDER BY position, key LIMIT 1`);
  return rows.length ? toStr(rows[0]!['key']) : null;
}

/**
 * Upserts the published-page node for one local doc, incrementing `version`
 * on a re-publish (the durable analogue of the mock's in-memory
 * `publishedVersions` counter). Returns the version now on the row.
 */
export async function upsertPublishedPageNode(
  sectionKey: string, nodeId: string, title: string, classification: string, pageId: string, updatedAt: string,
): Promise<number> {
  const rows = await exec(
    `INSERT INTO assessment_knowledge_nodes (id, section_key, parent_id, title, is_dir, classification, editable, viewable, page_id, updated_at, version)
     VALUES (:id, :sec, NULL, :title, FALSE, :class, FALSE, TRUE, :page, :updated::timestamptz, 1)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title, updated_at = EXCLUDED.updated_at, version = assessment_knowledge_nodes.version + 1
     RETURNING version`,
    [s('id', nodeId), s('sec', sectionKey), s('title', title), s('class', classification), s('page', pageId), s('updated', updatedAt)],
  );
  return toNum(rows[0]?.['version'], 1);
}

/**
 * Moves one node and renumbers the destination's children so `position` stays
 * dense. Two statements rather than one because the row being moved may be
 * leaving the same parent it is joining (a pure reorder), and renumbering
 * after the update keeps that case from needing its own branch. Returns the
 * position the row actually landed on, which is the clamp of what was asked.
 */
export async function moveKnowledgeNodeRow(
  id: string, parentId: string | null, position: number,
): Promise<number> {
  await exec(
    `UPDATE assessment_knowledge_nodes
        SET parent_id = :parent, position = :pos, version = version + 1
      WHERE id = :id`,
    [s('id', id), parentId === null ? nul('parent') : s('parent', parentId), int('pos', position)],
  );
  const rows = await exec(
    `WITH ordered AS (
       SELECT id, ROW_NUMBER() OVER (
                ORDER BY position, CASE WHEN id = :id THEN 0 ELSE 1 END, id
              ) - 1 AS rn
         FROM assessment_knowledge_nodes
        WHERE section_key = (SELECT section_key FROM assessment_knowledge_nodes WHERE id = :id)
          AND parent_id IS NOT DISTINCT FROM (SELECT parent_id FROM assessment_knowledge_nodes WHERE id = :id)
     )
     UPDATE assessment_knowledge_nodes t
        SET position = o.rn
       FROM ordered o
      WHERE t.id = o.id
     RETURNING t.id, t.position`,
    [s('id', id)],
  );
  const landed = rows.find((r) => toStr(r['id']) === id);
  return toNum(landed?.['position'], position);
}

/** Title only — the id is a path other rows and URLs reference, so it stays. */
export async function renameKnowledgeNodeRow(id: string, title: string): Promise<void> {
  await exec(
    `UPDATE assessment_knowledge_nodes SET title = :title, version = version + 1 WHERE id = :id`,
    [s('id', id), s('title', title)],
  );
}

/** Oldest first — a thread reads top-down, and the pane does not re-sort. */
export async function fetchKnowledgeComments(docId: string): Promise<M.KnowledgeComment[]> {
  const rows = await exec(
    `SELECT id, doc_id, parent_id, body, author, created_at::text AS created_at,
            edited_at::text AS edited_at, deleted_at::text AS deleted_at
       FROM assessment_knowledge_comments
      WHERE doc_id = :doc
      ORDER BY created_at ASC, id ASC`,
    [s('doc', docId)],
  );
  return rows.map((r) => ({
    id: toStr(r['id']), doc_id: toStr(r['doc_id']), parent_id: toStrOrNull(r['parent_id']), body: toStr(r['body']),
    author: toStr(r['author']), created_at: toStr(r['created_at']),
    edited_at: toStrOrNull(r['edited_at']), deleted_at: toStrOrNull(r['deleted_at']),
  }));
}

export async function fetchKnowledgeReactions(targetIds: string[]): Promise<M.KnowledgeReaction[]> {
  if (targetIds.length === 0) return [];
  // One round trip for the document AND every comment on it — the pane asks
  // for the whole page's reactions at once, and N+1 here would be one query
  // per comment on a thread that can be long.
  const names = targetIds.map((_, i) => `:t${i}`).join(', ');
  const rows = await exec(
    `SELECT target_id, emoji, actor, created_at::text AS created_at
       FROM assessment_knowledge_reactions
      WHERE target_id IN (${names})`,
    targetIds.map((t, i) => s(`t${i}`, t)),
  );
  return rows.map((r) => ({
    target_id: toStr(r['target_id']), emoji: toStr(r['emoji']),
    actor: toStr(r['actor']), created_at: toStr(r['created_at']),
  }));
}

/** Returns true when the row landed, false when it was removed — the toggle. */
export async function toggleKnowledgeReaction(
  targetId: string, emoji: string, actor: string, at: string,
): Promise<boolean> {
  const gone = await exec(
    `DELETE FROM assessment_knowledge_reactions
      WHERE target_id = :t AND emoji = :e AND actor = :a RETURNING actor`,
    [s('t', targetId), s('e', emoji), s('a', actor)],
  );
  if (gone.length > 0) return false;
  await exec(
    `INSERT INTO assessment_knowledge_reactions (target_id, emoji, actor, created_at)
     VALUES (:t, :e, :a, :at::timestamptz)
     ON CONFLICT (target_id, emoji, actor) DO NOTHING`,
    [s('t', targetId), s('e', emoji), s('a', actor), s('at', at)],
  );
  return true;
}

export async function fetchKnowledgeComment(id: string): Promise<M.KnowledgeComment | null> {
  const rows = await exec(
    `SELECT id, doc_id, parent_id, body, author, created_at::text AS created_at,
            edited_at::text AS edited_at, deleted_at::text AS deleted_at
       FROM assessment_knowledge_comments WHERE id = :id`,
    [s('id', id)],
  );
  const r = rows[0];
  return r ? {
    id: toStr(r['id']), doc_id: toStr(r['doc_id']), parent_id: toStrOrNull(r['parent_id']), body: toStr(r['body']),
    author: toStr(r['author']), created_at: toStr(r['created_at']),
    edited_at: toStrOrNull(r['edited_at']), deleted_at: toStrOrNull(r['deleted_at']),
  } : null;
}

export async function updateKnowledgeComment(id: string, body: string, editedAt: string): Promise<void> {
  await exec(
    `UPDATE assessment_knowledge_comments SET body = :body, edited_at = :at::timestamptz WHERE id = :id`,
    [s('id', id), s('body', body), s('at', editedAt)],
  );
}

export async function softDeleteKnowledgeComment(id: string, deletedAt: string): Promise<void> {
  await exec(
    `UPDATE assessment_knowledge_comments SET deleted_at = :at::timestamptz WHERE id = :id`,
    [s('id', id), s('at', deletedAt)],
  );
}

export async function insertKnowledgeComment(
  id: string, docId: string, body: string, author: string, createdAt: string, parentId: string | null = null,
): Promise<boolean> {
  return withTransaction(async tx => {
    if (parentId !== null) {
      // A concurrent soft delete must serialize with this validation + insert.
      const parents = await tx(`SELECT id FROM assessment_knowledge_comments
        WHERE id = :parent AND doc_id = :doc AND deleted_at IS NULL FOR UPDATE`,
      [s('parent', parentId), s('doc', docId)]);
      if (!parents.length) return false;
    }
    await tx(
      `INSERT INTO assessment_knowledge_comments (id, doc_id, parent_id, body, author, created_at)
       VALUES (:id, :doc, :parent, :body, :author, :created::timestamptz)`,
      [s('id', id), s('doc', docId), maybe('parent', parentId), s('body', body), s('author', author), s('created', createdAt)],
    );
    return true;
  });
}
