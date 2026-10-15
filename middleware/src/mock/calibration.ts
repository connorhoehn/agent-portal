// Judge calibration, as `dev:mock` sees it — the hand-graded corpus in
// `observability.calibration_set` and the re-judge history over it.
//
// WHAT THIS IS FOR. A calibration case is a (prompt, response, human_score)
// tuple a researcher graded by hand. Re-running the Nova-Pro judge over the set
// and measuring |judge − human| is how you find out the judge has drifted, and
// when MAE creeps past ~0.15 every historical quality score has lost its
// anchor. Offline the whole page was empty, so the one surface whose job is to
// tell you the quality numbers cannot be trusted was itself untrustworthy and
// silent about it.
//
// NO RUN CARRIES A SUMMARY. `calibration_runs` has `total_cases`,
// `mean_abs_error` and `max_abs_error` columns, and a fixture that typed those
// beside its own result rows would be contract.ts bug #1 exactly: a run
// claiming an MAE of 0.09 over results that average 0.14. So a run row here
// holds only its identity and its per-case judge verdicts, and all three
// numbers are computed from those verdicts against the cases' human scores —
// which is also what makes `GET /runs` and `GET /runs/:id` agree by
// construction rather than by review.
//
// WIRE STRINGS. Column names come from
// schema/observability_sprint4_calibration_schema.sql. `judge_model_id` is
// `NOVA_PRO_MODEL_ID` from lib/judge.ts, imported rather than retyped. Agent
// ids are the fleet's own. Ids are UUIDs because the routes cast
// `CAST(:id AS uuid)` and a portal link carries whatever the list handed it.

import { clock, defineFixture, type ScenarioName } from './core/index.js';
import { pgTimestamp } from './observability.js';
import { NOVA_PRO_MODEL_ID } from '../lib/judge.js';

/**
 * A run's end instant: `minutes` after it started, never after now.
 *
 * `new Date(<a value>)` here PARSES a clock-derived stamp rather than minting
 * one — the distinction rule 3 turns on. A stored `finishedAt` equal to
 * `startedAt` would say a 7-case re-judge of a Bedrock model took zero time,
 * which is the sort of small lie that makes a reader stop trusting the rest of
 * the row.
 */
function finishedAfter(startedAt: string, minutes: number): string {
  const end = Math.min(Date.parse(startedAt) + minutes * 60_000, clock.now().getTime());
  return new Date(end).toISOString();
}

type Row = Record<string, unknown>;

// ── Cases ──────────────────────────────────────────────────────────────────

export interface CalibrationCaseRow {
  calibrationId: string;
  agentId: string;
  prompt: string;
  response: string;
  humanScore: number;
  humanRationale: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  notes: string | null;
}

/**
 * The graded corpus.
 *
 * Eight cases spanning the score spectrum — two excellent, three middling, two
 * poor, one deactivated — because a set that is all good answers cannot detect
 * a judge that is generous, and a set with no inactive row cannot show that
 * `?includeInactive=1` does anything.
 *
 * `empty` — the set has never been seeded. This matters more here than on most
 *           surfaces: `POST /runs` REFUSES on an empty set ("no active
 *           calibration cases — seed the set first"), and that refusal is only
 *           auditable if the empty world is askable.
 * `error` — `observability.calibration_set` is missing, which is the state
 *           before the sprint-4 migration is applied and precisely what the
 *           route's degraded answer is for.
 */
export const calibrationCases = defineFixture<CalibrationCaseRow>({
  key: 'calibration-cases',
  scenarios: {
    default: (): CalibrationCaseRow[] => [
      {
        calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40001',
        agentId: 'orgiq-supervisor',
        prompt: 'Who knows Kubernetes best on the platform team?',
        response:
          'Marcus Müller and Eli Garcia both show strong Kubernetes expertise — Marcus via 6 merged PRs on the ingress controller, Eli via the on-call rotation.',
        humanScore: 0.92,
        humanRationale: 'Names the right two people and says why for each. Nothing to verify by hand.',
        active: true,
        createdAt: clock.daysAgo(61),
        updatedAt: clock.daysAgo(61),
        notes: 'Anchor case for a good routed answer.',
      },
      {
        calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40002',
        agentId: 'orgiq-search',
        prompt: 'Find every decision record mentioning Aurora cold starts.',
        response:
          'Found 3: des-aurora-warmup, des-data-api-retry, des-kb-datasource-init — all cite the 0.5-ACU cold-start gap.',
        humanScore: 0.88,
        humanRationale: 'Complete and each hit is checkable.',
        active: true,
        createdAt: clock.daysAgo(61),
        updatedAt: clock.daysAgo(61),
        notes: null,
      },
      {
        calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40003',
        agentId: 'orgiq-search',
        prompt: 'Who reviewed the CSRF hardening PR?',
        response: 'Simone Chang approved it. There may have been other reviewers.',
        humanScore: 0.55,
        humanRationale: 'Right as far as it goes, but hedges instead of listing the co-reviewer it could have found.',
        active: true,
        createdAt: clock.daysAgo(48),
        updatedAt: clock.daysAgo(48),
        notes: null,
      },
      {
        calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40004',
        agentId: 'orgiq-advisor',
        prompt: 'Which initiative is most at risk of stalling next sprint?',
        response:
          'Several initiatives carry risk. p-kb-migration and p-obs-rollout are both worth watching this sprint.',
        humanScore: 0.42,
        humanRationale: 'Names two without choosing, and gives no reason for either. The question asked for one.',
        active: true,
        createdAt: clock.daysAgo(48),
        updatedAt: clock.daysAgo(30),
        notes: 'Kept because a hedged non-answer is the case judges most often over-score.',
      },
      {
        calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40005',
        agentId: 'orgiq-scoring',
        prompt: 'What is Eli Garcia’s expertise_score trend over 90 days?',
        response: 'Rising: 0.71 → 0.79, driven by 3 merged infra PRs and 1 authored insight.',
        humanScore: 0.9,
        humanRationale: 'Exact figures with their provenance.',
        active: true,
        createdAt: clock.daysAgo(30),
        updatedAt: clock.daysAgo(30),
        notes: null,
      },
      {
        calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40006',
        agentId: 'orgiq-ingestion',
        prompt: 'Process the Confluence export for the auth-migration PRD.',
        response: 'I was unable to process that document.',
        humanScore: 0.15,
        humanRationale: 'Reports failure without the reason, the object, or a next step.',
        active: true,
        createdAt: clock.daysAgo(30),
        updatedAt: clock.daysAgo(30),
        notes: 'The floor of the set — a judge that scores this above 0.4 is broken.',
      },
      {
        calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40007',
        agentId: 'orgiq-graph-builder',
        prompt: 'Merge the newly extracted decision nodes into the graph.',
        response: 'Upserted 4 decision nodes and 9 edges via ON CONFLICT DO UPDATE.',
        humanScore: 0.85,
        humanRationale: 'States exactly what changed and how.',
        active: true,
        createdAt: clock.daysAgo(14),
        updatedAt: clock.daysAgo(14),
        notes: null,
      },
      {
        calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40008',
        agentId: 'orgiq-supervisor',
        prompt: 'Summarize the Q2 reorg for the exec review.',
        response: 'The Q2 reorg moved two teams under the platform org.',
        humanScore: 0.5,
        humanRationale: 'Superseded — the underlying documents were re-ingested and this answer no longer applies.',
        active: false,
        createdAt: clock.daysAgo(74),
        updatedAt: clock.daysAgo(20),
        notes: 'Retired; kept so ?includeInactive=1 has something to include.',
      },
    ],
    empty: () => [],
    error: () => {
      throw new Error('observability.calibration_set unavailable: relation does not exist');
    },
  },
});

/** Case rows in the shape `exec()` returns them, `ORDER BY agent_id, created_at`. */
export function mockCalibrationCases(includeInactive: boolean, scenario?: ScenarioName): Row[] {
  return calibrationCases
    .rows(scenario)
    .filter((c) => includeInactive || c.active)
    .slice()
    .sort((a, b) => a.agentId.localeCompare(b.agentId) || a.createdAt.localeCompare(b.createdAt))
    .map(toCaseRow);
}

/** `WHERE calibration_id = :id` — `[]` when there is no such case, which the route 404s. */
export function mockCalibrationCase(id: string, scenario?: ScenarioName): Row[] {
  const found = calibrationCases.rows(scenario).find((c) => c.calibrationId === id);
  return found ? [toCaseRow(found)] : [];
}

function toCaseRow(c: CalibrationCaseRow): Row {
  return {
    calibration_id: c.calibrationId,
    agent_id: c.agentId,
    prompt: c.prompt,
    response: c.response,
    // `human_score::text` — numeric(4,3) is cast to text by the query so the
    // Data API cannot round it; the route parses it back with Number().
    human_score: c.humanScore.toFixed(3),
    human_rationale: c.humanRationale,
    active: c.active,
    created_at: pgTimestamp(c.createdAt),
    updated_at: pgTimestamp(c.updatedAt),
    notes: c.notes,
  };
}

// ── Runs ───────────────────────────────────────────────────────────────────

/**
 * One re-judge of the whole active set.
 *
 * `verdicts` is what the judge actually said, per case. Everything the
 * `calibration_runs` table stores as a summary — `total_cases`,
 * `mean_abs_error`, `max_abs_error` — is computed from these against the cases'
 * human scores, so the headline MAE on the runs list and the worst-disagreement
 * table on the run detail are two readings of one set of verdicts.
 */
export interface CalibrationRunRow {
  calibrationRunId: string;
  label: string;
  judgeModelId: string;
  startedAt: string;
  finishedAt: string | null;
  notes: string | null;
  verdicts: Array<{ calibrationId: string; judgeScore: number | null; judgeRationale: string | null }>;
}

/**
 * Three months of monthly runs plus an ad-hoc one.
 *
 * The story they tell is the one the page exists for: MAE creeping up run over
 * run, driven mostly by the judge growing generous toward the hedged non-answer
 * (case …0004) and the bare failure report (case …0006). The newest run is the
 * one that crosses 0.15.
 *
 * `empty` — the judge has never been calibrated. Distinct from `error`: the
 *           table is there, nobody has run it, and the page's "no runs yet"
 *           copy is what should show.
 */
export const calibrationRuns = defineFixture<CalibrationRunRow>({
  key: 'calibration-runs',
  scenarios: {
    default: (): CalibrationRunRow[] => [
      {
        calibrationRunId: '7d3e0b52-9a14-4c6f-8e01-33b7f1a20001',
        label: 'monthly@t-60d',
        judgeModelId: NOVA_PRO_MODEL_ID,
        startedAt: clock.daysAgo(60),
        finishedAt: finishedAfter(clock.daysAgo(60), 4),
        notes: 'Baseline after the rubric rewrite.',
        verdicts: [
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40001', judgeScore: 0.9, judgeRationale: 'Specific, grounded, names both people.' },
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40002', judgeScore: 0.86, judgeRationale: 'Complete list with identifiers.' },
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40003', judgeScore: 0.58, judgeRationale: 'Partially answers; hedges at the end.' },
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40004', judgeScore: 0.47, judgeRationale: 'Lists candidates without committing.' },
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40005', judgeScore: 0.89, judgeRationale: 'Figures and provenance both present.' },
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40006', judgeScore: 0.19, judgeRationale: 'Reports failure with no detail.' },
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40007', judgeScore: 0.83, judgeRationale: 'States the mutation precisely.' },
        ],
      },
      {
        calibrationRunId: '7d3e0b52-9a14-4c6f-8e01-33b7f1a20002',
        label: 'monthly@t-30d',
        judgeModelId: NOVA_PRO_MODEL_ID,
        startedAt: clock.daysAgo(30),
        finishedAt: finishedAfter(clock.daysAgo(30), 5),
        notes: null,
        verdicts: [
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40001', judgeScore: 0.93, judgeRationale: 'Specific and grounded.' },
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40002', judgeScore: 0.84, judgeRationale: 'Complete list.' },
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40003', judgeScore: 0.66, judgeRationale: 'Answers the question; the hedge is minor.' },
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40004', judgeScore: 0.61, judgeRationale: 'Covers the risk landscape.' },
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40005', judgeScore: 0.9, judgeRationale: 'Exact.' },
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40006', judgeScore: 0.31, judgeRationale: 'Honest about failing.' },
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40007', judgeScore: 0.87, judgeRationale: 'Clear and checkable.' },
        ],
      },
      {
        calibrationRunId: '7d3e0b52-9a14-4c6f-8e01-33b7f1a20003',
        label: 'adhoc@post-prompt-bump',
        judgeModelId: NOVA_PRO_MODEL_ID,
        startedAt: clock.daysAgo(9),
        finishedAt: finishedAfter(clock.daysAgo(9), 6),
        notes: 'Smoke run after the supervisor prompt revision landed.',
        verdicts: [
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40001', judgeScore: 0.94, judgeRationale: 'Specific and grounded.' },
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40002', judgeScore: 0.85, judgeRationale: 'Complete list.' },
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40003', judgeScore: 0.69, judgeRationale: 'Reads as a full answer.' },
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40004', judgeScore: 0.68, judgeRationale: 'Thorough survey of the risks.' },
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40005', judgeScore: 0.91, judgeRationale: 'Exact.' },
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40006', judgeScore: 0.36, judgeRationale: 'Transparent about the failure.' },
          // One case the judge could not grade at all: the route writes a NULL
          // judge_score and a NULL abs_error, and the run's MAE has to be taken
          // over the cases it DID grade. A corpus where every case scored would
          // never exercise that.
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40007', judgeScore: null, judgeRationale: null },
        ],
      },
      {
        calibrationRunId: '7d3e0b52-9a14-4c6f-8e01-33b7f1a20004',
        label: 'monthly@current',
        judgeModelId: NOVA_PRO_MODEL_ID,
        startedAt: clock.hoursAgo(20),
        finishedAt: finishedAfter(clock.hoursAgo(20), 7),
        notes: 'MAE past the 0.15 line — the quality history needs a re-anchor.',
        verdicts: [
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40001', judgeScore: 0.95, judgeRationale: 'Specific and grounded.' },
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40002', judgeScore: 0.9, judgeRationale: 'Complete list.' },
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40003', judgeScore: 0.82, judgeRationale: 'Answers the question well.' },
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40004', judgeScore: 0.74, judgeRationale: 'Balanced and comprehensive.' },
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40005', judgeScore: 0.93, judgeRationale: 'Exact.' },
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40006', judgeScore: 0.52, judgeRationale: 'Communicates the outcome clearly.' },
          { calibrationId: '2f1c8a40-6b71-4f0e-9d2c-11a5c9e40007', judgeScore: 0.88, judgeRationale: 'Clear and checkable.' },
        ],
      },
    ],
    empty: () => [],
    error: () => {
      throw new Error('observability.calibration_runs unavailable: relation does not exist');
    },
  },
});

/**
 * A run's per-case absolute error, and the two run-level numbers taken over it.
 *
 * A verdict whose case no longer exists is dropped, because the route's own
 * query joins `calibration_set` — a case deleted after a run leaves its result
 * unreachable, and a mock that still counted it would report an MAE the detail
 * table could not reproduce.
 */
function summarize(run: CalibrationRunRow, scenario?: ScenarioName): {
  graded: Array<{ verdict: CalibrationRunRow['verdicts'][number]; case_: CalibrationCaseRow; absError: number | null }>;
  totalCases: number;
  meanAbsError: number | null;
  maxAbsError: number | null;
} {
  const byId = new Map(calibrationCases.rows(scenario).map((c) => [c.calibrationId, c]));
  const graded = run.verdicts
    .map((verdict) => {
      const case_ = byId.get(verdict.calibrationId);
      if (!case_) return null;
      const absError = verdict.judgeScore === null
        ? null
        : Math.round(Math.abs(verdict.judgeScore - case_.humanScore) * 1000) / 1000;
      return { verdict, case_, absError };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const errors = graded.map((g) => g.absError).filter((e): e is number => e !== null);
  return {
    graded,
    // `total_cases` is how many cases the run covered — counted here, never
    // stored on the run.
    totalCases: graded.length,
    meanAbsError: errors.length > 0
      ? Math.round((errors.reduce((a, b) => a + b, 0) / errors.length) * 1000) / 1000
      : null,
    maxAbsError: errors.length > 0 ? Math.max(...errors) : null,
  };
}

function toRunRow(run: CalibrationRunRow, scenario?: ScenarioName): Row {
  const s = summarize(run, scenario);
  return {
    calibration_run_id: run.calibrationRunId,
    label: run.label,
    judge_model_id: run.judgeModelId,
    total_cases: s.totalCases,
    // numeric(4,3)::text, same as the query.
    mean_abs_error: s.meanAbsError === null ? null : s.meanAbsError.toFixed(3),
    max_abs_error: s.maxAbsError === null ? null : s.maxAbsError.toFixed(3),
    started_at: pgTimestamp(run.startedAt),
    finished_at: run.finishedAt === null ? null : pgTimestamp(run.finishedAt),
    notes: run.notes,
  };
}

/** GET /runs — newest first, `LIMIT :lim`. */
export function mockCalibrationRuns(limit: number, scenario?: ScenarioName): Row[] {
  return calibrationRuns
    .rows(scenario)
    .slice()
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, Math.max(0, limit))
    .map((r) => toRunRow(r, scenario));
}

/** GET /runs/:id — the run header. `[]` when unknown, which the route 404s. */
export function mockCalibrationRun(id: string, scenario?: ScenarioName): Row[] {
  const run = calibrationRuns.rows(scenario).find((r) => r.calibrationRunId === id);
  return run ? [toRunRow(run, scenario)] : [];
}

/** GET /runs/:id — the joined result rows, worst disagreement first. */
export function mockCalibrationResults(id: string, scenario?: ScenarioName): Row[] {
  const run = calibrationRuns.rows(scenario).find((r) => r.calibrationRunId === id);
  if (!run) return [];
  return summarize(run, scenario)
    .graded
    .slice()
    .sort((a, b) =>
      nullsLast(b.absError) - nullsLast(a.absError) || a.case_.agentId.localeCompare(b.case_.agentId))
    .map(({ verdict, case_, absError }) => ({
      calibration_run_id: run.calibrationRunId,
      calibration_id: verdict.calibrationId,
      judge_score: verdict.judgeScore === null ? null : verdict.judgeScore.toFixed(3),
      judge_rationale: verdict.judgeRationale,
      abs_error: absError === null ? null : absError.toFixed(3),
      agent_id: case_.agentId,
      prompt: case_.prompt,
      response: case_.response,
      human_score: case_.humanScore.toFixed(3),
      human_rationale: case_.humanRationale,
    }));
}

/** `ORDER BY abs_error DESC NULLS LAST` — an ungraded case sorts to the bottom. */
function nullsLast(v: number | null): number {
  return v === null ? Number.NEGATIVE_INFINITY : v;
}

// ── Writes ─────────────────────────────────────────────────────────────────
//
// These mutate the registered fixture, so `POST /api/__mock/reset` undoes a
// demo edit — the contract every write in this repo's mock layer keeps.

export function mockInsertCalibrationCase(input: {
  calibrationId: string;
  agentId: string;
  prompt: string;
  response: string;
  humanScore: number;
  humanRationale: string | null;
  active: boolean;
  notes: string | null;
}): Row {
  const now = clock.nowIso();
  const row: CalibrationCaseRow = { ...input, createdAt: now, updatedAt: now };
  calibrationCases.rows().push(row);
  return toCaseRow(row);
}

export function mockUpdateCalibrationCase(
  id: string,
  patch: Partial<Omit<CalibrationCaseRow, 'calibrationId' | 'createdAt' | 'updatedAt'>>,
): Row | null {
  const row = calibrationCases.rows().find((c) => c.calibrationId === id);
  if (!row) return null;
  Object.assign(row, patch, { updatedAt: clock.nowIso() });
  return toCaseRow(row);
}

/** DELETE is a soft delete — `SET active = false`, same as the route's SQL. */
export function mockDeactivateCalibrationCase(id: string): Row | null {
  return mockUpdateCalibrationCase(id, { active: false });
}
