// Assessment provider — every read/write the /api/assessment routes need.
//
// MOCK_AURORA is the path that must work (see middleware/src/mock/assessment.ts
// for the fixture). The Aurora-backed path (providers/assessment-aurora.ts)
// now covers every exported function here — none of it has run against a
// live Aurora cluster (none is reachable in this environment); see
// assessment-aurora.ts's header comment.
//
// The one deterministic, load-bearing piece here is applyScores(): an agent
// (orgiq-assessment-scorer / orgiq-assessment-drafter) never writes a score
// directly. It emits a JSON payload and THIS function validates dimension
// ids, the confidence vocabulary, the self-rating-only cap, and dimension
// relevance before mutating state — mirroring the source app's
// `sdlcd assess apply-scores` deterministic verb.

import { randomBytes, randomUUID } from 'node:crypto';
import { assertLegacyDocumentWritable } from './document-legacy-write.js';
import { config } from '../config.js';
import { noteSearchWrite } from '../lib/search-index/writes.js';
import { clock } from '../mock/core/index.js';
import * as M from '../mock/assessment.js';
import { assessmentBroker } from '../lib/assessment-broker.js';
import { legacyThreadMoved } from './document-comment-import.js';
import { NotFoundError } from '../lib/async-handler.js';
import * as A from './assessment-aurora.js';
import { sourceConfigured, readSourceTree, readSourcePage } from './document-source.js';
import { assessmentRunInput, DECK_COMMANDS } from '../lib/assessment-run-input.js';
import { invalidateChannel } from '../lib/gateway/authority-invalidation.js';

// ─── Wire types (mirrors the source's ui/src/components/assessment/types.ts) ─

export type Cohort = M.Cohort;

export type CertificationStatus = 'verified' | 'claim_open' | 'not_applicable' | 'pending';

export interface TeamCertification {
  target_level: number;
  at_or_above_target: number;
  /**
   * The other two halves of `at_or_above_target`, over the SAME set (the
   * dimensions verification has actually reached a level on): `below_target`
   * = assessed − at_or_above_target, `above_target` = strictly above it.
   * Both are in the source app's own team rollup
   * (sdlcd/assessment/certification.py `certify_team`) and were dropped in
   * the port, so the portal declared them and read nothing — a team that has
   * cleared the bar on some dimensions and fallen short on others could
   * state the first count and not the second.
   *
   * Selectors over the same level list `at_or_above_target` counts, never a
   * stored number: `at_or_above_target + below_target === assessed` holds by
   * construction, and `above_target <= at_or_above_target`.
   */
  below_target: number;
  above_target: number;
  assessed: number;
  applicable: number;
  not_applicable: number;
  claims_open: number;
  max_verified_level: number | null;
  highest_verified_level: number | null;
  basis: string;
  status: CertificationStatus;
  headline: string;
  subline: string | null;
}

export interface DimensionCertification {
  verified_level: number | null;
  claimed_level: number | null;
  /** claimed − verified. A NUMBER: how far apart the two tracks are. It is
   *  not, and never was, the sentence naming what would close the gap — see
   *  `to_verify_higher`. */
  verification_gap: number | null;
  basis: string;
  status: CertificationStatus;
  meets_target: boolean;
  target_level: number;
  statement: string;
  /**
   * "To verify higher: <the artifact we would need>." — the evidence ask, in
   * the source app's own words (sdlcd/assessment/certification.py's
   * `certify_dimension`). Empty string when there is nothing above this
   * dimension to reach: nothing verified yet, N/A, or already at Level 5.
   *
   * The portal has read this field since it was ported and the server never
   * sent it, so `Recommendation.what_would_help` was always empty and
   * DimensionMasterDetail's "To confirm a higher level, we would need …"
   * never rendered. It is computed, not stored, so it cannot fall out of
   * step with the level it is one above.
   */
  to_verify_higher: string;
}

export interface TeamSummary {
  id: string;
  name: string;
  cohort: Cohort;
  cohort_label: string;
  status: string;
  assessment_lead: string;
  workflow_step: number;
  workflow_step_label: string;
  /**
   * The full six-step ladder, same shape and same labels the detail wire
   * sends (`TeamDetailResponse.workflow_steps`) — built by the same
   * `buildWorkflowSteps` below, never a second copy. Added so the desk table
   * can render `<WorkflowStepper>` per row instead of a bare "n/6 · label"
   * chip.
   */
  workflow_steps: WorkflowStepInfo[];
  certification: TeamCertification;
  dimensions_assessed: number;
  dimensions_total: number;
  followups_open: number;
  updated_at: string;
  contributors: { initials: string; name: string }[];
}

export interface TeamDetail {
  id: string;
  name: string;
  cohort: Cohort;
  cohort_label: string;
  status: string;
  assessment_lead: string;
  contacts: string[];
  repos: M.RepoRef[];
  workflow_step: number;
  workflow_step_label: string;
  certification: TeamCertification;
  dimensions_assessed: number;
  dimensions_total: number;
  followups_open: number;
  updated_at: string;
}

export interface WorkflowStepInfo {
  step: number;
  label: string;
  done: boolean;
  active: boolean;
}

/**
 * A scored evidence row as the scorecard renders it: the stored row plus the
 * lineage record its `source_ref` names, resolved against the team's
 * provenance ledger. `null` when the ref points at nothing the ledger holds
 * (free-text refs, and rows whose PROV- id predates the ledger) — a missing
 * record is stated, never faked.
 *
 * The portal has declared `Evidence.provenance` as REQUIRED since the port
 * and the server sent no such key, so every evidence card fell back to the
 * bare `source_ref` string. The source app resolves it the same way
 * (`_provenance_out` in sdlcd/workflows/team_dashboard/api/assessment.py).
 */
export interface EvidenceOut extends M.Evidence {
  provenance: M.Provenance | null;
}

/**
 * One "Criteria to Level Up" bullet, and whether this dimension has reached
 * the level that bullet unlocks. Shape ported verbatim from the source app's
 * `CriterionStatus` (sdlcd/assessment/models.py).
 *
 * ⚠️ `met` is derived from the VERIFIED LEVEL, not from a per-bullet
 * judgement — nothing in this port judges bullets individually, and the
 * source app's own field is a model default that no command ever fills
 * (every `workspace/teams/TEAM-NNN/assessment.json` there carries
 * `criteria_progress: []`).
 * The derivation is sound because the rubric defines level N as exactly the
 * level-up criteria listed at level N−1: verifying N is the finding that
 * those bullets hold. It says nothing stronger than the level already says.
 */
export interface CriterionProgress {
  text: string;
  /** The level this bullet unlocks — i.e. the bullet is listed at `target_level - 1`. */
  target_level: number;
  met: boolean;
  /** The scored evidence that carried verification to `target_level`. Empty for an open bullet. */
  evidence_ids: string[];
}

export interface DimensionOut {
  id: string;
  title: string;
  definition: string;
  na_description: string;
  current_level: number | null;
  is_na: boolean;
  confidence: M.Confidence;
  certification: DimensionCertification;
  level_name: string | null;
  rubric_levels: M.RubricLevel[];
  next_level_criteria: string[];
  evidence: EvidenceOut[];
  follow_up_questions: M.FollowUpQuestion[];
  criteria_progress: CriterionProgress[];
  history: M.DimensionHistoryEntry[];
}

export interface TeamDetailResponse {
  team: TeamDetail;
  workflow_steps: WorkflowStepInfo[];
  dimensions: DimensionOut[];
}

/**
 * The lean cross-team shape the maturity heatmap actually reads — one row
 * per dimension, just the fields `MaturityHeatmap`/`HeatmapCell`
 * (portal/src/pages/assessment/ReportsPage.tsx) draw from: no rubric levels,
 * evidence, follow-ups or history. `getDimensionIndex` below computes it from
 * the SAME per-team rows `assembleTeamDetail` does, so this can never disagree
 * with what `GET /teams/:id` shows for the same team.
 */
export interface DimensionIndexEntry {
  id: string;
  title: string;
  current_level: number | null;
  is_na: boolean;
  certification: Pick<DimensionCertification, 'verified_level' | 'claimed_level' | 'statement'>;
}

export interface DimensionIndexResponse {
  teams: Array<{ id: string; dimensions: DimensionIndexEntry[] }>;
}

/** Update on write (lib/search-index/assessment.ts): the writers below re-project what they changed after their commit. */
const searchRefs = () => import('../lib/search-index/assessment-refs.js');

export const WORKFLOW_STEP_LABELS = ['Intake', 'Classify', 'Score', 'Review', 'Publish', 'Follow-up'] as const;

/** The one place `WORKFLOW_STEP_LABELS` becomes a `WorkflowStepInfo[]` — shared by the summary and detail wires so they cannot disagree. */
export function buildWorkflowSteps(currentStep: number): WorkflowStepInfo[] {
  return WORKFLOW_STEP_LABELS.map((label, i) => ({
    step: i + 1, label, done: i + 1 < currentStep, active: i + 1 === currentStep,
  }));
}

// ─── Small runtime helpers ────────────────────────────────────────────────

/** Whitespace/case/punctuation-insensitive key for "is this the same question". */
export function normalizeQuestion(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function hex(n = 12): string {
  return randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

function stampNow(): string {
  return clock.nowIso().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// Prototype pollution: there used to be MOCK_* object literals here keyed by
// a caller-supplied id (envelope id, knowledge doc id), and bracket access on
// a plain object with the literal key "__proto__" returns Object.prototype
// itself rather than undefined — so `envelope_ids: ['__proto__']` read as a
// hit and the next `env.status = …` wrote to the shared prototype. An
// `ownEntry(map, key)` helper guarded every such lookup.
//
// The maps are gone: those collections are `defineFixture` ROWS now
// (mock/assessment.ts), so every caller-keyed lookup is a `.find()` over an
// array and the hazard is structural rather than remembered. `ownEntry` went
// with them — a guard with no call sites, above a comment describing maps
// that no longer exist, reads as protection that is still running.
// Re-verified against the live mock surface: `__proto__` as a doc id,
// envelope id, dimension id, scoring-log stamp and exception dimension all
// answer 404 / "unknown dimension", none of them a hit.
const TEAM_ID_RE = /^TEAM-[A-Za-z0-9-]+$/;
export function isValidTeamId(id: string): boolean {
  return typeof id === 'string' && TEAM_ID_RE.test(id) && !id.includes('..');
}

// ─── Certification (ported from the source's certification stance) ────────

function basisFromConfidence(confidence: M.Confidence): string {
  if (confidence === 'high') return 'verified';
  if (confidence === 'moderate') return 'documented';
  return 'self-attested';
}

function dimensionStatus(score: M.MockDimensionScore): CertificationStatus {
  if (score.is_na) return 'not_applicable';
  const verified = score.current_level;
  const claimed = score.self_claimed_level;
  if (verified === null) return 'pending';
  if (claimed !== null && claimed > verified) return 'claim_open';
  return 'verified';
}

/** The rubric's top level. Levels 4–5 are exceptional; see docs/assessment-tenant.md. */
const MAX_LEVEL = 5;

/**
 * What verifying `level` on this dimension would take — named as an artifact
 * a reader who does not work on the team would recognise, never as an
 * evidence class. Ported from the source app's `_requirement_for`, with the
 * level name read from THIS dimension's rubric rather than a global map.
 */
function requirementForLevel(dimensionId: string, level: number): string {
  if (level >= MAX_LEVEL) {
    return 'evidence that this has held up over time, such as trend data or '
      + 'the same measurement repeated across several cycles';
  }
  if (level === 4) {
    return 'evidence we can check for ourselves, such as a pipeline, dashboard, '
      + 'or report showing that this is measured';
  }
  const name = M.levelName(dimensionId, level);
  return name ? `consistent practice at Level ${level} (${name})` : 'consistent practice at the next level';
}

function dimensionStatement(score: M.MockDimensionScore, status: CertificationStatus): string {
  const verified = score.current_level;
  const claimed = score.self_claimed_level;
  if (status === 'not_applicable') return 'Not applicable — approved exception.';
  const verifiedText = verified === null ? 'Not yet verified' : `Verified up to Level ${verified}`;
  if (claimed === null) return `${verifiedText} · no claim on file`;
  if (verified !== null && claimed === verified) return `Verified at Level ${verified} — matches the team's own rating`;
  if (verified !== null && claimed < verified) {
    return `Verified at Level ${verified} — the evidence supports more than the team's own rating (Level ${claimed})`;
  }
  return `Claimed Level ${claimed} · ${verifiedText}`;
}

export function dimensionCertification(score: M.MockDimensionScore, targetLevel: number): DimensionCertification {
  const status = dimensionStatus(score);
  const verified = score.is_na ? null : score.current_level;
  const claimed = score.is_na ? null : score.self_claimed_level;
  const gap = claimed !== null && verified !== null ? claimed - verified : null;
  // One above what evidence has actually reached — never one above the claim,
  // which would ask the team to prove a level nothing supports yet.
  const nextLevel = verified !== null && verified < MAX_LEVEL ? verified + 1 : null;
  return {
    verified_level: verified,
    claimed_level: claimed,
    verification_gap: gap,
    basis: basisFromConfidence(score.confidence),
    status,
    meets_target: verified !== null && verified >= targetLevel,
    target_level: targetLevel,
    statement: dimensionStatement(score, status),
    to_verify_higher: nextLevel === null
      ? ''
      : `To verify higher: ${requirementForLevel(score.dimension_id, nextLevel)}.`,
  };
}

export function teamCertification(dims: M.MockDimensionScore[], targetLevel: number): TeamCertification {
  const applicable = dims.filter((d) => !d.is_na);
  const assessedDims = applicable.filter((d) => d.current_level !== null);
  const atOrAbove = assessedDims.filter((d) => (d.current_level as number) >= targetLevel).length;
  const above = assessedDims.filter((d) => (d.current_level as number) > targetLevel).length;
  const claimsOpen = dims.filter((d) => dimensionStatus(d) === 'claim_open').length;
  const notApplicable = dims.filter((d) => d.is_na).length;
  const verifiedLevels = assessedDims.map((d) => d.current_level as number);
  const maxVerified = verifiedLevels.length > 0 ? Math.max(...verifiedLevels) : null;
  const assessed = assessedDims.length;
  const applicableCount = applicable.length;

  let headline: string;
  if (assessed === 0) {
    headline = 'Not yet assessed';
  } else if (atOrAbove >= 1) {
    headline = `Verified to Level ${targetLevel} on ${atOrAbove} of ${applicableCount} dimensions`;
  } else if (maxVerified === null) {
    headline = `Working toward Level ${targetLevel}`;
  } else {
    headline = `Working toward Level ${targetLevel} · verified up to Level ${maxVerified}`;
  }

  const sublineParts: string[] = [];
  if (claimsOpen > 0) {
    sublineParts.push(`Claims above verification on ${claimsOpen} dimension${claimsOpen === 1 ? '' : 's'} — evidence requested`);
  }
  if (assessed < applicableCount) {
    sublineParts.push(`${assessed} of ${applicableCount} dimensions assessed`);
  }

  const status: CertificationStatus = assessed === 0 ? 'pending' : claimsOpen > 0 ? 'claim_open' : 'verified';
  // Weakest confidence band present among assessed dims — the honest "basis" for the whole team.
  const confidences = assessedDims.map((d) => d.confidence);
  const basis = confidences.includes('low')
    ? basisFromConfidence('low')
    : confidences.includes('moderate')
      ? basisFromConfidence('moderate')
      : confidences.length > 0
        ? basisFromConfidence('high')
        : 'self-attested';

  return {
    target_level: targetLevel,
    at_or_above_target: atOrAbove,
    // Counted here, not stored: `below_target` is the rest of `assessed`, so
    // the two can never disagree with the number they partition.
    below_target: assessed - atOrAbove,
    above_target: above,
    assessed,
    applicable: applicableCount,
    not_applicable: notApplicable,
    claims_open: claimsOpen,
    max_verified_level: maxVerified,
    highest_verified_level: maxVerified,
    basis,
    status,
    headline,
    subline: sublineParts.length > 0 ? sublineParts.join(' · ') : null,
  };
}

// ─── Team summaries / detail ────────────────────────────────────────────────

function followupsOpenCount(dims: Record<string, M.MockDimensionScore>): number {
  return Object.values(dims).reduce(
    (n, d) => n + d.follow_up_questions.filter((q) => q.status === 'OPEN').length, 0,
  );
}

function teamSummaryFromDims(team: M.MockTeam, dims: Record<string, M.MockDimensionScore>, targetLevel: number): TeamSummary {
  const dimList = Object.values(dims);
  return {
    id: team.id, name: team.name, cohort: team.cohort, cohort_label: M.COHORT_LABELS[team.cohort],
    // Derived, always. A stored status is what let a team read "New" beside
    // "17/17 assessed": nothing bumped the column when the scores landed.
    // Aurora's `assessment_teams.status` even defaults to 'active', which is
    // not one of the three values formatTeamStatus knows how to render.
    status: M.deriveTeamStatus(dims), assessment_lead: team.assessment_lead, workflow_step: team.workflow_step,
    workflow_step_label: WORKFLOW_STEP_LABELS[team.workflow_step - 1] ?? '',
    workflow_steps: buildWorkflowSteps(team.workflow_step),
    certification: teamCertification(dimList, targetLevel),
    dimensions_assessed: dimList.filter((d) => !d.is_na && d.current_level !== null).length,
    dimensions_total: M.DIMENSION_IDS.length,
    followups_open: followupsOpenCount(dims),
    updated_at: team.updated_at,
    contributors: team.contributors,
  };
}

function teamSummary(team: M.MockTeam): TeamSummary {
  return teamSummaryFromDims(team, M.scoresFor(team.id) ?? {}, M.configuration().target_level);
}

export async function listTeams(): Promise<TeamSummary[]> {
  if (config.mock.aurora) return M.teams().map(teamSummary);
  const [teams, dimsByTeam, cfg] = await Promise.all([A.fetchAllTeams(), A.fetchAllDimensionScores(), A.fetchConfiguration()]);
  return teams.map((team) => teamSummaryFromDims(team, dimsByTeam.get(team.id) ?? {}, cfg.target_level));
}

export async function createTeam(...a: Parameters<typeof createTeamImpl>): ReturnType<typeof createTeamImpl> {
  const result = await createTeamImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentTeamRefs([result.id])); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function createTeamImpl(input: { name: string; cohort: Cohort; assessment_lead?: string }): Promise<M.MockTeam> {
  if (config.mock.aurora) {
    const id = M.nextTeamId();
    // The fixture's clock, not the wall clock — this row joins the same
    // fixture the seeded teams live in, and a frozen clock in a test has to
    // reach it too (mock floor rule 3, provider half).
    const now = clock.nowIso();
    const team: M.MockTeam = {
      id, name: input.name, cohort: input.cohort, workflow_step: 1,
      assessment_lead: input.assessment_lead ?? '', contacts: [], repos: [], archetype: null,
      // Matches `assessment_teams.rubric_version`'s own DEFAULT, so a team
      // created here and one created by the Aurora INSERT name the same rubric.
      rubric_version: M.DEFAULT_RUBRIC_VERSION,
      exceptions: [], created_at: now, updated_at: now, contributors: [],
    };
    M.teams().push(team);
    M.setScoresFor(id, M.blankDimensions());
    M.ensureProvenanceFor(id);
    // The row carries no status; the response does, derived from the blank
    // sheet just created (so: NEW). Same wire shape, one fewer place to drift.
    return { ...team, status: M.teamStatus(id) };
  }
  const id = await A.nextTeamId();
  return A.createTeamRow({ id, name: input.name, cohort: input.cohort, assessment_lead: input.assessment_lead ?? '' });
}

function emptyScore(dimensionId: string): M.MockDimensionScore {
  return {
    dimension_id: dimensionId, current_level: null, is_na: false, confidence: 'low',
    self_claimed_level: null, evidence_class: null, cap_applied: false,
    evidence: [], follow_up_questions: [], history: [], updated_at: clock.nowIso(),
  };
}

/**
 * The bullets a dimension has to clear to reach `level`. The rubric lists
 * them at the level BELOW the one they unlock — level 0's `level_up_criteria`
 * are what takes a team from 0 to 1 — so reaching `level` means clearing the
 * list at `level - 1`. Same lookup the source app does
 * (`assessment.py`'s `next_level_criteria`: `lv.level == da.current_level`).
 */
function criteriaToReach(def: M.RubricDimensionDef, level: number): string[] {
  return def.levels.find((l) => l.level === level - 1)?.level_up_criteria ?? [];
}

/**
 * "Criteria checked" — what verification has cleared on this dimension, and
 * what is immediately in front of it. Two blocks, never a wall of every
 * rubric bullet:
 *
 *   met  — the list that reaching the verified level required. Reaching
 *          level N under this rubric IS clearing the bullets at N−1, so this
 *          restates the level rather than adding a claim to it. Its
 *          `evidence_ids` are the scored rows that actually carried the
 *          dimension to that level (`supports_level >= verified`), so a
 *          reader can go from the bullet to the artifact.
 *   open  — the list for the next level up. `met: false` and no evidence:
 *          nothing has been shown for these yet.
 *
 * Empty for an approved N/A (nothing to reach) and for a dimension verified
 * at Level 5 with nothing above it — the source app's `to_verify_higher`
 * takes the same "nothing above this" stance.
 */
function criteriaProgress(def: M.RubricDimensionDef, score: M.MockDimensionScore): CriterionProgress[] {
  if (score.is_na) return [];
  const verified = score.current_level;
  const out: CriterionProgress[] = [];
  if (verified !== null && verified >= 1) {
    const evidenceIds = score.evidence
      .filter((e) => e.scored && e.supports_level !== null && e.supports_level >= verified)
      .map((e) => e.evidence_id);
    for (const text of criteriaToReach(def, verified)) {
      out.push({ text, target_level: verified, met: true, evidence_ids: evidenceIds });
    }
  }
  // One above what evidence has reached — never one above the claim. An
  // unassessed dimension's next rung is Level 1, not Level 0: level 0 is
  // "Below Baseline", which has no criteria to have met.
  const nextLevel = verified === null ? 1 : verified + 1;
  if (nextLevel <= MAX_LEVEL) {
    for (const text of criteriaToReach(def, nextLevel)) {
      out.push({ text, target_level: nextLevel, met: false, evidence_ids: [] });
    }
  }
  return out;
}

function buildDimensionOut(
  score: M.MockDimensionScore, targetLevel: number, provenance: M.Provenance[],
): DimensionOut {
  const def = M.rubricDimension(score.dimension_id)!;
  // What it would take to go up ONE level from where verification stands —
  // the criteria listed at the current level, which is the rung above it.
  // This read `current_level + 1` and so answered with the rung after next:
  // a dimension verified at Level 2 was told to "establish and monitor CI
  // performance metrics" (the Level 3→4 ask) instead of what Level 3 needs.
  // An approved N/A has no rung above it, so it gets no ask — the same
  // stance `to_verify_higher` and `criteria_progress` take. It used to
  // answer with Level 0's list, offering a route to Level 1 on a dimension
  // that had been excused from the rubric.
  const nextLevel = score.is_na
    ? undefined
    : score.current_level === null
      ? def.levels.find((l) => l.level === 0)
      : def.levels.find((l) => l.level === score.current_level);
  return {
    id: def.id, title: def.title, definition: def.definition, na_description: def.na_description,
    current_level: score.current_level, is_na: score.is_na, confidence: score.confidence,
    certification: dimensionCertification(score, targetLevel),
    level_name: M.levelName(def.id, score.current_level),
    rubric_levels: def.levels, next_level_criteria: nextLevel?.level_up_criteria ?? [],
    evidence: score.evidence.map((e) => ({
      ...e,
      provenance: provenance.find((p) => p.provenance_id === e.source_ref) ?? null,
    })),
    follow_up_questions: score.follow_up_questions,
    criteria_progress: criteriaProgress(def, score), history: score.history,
  };
}

function assembleTeamDetail(
  team: M.MockTeam, dims: Record<string, M.MockDimensionScore>, targetLevel: number,
  provenance: M.Provenance[],
): TeamDetailResponse {
  const dimensions = M.RUBRIC_DIMENSIONS.map(
    (def) => buildDimensionOut(dims[def.id] ?? emptyScore(def.id), targetLevel, provenance),
  );
  const workflow_steps = buildWorkflowSteps(team.workflow_step);
  const dimList = Object.values(dims);
  const teamDetail: TeamDetail = {
    id: team.id, name: team.name, cohort: team.cohort, cohort_label: M.COHORT_LABELS[team.cohort],
    status: M.deriveTeamStatus(dims), assessment_lead: team.assessment_lead, contacts: team.contacts, repos: team.repos,
    workflow_step: team.workflow_step, workflow_step_label: WORKFLOW_STEP_LABELS[team.workflow_step - 1] ?? '',
    certification: teamCertification(dimList, targetLevel),
    dimensions_assessed: dimList.filter((d) => !d.is_na && d.current_level !== null).length,
    dimensions_total: M.DIMENSION_IDS.length,
    followups_open: followupsOpenCount(dims),
    updated_at: team.updated_at,
  };
  return { team: teamDetail, workflow_steps, dimensions };
}

/**
 * Does team `id` exist right now? The resource half of GET /teams/:id (which
 * 404s an unknown team) without assembling the detail — the realtime gateway
 * asks it for `assessment:team:<id>` on every decision (lib/page-resources.ts).
 */
export async function teamExists(id: string): Promise<boolean> {
  if (!isValidTeamId(id)) return false;
  if (config.mock.aurora) return M.teams().some((t) => t.id === id);
  return (await A.fetchTeam(id)) !== null;
}

export async function getTeamDetail(id: string): Promise<TeamDetailResponse | null> {
  if (config.mock.aurora) {
    const team = M.teams().find((t) => t.id === id);
    if (!team) return null;
    return assembleTeamDetail(team, M.scoresFor(id) ?? {}, M.configuration().target_level, M.provenanceFor(id));
  }
  const team = await A.fetchTeam(id);
  if (!team) return null;
  // `fetchProvenanceRaw` is the existing ledger read; only `.historical` is
  // wanted here (the scored evidence comes from fetchDimensionScores), and it
  // is reused rather than adding a narrower query to assessment-aurora.ts.
  const [dims, cfg, prov] = await Promise.all([
    A.fetchDimensionScores(id), A.fetchConfiguration(), A.fetchProvenanceRaw(id),
  ]);
  return assembleTeamDetail(team, dims, cfg.target_level, prov.historical);
}

/**
 * Everything a review deck states, read once through the same assembly the
 * scorecard and the improvement plan use (docs/assessment-deck-goal.md
 * decision 3): the team row (rubric version, approved exceptions), the raw
 * dimension scores (evidence class), the assembled detail (certification per
 * dimension) and the plan (recommendation kinds). Nothing here is recomputed
 * by the deck — lib/assessment-deck/facts.ts only arranges these values.
 */
export interface TeamDeckSource {
  team: M.MockTeam;
  dims: Record<string, M.MockDimensionScore>;
  targetLevel: number;
  detail: TeamDetailResponse;
  plan: TeamPlan;
}

export async function getTeamDeckSource(id: string): Promise<TeamDeckSource | null> {
  if (config.mock.aurora) {
    const team = M.teams().find((t) => t.id === id);
    if (!team) return null;
    const dims = M.scoresFor(id) ?? {};
    const targetLevel = M.configuration().target_level;
    return {
      team, dims, targetLevel,
      detail: assembleTeamDetail(team, dims, targetLevel, M.provenanceFor(id)),
      plan: computeTeamPlan(id, dims, targetLevel, M.storiesFor(id)),
    };
  }
  const team = await A.fetchTeam(id);
  if (!team) return null;
  const [dims, cfg, prov, stories] = await Promise.all([
    A.fetchDimensionScores(id), A.fetchConfiguration(), A.fetchProvenanceRaw(id), A.fetchStories(id),
  ]);
  return {
    team, dims, targetLevel: cfg.target_level,
    detail: assembleTeamDetail(team, dims, cfg.target_level, prov.historical),
    plan: computeTeamPlan(id, dims, cfg.target_level, stories),
  };
}

function dimensionIndexEntry(
  def: M.RubricDimensionDef, score: M.MockDimensionScore, targetLevel: number,
): DimensionIndexEntry {
  const cert = dimensionCertification(score, targetLevel);
  return {
    id: def.id, title: def.title, current_level: score.current_level, is_na: score.is_na,
    certification: { verified_level: cert.verified_level, claimed_level: cert.claimed_level, statement: cert.statement },
  };
}

/**
 * One bulk read for the portfolio heatmap instead of the N `GET /teams/:id`
 * calls `useDimensionIndex` used to fire (one per team, just to read each
 * cell) — see CLAUDE.md's request-budget audit. Every team, every dimension,
 * the verified/claimed levels and the statement — nothing else.
 */
export async function getDimensionIndex(): Promise<DimensionIndexResponse> {
  if (config.mock.aurora) {
    const target = M.configuration().target_level;
    return {
      teams: M.teams().map((team) => {
        const dims = M.scoresFor(team.id) ?? {};
        return {
          id: team.id,
          dimensions: M.RUBRIC_DIMENSIONS.map((def) => dimensionIndexEntry(def, dims[def.id] ?? emptyScore(def.id), target)),
        };
      }),
    };
  }
  const [teams, dimsByTeam, cfg] = await Promise.all([A.fetchAllTeams(), A.fetchAllDimensionScores(), A.fetchConfiguration()]);
  return {
    teams: teams.map((team) => {
      const dims = dimsByTeam.get(team.id) ?? {};
      return {
        id: team.id,
        dimensions: M.RUBRIC_DIMENSIONS.map((def) => dimensionIndexEntry(def, dims[def.id] ?? emptyScore(def.id), cfg.target_level)),
      };
    }),
  };
}

export async function patchTeam(...a: Parameters<typeof patchTeamImpl>): ReturnType<typeof patchTeamImpl> {
  const result = await patchTeamImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentTeamRefs([a[0]])); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function patchTeamImpl(
  id: string, patch: Partial<Pick<M.MockTeam, 'name' | 'cohort' | 'assessment_lead' | 'status'>>,
): Promise<M.MockTeam | null> {
  if (!config.mock.aurora) return A.patchTeamRow(id, patch);
  const team = M.teams().find((t) => t.id === id);
  if (!team) return null;
  if (patch.name !== undefined) team.name = patch.name;
  if (patch.cohort !== undefined) team.cohort = patch.cohort;
  if (patch.assessment_lead !== undefined) team.assessment_lead = patch.assessment_lead;
  // `patch.status` is deliberately NOT honoured: a team's status is
  // deriveTeamStatus(dimensions), and letting a PATCH pin it is precisely how
  // one came to read "New" beside "17/17 assessed". The route still rejects a
  // status that is not one of the three, so the contract is unchanged; the
  // value just no longer overrides the scores.
  team.updated_at = clock.nowIso();
  return { ...team, status: M.teamStatus(team.id) };
}

export async function deleteTeam(...a: Parameters<typeof deleteTeamImpl>): ReturnType<typeof deleteTeamImpl> {
  const result = await deleteTeamImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentTeamRefs([a[0]])); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function deleteTeamImpl(id: string): Promise<boolean> {
  // One call, so a seventh team-keyed fixture can never be forgotten here.
  const deleted = config.mock.aurora ? M.dropTeam(id) : await A.deleteTeamRow(id);
  // The team page's discussion, cursors and lobby admit only an existing team.
  if (deleted) invalidateChannel(`assessment:team:${id}`, 'assessment-team-deleted');
  return deleted;
}

export async function resetAssessment(...a: Parameters<typeof resetAssessmentImpl>): ReturnType<typeof resetAssessmentImpl> {
  const result = await resetAssessmentImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentTeamRefs([a[0]])); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function resetAssessmentImpl(id: string): Promise<boolean> {
  if (!config.mock.aurora) return A.resetTeamAssessment(id);
  const dims = M.scoresFor(id);
  if (!dims) return false;
  const now = clock.nowIso();
  for (const dimId of M.DIMENSION_IDS) {
    const prev = dims[dimId];
    dims[dimId] = {
      dimension_id: dimId, current_level: null, is_na: false, confidence: 'low',
      self_claimed_level: null, evidence_class: null, cap_applied: false,
      evidence: prev?.evidence ?? [], // evidence/lineage are untouched by a reset, only scoring is
      follow_up_questions: [], history: [], updated_at: now,
    };
  }
  const team = M.teams().find((t) => t.id === id);
  // No `status = 'NEW'` here: it follows from the dims that were just blanked.
  if (team) { team.workflow_step = 1; team.updated_at = now; }
  for (const task of M.feedback()) {
    if (task.team_id === id && task.status === 'OPEN') { task.status = 'DISMISSED'; task.resolved_at = now; }
  }
  return true;
}

// ─── Recommendations (computed, never re-derived by an agent) ─────────────

export type RecommendationKind = 'close_claim' | 'advance' | 'answer';

export interface Recommendation {
  dimension_id: string;
  title: string;
  kind: RecommendationKind;
  rank: number;
  rationale: string;
  story_command: string;
  certification: DimensionCertification;
  /**
   * The rubric's own bullets for the level immediately above what is verified
   * — `criteriaToReach`, the same lookup the dimension detail uses.
   *
   * The improvement plan has always had a "What Level N asks for" section and
   * this response never carried the data for it, so the section could not
   * render for any team, on any dimension. Left empty when there is nothing
   * above this dimension to reach (N/A, nothing verified yet, already at the
   * target), which is the same condition that empties `to_verify_higher`.
   */
  next_level_criteria: string[];
  existing_stories: M.StoryDraft[];
}

export interface RecommendationCounts {
  close_claim: number; advance: number; answer: number; sustain: number; not_applicable: number;
}

export interface TeamPlan {
  team_id: string; generated_at: string; target_level: number;
  counts: RecommendationCounts; recommendations: Recommendation[];
}

function classifyDimension(score: M.MockDimensionScore, targetLevel: number): RecommendationKind | 'sustain' | 'not_applicable' {
  if (score.is_na) return 'not_applicable';
  if (dimensionStatus(score) === 'claim_open') return 'close_claim';
  if (score.current_level === null) return 'answer';
  if (score.current_level < targetLevel) return 'advance';
  return 'sustain';
}

function rationaleFor(kind: RecommendationKind, def: M.RubricDimensionDef, score: M.MockDimensionScore, targetLevel: number): string {
  if (kind === 'close_claim') {
    return `The team's own rating sits above what's verified for "${def.title}" (claimed ${score.self_claimed_level}, `
      + `verified ${score.current_level}). Ask for the specific artifact that would let verification go higher — `
      + `never re-score from the claim alone.`;
  }
  if (kind === 'advance') {
    return `"${def.title}" is verified at Level ${score.current_level}, below the Level ${targetLevel} target. `
      + `This is real practice work, not an evidence gap.`;
  }
  return `"${def.title}" has not been assessed yet — nothing is verifiable one way or the other.`;
}

// Pure, storage-agnostic: fed a team's dimension scores + target + its
// existing story drafts, produces the same TeamPlan regardless of whether
// those inputs came from the mock fixtures or Aurora rows.
// Shared by buildTeamPlan (mock) and getTeamRecommendations's Aurora branch,
// same pattern as computeScoreEntry for applyScores.
/**
 * The bullets for the level a dimension is actually working toward: one above
 * what verification has established, and only while that is still under the
 * target. Mirrors `dimensionCertification`'s own "is there anything above this
 * to reach" test so the plan card and the certification line cannot disagree.
 */
function nextLevelCriteria(
  def: M.RubricDimensionDef, score: M.MockDimensionScore, target: number,
): string[] {
  const verified = score.current_level;
  if (score.is_na || verified == null || verified >= target) return [];
  return criteriaToReach(def, verified + 1);
}

function computeTeamPlan(
  teamId: string, dims: Record<string, M.MockDimensionScore>, target: number, stories: M.StoryDraft[],
): TeamPlan {
  const counts: RecommendationCounts = { close_claim: 0, advance: 0, answer: 0, sustain: 0, not_applicable: 0 };
  const buckets: Record<RecommendationKind, Recommendation[]> = { close_claim: [], advance: [], answer: [] };

  for (const dimId of M.DIMENSION_IDS) {
    const score = dims[dimId] ?? emptyScore(dimId);
    const def = M.rubricDimension(dimId)!;
    const kind = classifyDimension(score, target);
    counts[kind] += 1;
    if (kind === 'sustain' || kind === 'not_applicable') continue;
    buckets[kind].push({
      dimension_id: dimId, title: def.title, kind, rank: 0,
      rationale: rationaleFor(kind, def, score, target),
      story_command: `/develop-jira-story team: ${teamId} dimension: ${dimId}`,
      certification: dimensionCertification(score, target),
      next_level_criteria: nextLevelCriteria(def, score, target),
      existing_stories: stories.filter((s) => s.dimension_id === dimId),
    });
  }

  const ordered = [...buckets.close_claim, ...buckets.advance, ...buckets.answer];
  ordered.forEach((r, i) => { r.rank = i + 1; });

  return { team_id: teamId, generated_at: clock.nowIso(), target_level: target, counts, recommendations: ordered };
}

async function buildTeamPlan(teamId: string): Promise<TeamPlan | null> {
  const team = M.teams().find((t) => t.id === teamId);
  if (!team) return null;
  const dims = M.scoresFor(teamId) ?? {};
  const target = M.configuration().target_level;
  return computeTeamPlan(teamId, dims, target, M.storiesFor(teamId));
}

export async function getTeamRecommendations(teamId: string): Promise<TeamPlan | null> {
  if (!config.mock.aurora) {
    const team = await A.fetchTeam(teamId);
    if (!team) return null;
    const [dims, cfg, stories] = await Promise.all([A.fetchDimensionScores(teamId), A.fetchConfiguration(), A.fetchStories(teamId)]);
    return computeTeamPlan(teamId, dims, cfg.target_level, stories);
  }
  return buildTeamPlan(teamId);
}

export async function listPortfolioRecommendations(cohort?: Cohort): Promise<{
  generated_at: string;
  teams: Array<{ id: string; name: string; cohort: Cohort; counts: RecommendationCounts; top: Recommendation | null }>;
  skipped: string[];
}> {
  if (!config.mock.aurora) {
    const [allTeams, allDims, cfg, allStories] = await Promise.all([
      A.fetchAllTeams(), A.fetchAllDimensionScores(), A.fetchConfiguration(), A.fetchAllStories(),
    ]);
    const teams = allTeams.filter((t) => !cohort || t.cohort === cohort);
    const rows = teams.map((team) => {
      const plan = computeTeamPlan(team.id, allDims.get(team.id) ?? {}, cfg.target_level, allStories.get(team.id) ?? []);
      return { id: team.id, name: team.name, cohort: team.cohort, counts: plan.counts, top: plan.recommendations[0] ?? null };
    });
    return { generated_at: clock.nowIso(), teams: rows, skipped: [] };
  }
  const teams = M.teams().filter((t) => !cohort || t.cohort === cohort);
  const rows = [];
  for (const team of teams) {
    const plan = await buildTeamPlan(team.id);
    if (!plan) continue;
    rows.push({ id: team.id, name: team.name, cohort: team.cohort, counts: plan.counts, top: plan.recommendations[0] ?? null });
  }
  return { generated_at: clock.nowIso(), teams: rows, skipped: [] };
}

// ─── Stories ────────────────────────────────────────────────────────────────

export async function listStories(teamId: string): Promise<M.StoryDraft[] | null> {
  if (!config.mock.aurora) {
    if (!(await A.teamExists(teamId))) return null;
    return A.fetchStories(teamId);
  }
  if (!M.teams().some((t) => t.id === teamId)) return null;
  return M.storiesFor(teamId);
}

export async function getStory(teamId: string, filename: string): Promise<M.StoryDraft | null> {
  if (!config.mock.aurora) return A.fetchStory(teamId, filename);
  return (M.storiesFor(teamId)).find((s) => s.filename === filename) ?? null;
}

// ─── Evidence ───────────────────────────────────────────────────────────────

export async function listEvidence(teamId: string): Promise<M.Evidence[] | null> {
  if (!config.mock.aurora) {
    if (!(await A.teamExists(teamId))) return null;
    const [dims, pendingLog] = await Promise.all([A.fetchDimensionScores(teamId), A.fetchEvidenceLog(teamId)]);
    const scored = Object.values(dims).flatMap((d) => d.evidence);
    const pending: M.Evidence[] = pendingLog.map((e) => ({
      evidence_id: e.evidence_id, dimension_id: e.dimension_id ?? '', source_type: e.source_type,
      excerpt: e.excerpt, supports_level: e.supports_level, captured_at: e.captured_at,
      source_ref: e.source_ref, scored: false, status: e.status,
    }));
    return [...scored, ...pending];
  }
  const dims = M.scoresFor(teamId);
  if (!dims) return null;
  const scored = Object.values(dims).flatMap((d) => d.evidence);
  const pending: M.Evidence[] = M.evidenceLogFor(teamId).map((e) => ({
    evidence_id: e.evidence_id, dimension_id: e.dimension_id ?? '', source_type: e.source_type,
    excerpt: e.excerpt, supports_level: e.supports_level, captured_at: e.captured_at,
    source_ref: e.source_ref, scored: false, status: e.status,
  }));
  return [...scored, ...pending];
}

export async function uploadEvidence(
  teamId: string, payload: { dimension_id?: string | null; source_type: M.EvidenceSourceType; excerpt: string },
): Promise<M.EvidenceLogItem | null> {
  const item: M.EvidenceLogItem = {
    evidence_id: `EV-${hex()}`, dimension_id: payload.dimension_id ?? null, source_type: payload.source_type,
    excerpt: payload.excerpt, supports_level: null, captured_at: clock.nowIso(),
    source_ref: `PROV-${hex()}`, scored: false, status: 'PENDING',
  };
  if (!config.mock.aurora) {
    if (!(await A.teamExists(teamId))) return null;
    await A.insertEvidenceLogItem(teamId, item);
    return item;
  }
  if (!M.teams().some((t) => t.id === teamId)) return null;
  M.ensureEvidenceLogFor(teamId).push(item);
  return item;
}

// ─── Exceptions ─────────────────────────────────────────────────────────────

export async function listExceptions(teamId: string): Promise<{
  team_id: string; archetype: string | null; archetypes: M.ArchetypeOption[]; exceptions: M.TeamException[];
} | null> {
  if (!config.mock.aurora) {
    const team = await A.fetchTeam(teamId);
    if (!team) return null;
    return { team_id: team.id, archetype: team.archetype, archetypes: M.archetypes(), exceptions: team.exceptions };
  }
  const team = M.teams().find((t) => t.id === teamId);
  if (!team) return null;
  return { team_id: team.id, archetype: team.archetype, archetypes: M.archetypes(), exceptions: team.exceptions };
}

export type PatchExceptionResult =
  | { ok: true; exception: M.TeamException }
  | { ok: false; status: 404 | 409; reason: string };

const SELF_APPROVAL_REASON = 'cannot approve or deny an exception you requested yourself — ask another lead-assessor'
  + ' or program-lead, or have admin resubmit with { override: true }';

/**
 * Approve/deny an N/A exception. Refuses when the approver is the same
 * identity that requested it (`requested_by`) — "N/A is never self-granting"
 * extends to the approval step itself, not just the score claim — UNLESS
 * `patch.override` is set, which the route only honours for an admin
 * session and audit-logs. A `requested_by`-less exception (seeded fixtures,
 * or one opened before this field existed) is never blocked — there is
 * nothing to compare against.
 */
export async function patchException(...a: Parameters<typeof patchExceptionImpl>): ReturnType<typeof patchExceptionImpl> {
  const result = await patchExceptionImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentTeamRefs([a[0]])); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function patchExceptionImpl(
  teamId: string, dimensionId: string,
  patch: { status: 'approved' | 'denied'; approved_by: string; override?: boolean },
): Promise<PatchExceptionResult> {
  if (!config.mock.aurora) {
    const requested = await A.fetchRequestedException(teamId, dimensionId);
    if (!requested) return { ok: false, status: 404, reason: 'no requested exception found for that team/dimension' };
    if (requested.requested_by && requested.requested_by === patch.approved_by && !patch.override) {
      return { ok: false, status: 409, reason: SELF_APPROVAL_REASON };
    }
    const exception = await A.patchExceptionRow(teamId, dimensionId, patch);
    if (!exception) return { ok: false, status: 404, reason: 'no requested exception found for that team/dimension' };
    if (patch.status === 'approved') {
      const dims = await A.fetchDimensionScores(teamId);
      const prev = dims[dimensionId] ?? emptyScore(dimensionId);
      const newScore: M.MockDimensionScore = {
        ...prev, is_na: true, current_level: null, updated_at: exception.approved_at,
      };
      await A.upsertDimensionScore(teamId, newScore);
      await A.insertHistoryRow(teamId, dimensionId, {
        from_level: prev.current_level, to_level: null, is_na: true, na_claimed: false,
        rationale: `N/A exception approved: ${exception.reason}`, evidence_ids: [],
        source_meeting: `teams/${teamId} (exception review)`,
        changed_at: exception.approved_at, changed_by: patch.approved_by,
      });
    }
    await A.touchTeamUpdatedAt(teamId, exception.approved_at);
    return { ok: true, exception };
  }
  const team = M.teams().find((t) => t.id === teamId);
  if (!team) return { ok: false, status: 404, reason: `team ${teamId} not found` };
  const exception = team.exceptions.find((e) => e.dimension_id === dimensionId && e.status === 'requested');
  if (!exception) return { ok: false, status: 404, reason: 'no requested exception found for that team/dimension' };
  if (exception.requested_by && exception.requested_by === patch.approved_by && !patch.override) {
    return { ok: false, status: 409, reason: SELF_APPROVAL_REASON };
  }
  exception.status = patch.status;
  exception.approved_by = patch.approved_by;
  exception.approved_at = clock.nowIso();
  if (patch.status === 'approved') {
    const dims = M.scoresFor(teamId);
    if (dims?.[dimensionId]) {
      dims[dimensionId] = {
        ...dims[dimensionId]!, is_na: true, current_level: null,
        history: [...dims[dimensionId]!.history, {
          from_level: dims[dimensionId]!.current_level, to_level: null, is_na: true,
          rationale: `N/A exception approved: ${exception.reason}`, evidence_ids: [],
          source_meeting: `teams/${teamId} (exception review)`,
          changed_at: exception.approved_at, changed_by: patch.approved_by,
        }],
        updated_at: exception.approved_at,
      };
    }
  }
  team.updated_at = exception.approved_at;
  return { ok: true, exception };
}

// ─── Provenance ─────────────────────────────────────────────────────────────
//
// The "lineage ledger" (Evidence & Intake tab, source's EvidenceIntake.tsx):
// one row per capture event, not per evidence record — a single interview
// transcript can back several dimensions' worth of evidence, so the ledger
// groups by provenance and counts. Two sources feed it: the historical
// provenance entries already linked into dimensions' scored evidence
// (source_ref), and the evidence log's pending intake items (uploaded via
// intakeText/intakeImage/uploadEvidence, not yet scored into a dimension) —
// each of those is its own capture event and gets its own row.

export type LedgerSourceType = 'transcript' | 'document' | 'codebase' | 'teams_chat' | 'web' | 'survey' | 'screenshot' | 'touchpoint';

export interface ProvenanceLedgerItem {
  provenance_id: string;
  source_type: LedgerSourceType;
  source_uri: string;
  name: string;
  captured_at: string;
  captured_by: string;
  content_hash: string;
  evidence_count: number;
  dimensions_touched: string[];
}

export interface ProvenanceLedgerResponse {
  team_id: string;
  items: ProvenanceLedgerItem[];
}

const URI_SCHEME_TO_SOURCE_TYPE: Record<string, LedgerSourceType> = {
  forms: 'survey', transcript: 'transcript', upload: 'document', confluence: 'web',
};

const LOG_SOURCE_TYPE_TO_LEDGER: Record<M.EvidenceSourceType, LedgerSourceType> = {
  survey: 'survey', transcript: 'transcript', document: 'document', artifact: 'screenshot', touchpoint: 'touchpoint',
};

function nameFromUri(uri: string): string {
  const last = uri.split('/').filter(Boolean).pop() ?? uri;
  return decodeURIComponent(last).replace(/[-_]+/g, ' ');
}

function buildProvenanceLedger(
  teamId: string, historicalRaw: M.Provenance[], scoredEvidence: M.Evidence[], pendingLog: M.EvidenceLogItem[],
): ProvenanceLedgerResponse {
  const historical: ProvenanceLedgerItem[] = historicalRaw.map((p) => {
    const linked = scoredEvidence.filter((e) => e.source_ref === p.provenance_id);
    const scheme = p.source_uri.split('://')[0] ?? '';
    return {
      provenance_id: p.provenance_id,
      source_type: URI_SCHEME_TO_SOURCE_TYPE[scheme] ?? 'document',
      source_uri: p.source_uri,
      name: nameFromUri(p.source_uri),
      captured_at: p.captured_at,
      captured_by: p.captured_by,
      content_hash: p.provenance_id.replace(/^PROV-/, ''),
      evidence_count: linked.length,
      dimensions_touched: [...new Set(linked.map((e) => e.dimension_id))],
    };
  });

  const pending: ProvenanceLedgerItem[] = pendingLog.map((e) => ({
    provenance_id: e.source_ref,
    source_type: LOG_SOURCE_TYPE_TO_LEDGER[e.source_type] ?? 'document',
    source_uri: `${e.source_type}://${teamId}/${e.evidence_id}`,
    name: e.title ?? e.excerpt.slice(0, 60),
    captured_at: e.captured_at,
    captured_by: e.captured_by ?? 'unknown',
    content_hash: e.evidence_id.replace(/^EV-/, ''),
    evidence_count: 1,
    dimensions_touched: e.dimension_id ? [e.dimension_id] : [],
  }));

  const items = [...historical, ...pending].sort((a, b) => b.captured_at.localeCompare(a.captured_at));
  return { team_id: teamId, items };
}

export async function getProvenance(teamId: string): Promise<ProvenanceLedgerResponse | null> {
  if (!config.mock.aurora) {
    if (!(await A.teamExists(teamId))) return null;
    const { historical, scoredEvidence, pendingLog } = await A.fetchProvenanceRaw(teamId);
    return buildProvenanceLedger(teamId, historical, scoredEvidence, pendingLog);
  }
  if (!M.teams().some((t) => t.id === teamId)) return null;
  const dims = M.scoresFor(teamId) ?? {};
  const scoredEvidence = Object.values(dims).flatMap((d) => d.evidence);
  return buildProvenanceLedger(teamId, M.provenanceFor(teamId), scoredEvidence, M.evidenceLogFor(teamId));
}

// ─── Scoring logs ───────────────────────────────────────────────────────────

export async function listScoringLogs(teamId: string): Promise<Array<{ stamp: string; source: string; envelope_id: string | null }> | null> {
  if (!config.mock.aurora) {
    if (!(await A.teamExists(teamId))) return null;
    const logs = await A.fetchScoringLogs(teamId);
    return logs.map((l) => ({ stamp: l.stamp, source: l.source, envelope_id: l.envelope_id }));
  }
  if (!M.teams().some((t) => t.id === teamId)) return null;
  return M.scoringLogsFor(teamId).map((l) => ({ stamp: l.stamp, source: l.source, envelope_id: l.envelope_id }));
}

export async function getScoringLog(teamId: string, stamp: string): Promise<M.ScoringLog | null> {
  if (!config.mock.aurora) return A.fetchScoringLog(teamId, stamp);
  return M.scoringLogsFor(teamId).find((l) => l.stamp === stamp) ?? null;
}

// ─── Intake ─────────────────────────────────────────────────────────────────

export async function intakeText(
  teamId: string,
  payload: {
    dimension_id?: string | null; text: string;
    source_type?: M.EvidenceSourceType; title?: string; captured_by?: string; captured_at?: string;
  },
): Promise<M.EvidenceLogItem | null> {
  const item: M.EvidenceLogItem = {
    evidence_id: `EV-${hex()}`, dimension_id: payload.dimension_id ?? null, source_type: payload.source_type ?? 'document',
    excerpt: payload.text.slice(0, 500), supports_level: null, captured_at: payload.captured_at ?? clock.nowIso(),
    source_ref: `PROV-${hex()}`, scored: false, status: 'PENDING',
    title: payload.title, captured_by: payload.captured_by,
  };
  if (!config.mock.aurora) {
    if (!(await A.teamExists(teamId))) return null;
    await A.insertEvidenceLogItem(teamId, item);
    return item;
  }
  if (!M.teams().some((t) => t.id === teamId)) return null;
  M.ensureEvidenceLogFor(teamId).push(item);
  return item;
}

export async function intakeImage(teamId: string, payload: { dimension_id?: string | null; filename: string }): Promise<M.EvidenceLogItem | null> {
  const item: M.EvidenceLogItem = {
    evidence_id: `EV-${hex()}`, dimension_id: payload.dimension_id ?? null, source_type: 'artifact',
    excerpt: `Pasted screenshot: ${payload.filename}`, supports_level: null, captured_at: clock.nowIso(),
    source_ref: `PROV-${hex()}`, scored: false, status: 'PENDING',
  };
  if (!config.mock.aurora) {
    if (!(await A.teamExists(teamId))) return null;
    await A.insertEvidenceLogItem(teamId, item);
    return item;
  }
  if (!M.teams().some((t) => t.id === teamId)) return null;
  M.ensureEvidenceLogFor(teamId).push(item);
  return item;
}

// ─── applyScores — the deterministic seam an agent's output goes through ──
//
// An agent (score-dimensions/process-self-assessment) NEVER writes a score
// directly. This validates dimension ids ("1".."17"), the confidence
// vocabulary, that supports_level never exceeds the rubric max, that a
// dimension outside relevant_dimension_ids is refused, and caps a
// self-rating-only dimension (evidence_class "attested", no corroborating
// class) at Level 3 — then appends one history entry per applied score.

export interface ApplyScoreInput {
  dimension_id: string;
  is_na?: boolean;
  suggested_level: number | null;
  confidence: string;
  rationale: string;
  evidence_excerpts?: string[];
  follow_up_questions?: string[];
  self_claimed_level?: number | null;
  evidence_class?: string | null;
  source_meeting?: string;
  changed_by?: string;
}

export interface ApplyScoresPayload {
  relevant_dimension_ids: string[];
  scores: ApplyScoreInput[];
}

export interface AppliedScore {
  dimension_id: string;
  current_level: number | null;
  cap_applied: boolean;
  /** Present (true) only when the payload claimed is_na for this dimension —
   * regardless of whether that claim was actually honoured (see applyScores:
   * N/A is never self-granting, so this can be true while is_na on the
   * stored dimension stays false pending lead approval). Omitted rather than
   * `false` when no claim was made, so existing exact-shape assertions on a
   * plain score entry are unaffected. */
  na_claimed?: boolean;
}

export interface RejectedScore {
  dimension_id: string;
  reason: string;
}

export interface ApplyScoresResult {
  applied: AppliedScore[];
  rejected: RejectedScore[];
}

/**
 * `undefined` when every element of an optional string list is a non-empty
 * string (an absent list is fine); otherwise the rejection reason, naming the
 * field and the index — so an agent reading `rejected[]` can find the entry
 * that was wrong rather than being told only that "something" was.
 */
function firstNonString(list: unknown, field: string): string | undefined {
  if (list === undefined || list === null) return undefined;
  if (!Array.isArray(list)) return `${field} must be an array of strings`;
  for (let i = 0; i < list.length; i += 1) {
    const value: unknown = list[i];
    if (typeof value !== 'string' || !value.trim()) {
      return `${field}[${i}] must be a non-empty string (got ${JSON.stringify(value)})`;
    }
  }
  return undefined;
}

const VALID_CONFIDENCE = new Set<string>(['low', 'moderate', 'high']);
const VALID_EVIDENCE_CLASS = new Set<string>(['attested', 'documented', 'observed']);
const SELF_RATING_CAP = 3;
const RUBRIC_MAX_LEVEL = 5;
// docs/assessment-tenant.md says L4 "needs Observed evidence" and L5 needs
// Observed evidence sustained over time, which reads as though "documented"
// evidence should also be capped below 4 — but it doesn't say at what level,
// and nothing in mock/assessment.ts's seed data pins one either. Left
// unenforced rather than guessed; only the attested (self-rating) cap above
// is spec'd with an exact number.

// Pure per-entry validate+compute step, shared by the mock path (which
// mutates the scores fixture / team.exceptions directly from the result) and
// the Aurora path (providers/assessment-aurora.ts's auroraApplyScores, which
// persists the same result via SQL instead). Behaviour must stay identical
// to what this function replaced verbatim — see git history for the
// pre-refactor inline version if a diff is ever needed.
type ScoreEntryComputation = {
  newScore: M.MockDimensionScore;
  historyEntry: M.DimensionHistoryEntry;
  newEvidence: M.Evidence[];
  newFollowups: M.FollowUpQuestion[];
  applied: AppliedScore;
  exceptionToRequest: { dimension_id: string; reason: string; requested_by?: string } | null;
};

function computeScoreEntry(
  entry: ApplyScoreInput,
  relevant: Set<string>,
  current: M.MockDimensionScore,
  hasApprovedException: boolean,
  hasRequestedException: boolean,
  now: string,
  teamId: string,
  // Who staged this claim — the session sub for a human-driven
  // POST /teams/:id/scores/apply, or `agent:<command>` for a run-completion
  // callback (mock timer or the Aurora completeRun path). Threaded onto a
  // freshly-opened exception's `requested_by` so patchException can refuse
  // self-approval later — never set on an exception that already exists.
  requestedBy?: string,
): { ok: false; reason: string } | { ok: true; result: ScoreEntryComputation } {
  if (!M.DIMENSION_IDS.includes(entry.dimension_id)) {
    return { ok: false, reason: `unknown dimension id "${entry.dimension_id}" — must be "1".."17"` };
  }
  if (!VALID_CONFIDENCE.has(entry.confidence)) {
    return { ok: false, reason: `invalid confidence "${entry.confidence}" — must be low|moderate|high` };
  }
  if (!relevant.has(entry.dimension_id)) {
    return { ok: false, reason: 'dimension is not in relevant_dimension_ids for this scoring run' };
  }
  // `suggested_level` is REQUIRED — `null` ("no level can be set yet") is a
  // decision, `undefined` is a key the envelope did not carry. Treating the
  // two the same is how an agent whose JSON spelled the field `level` had
  // every dimension silently un-scored to null with `rejected: []`: the
  // caller was told the envelope applied cleanly. A missing key is a
  // malformed envelope and must be refused, not defaulted.
  if (!('suggested_level' in (entry as object)) || entry.suggested_level === undefined) {
    return { ok: false, reason: 'suggested_level is required — send an integer 0..5, or null when no level can be set yet' };
  }
  // The rubric has no fractional levels — a non-integer here almost
  // certainly means an agent passed a confidence/probability by mistake.
  if (entry.suggested_level !== null && !Number.isInteger(entry.suggested_level)) {
    return { ok: false, reason: `suggested_level ${JSON.stringify(entry.suggested_level)} must be an integer` };
  }
  if (entry.suggested_level !== null
    && (entry.suggested_level < 0 || entry.suggested_level > RUBRIC_MAX_LEVEL)) {
    return { ok: false, reason: `suggested_level ${entry.suggested_level} exceeds the rubric max (${RUBRIC_MAX_LEVEL})` };
  }
  if (entry.evidence_class != null && !VALID_EVIDENCE_CLASS.has(entry.evidence_class)) {
    return { ok: false, reason: `invalid evidence_class "${entry.evidence_class}" — must be attested|documented|observed` };
  }
  // `self_claimed_level` is the CLAIMED track of the two-track certification
  // — it drives `claimed_level`, `verification_gap` and the dimension's
  // "Claimed Level N · Verified up to Level M" statement. Unbounded, an
  // envelope carrying `self_claimed_level: 99` rendered "Claimed Level 99"
  // with a verification gap of 97. Same rubric bounds as the verified track.
  if (entry.self_claimed_level != null
    && (!Number.isInteger(entry.self_claimed_level)
      || entry.self_claimed_level < 0 || entry.self_claimed_level > RUBRIC_MAX_LEVEL)) {
    return {
      ok: false,
      reason: `self_claimed_level ${JSON.stringify(entry.self_claimed_level)} must be an integer 0..${RUBRIC_MAX_LEVEL}`,
    };
  }
  // A score with no stated reason is not a score: `rationale` is the history
  // entry's whole audit trail, and it is also the text an N/A claim opens its
  // exception with. Omitted, it wrote `rationale: undefined` into the history
  // — a row the Scoring Logs drawer renders blank with nothing to explain it.
  if (typeof entry.rationale !== 'string' || !entry.rationale.trim()) {
    return { ok: false, reason: 'rationale is required — a score with no stated reason has no audit trail' };
  }
  if (entry.is_na !== undefined && typeof entry.is_na !== 'boolean') {
    return { ok: false, reason: `is_na ${JSON.stringify(entry.is_na)} must be a boolean` };
  }
  // Both of these become wire-shaped strings on the scorecard — an evidence
  // `excerpt` (VERBATIM, per the domain model) and a follow-up question's
  // `text`. A non-string excerpt was stored and rendered as "[object
  // Object]"; a non-string question crashed the whole request, because
  // normalizeQuestion (the idempotency key) calls `.toLowerCase()` on it —
  // HTTP 500 on POST /teams/:id/scores/apply AND on the agent's own
  // POST /runs/:runId/complete callback, which left the run `running`
  // forever and burned a slot of RUN_CONCURRENCY_CAP.
  const excerptFault = firstNonString(entry.evidence_excerpts, 'evidence_excerpts');
  if (excerptFault) return { ok: false, reason: excerptFault };
  const questionFault = firstNonString(entry.follow_up_questions, 'follow_up_questions');
  if (questionFault) return { ok: false, reason: questionFault };

  // N/A is never self-granting (docs/assessment-tenant.md): is_na:true in
  // the payload is only a CLAIM. It's honoured — the dimension actually
  // marked not_applicable — only when an exception for this dimension has
  // already been approved (ApproveException, patchException). Otherwise
  // the claim is recorded (na_claimed) and gets a pending exception
  // request of its own if one isn't already open, and the dimension is
  // still scored from suggested_level like any other entry.
  const naClaimed = !!entry.is_na;
  const naApproved = naClaimed && hasApprovedException;
  const exceptionToRequest = naClaimed && !naApproved && !hasRequestedException
    ? {
      dimension_id: entry.dimension_id,
      reason: entry.rationale || `N/A claimed by ${entry.changed_by ?? 'agent scoring run'} — pending lead approval.`,
      requested_by: requestedBy,
    }
    : null;

  let level = naApproved ? null : entry.suggested_level;
  let capApplied = false;
  // A self-rating with no independent corroboration caps at Level 3 —
  // never promoted past it no matter what the agent suggests.
  if (!naApproved && entry.evidence_class === 'attested' && level !== null && level !== undefined && level > SELF_RATING_CAP) {
    level = SELF_RATING_CAP;
    capApplied = true;
  }

  const newEvidence: M.Evidence[] = (entry.evidence_excerpts ?? []).map((excerpt) => ({
    evidence_id: `EV-${hex()}`, dimension_id: entry.dimension_id, source_type: 'document',
    excerpt, supports_level: level ?? null, captured_at: now,
    source_ref: `PROV-${hex()}`, scored: true, status: 'SCORED',
  }));
  // Idempotent: re-processing a submission (a new revision, a re-run) must
  // not stack another copy of a question the team has not answered yet. The
  // audit found three near-identical open "Security Testing" questions on one
  // team after three processing runs. Match on normalized text against the
  // dimension's OPEN questions; answered/dropped ones may be asked again.
  const openTexts = new Set(
    (current.follow_up_questions ?? []).filter((q) => q.status === 'OPEN').map((q) => normalizeQuestion(q.text)),
  );
  const newFollowups: M.FollowUpQuestion[] = [];
  for (const text of entry.follow_up_questions ?? []) {
    const key = normalizeQuestion(text);
    if (openTexts.has(key)) continue;
    openTexts.add(key);
    newFollowups.push({ question_id: `Q-${hex()}`, dimension_id: entry.dimension_id, text, target_audience: 'team', status: 'OPEN' });
  }
  const historyEntry: M.DimensionHistoryEntry = {
    from_level: current.current_level, to_level: level ?? null, is_na: naApproved,
    rationale: entry.rationale, evidence_ids: newEvidence.map((e) => e.evidence_id),
    source_meeting: entry.source_meeting ?? `teams/${teamId} (agent scoring run)`,
    changed_at: now, changed_by: entry.changed_by ?? 'orgiq-assessment-scorer',
    na_claimed: naClaimed,
  };

  const newScore: M.MockDimensionScore = {
    dimension_id: entry.dimension_id,
    current_level: naApproved ? null : (level ?? null),
    is_na: naApproved,
    confidence: entry.confidence as M.Confidence,
    self_claimed_level: entry.self_claimed_level ?? current.self_claimed_level,
    evidence_class: (entry.evidence_class as M.EvidenceClass | undefined) ?? current.evidence_class,
    cap_applied: capApplied,
    evidence: [...current.evidence, ...newEvidence],
    follow_up_questions: [...current.follow_up_questions, ...newFollowups],
    history: [...current.history, historyEntry],
    updated_at: now,
  };
  const applied: AppliedScore = {
    dimension_id: entry.dimension_id, current_level: newScore.current_level,
    cap_applied: capApplied, ...(naClaimed && { na_claimed: true }),
  };

  return { ok: true, result: { newScore, historyEntry, newEvidence, newFollowups, applied, exceptionToRequest } };
}

// `requestedBy` is who staged this payload — the session sub for the
// POST /teams/:id/scores/apply route, or `agent:<command>` for a run's own
// completion (mock timer / Aurora completeRun). It's only ever recorded onto
// a freshly-opened exception (`requested_by`); never sent by the caller as
// part of the payload itself, so an agent's own output can't forge it.
export async function applyScores(...a: Parameters<typeof applyScoresImpl>): ReturnType<typeof applyScoresImpl> {
  const result = await applyScoresImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentTeamRefs([a[0]])); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function applyScoresImpl(
  teamId: string, payload: ApplyScoresPayload, requestedBy?: string,
): Promise<ApplyScoresResult | null> {
  if (!config.mock.aurora) return A.withTeamTransaction(teamId, () => A.auroraApplyScores(teamId, payload, computeScoreEntry, requestedBy));

  const dims = M.scoresFor(teamId);
  const team = M.teams().find((t) => t.id === teamId);
  if (!dims || !team) return null;

  const relevant = new Set(payload.relevant_dimension_ids ?? []);
  const applied: AppliedScore[] = [];
  const rejected: RejectedScore[] = [];
  const now = clock.nowIso();

  for (const entry of payload.scores ?? []) {
    const current = dims[entry.dimension_id] ?? emptyScore(entry.dimension_id);
    const hasApprovedException = team.exceptions.some((e) => e.dimension_id === entry.dimension_id && e.status === 'approved');
    const hasRequestedException = team.exceptions.some((e) => e.dimension_id === entry.dimension_id && e.status === 'requested');
    const computed = computeScoreEntry(entry, relevant, current, hasApprovedException, hasRequestedException, now, teamId, requestedBy);
    if (!computed.ok) { rejected.push({ dimension_id: entry.dimension_id, reason: computed.reason }); continue; }

    const { newScore, exceptionToRequest } = computed.result;
    if (exceptionToRequest) {
      team.exceptions.push({
        dimension_id: exceptionToRequest.dimension_id, status: 'requested', source: 'manual',
        reason: exceptionToRequest.reason, approved_by: '', approved_at: '',
        requested_by: exceptionToRequest.requested_by,
      });
    }
    dims[entry.dimension_id] = newScore;
    applied.push(computed.result.applied);
  }

  // Nothing to write for status: every read derives it from these dims
  // (M.deriveTeamStatus), so there is no longer a copy that can fall behind.
  team.updated_at = now;
  return { applied, rejected };
}

/**
 * Adds reviewed follow-up questions to one dimension: the same row shape,
 * OPEN status, `team` audience and normalized-text de-duplication that
 * `computeScoreEntry` applies to an agent's questions, WITHOUT touching the
 * dimension's level, history or evidence. Used when an assessor accepts a
 * follow-up draft (lib/assessment-drafts.ts); the text is the stored draft's,
 * never the request's. Returns null when the team or dimension is unknown.
 */
export async function addFollowUps(...a: Parameters<typeof addFollowUpsImpl>): ReturnType<typeof addFollowUpsImpl> {
  const result = await addFollowUpsImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentTeamRefs([a[0]])); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function addFollowUpsImpl(
  teamId: string, dimensionId: string, texts: readonly string[],
): Promise<{ created: M.FollowUpQuestion[]; skipped: string[] } | null> {
  if (!M.DIMENSION_IDS.includes(dimensionId)) return null;
  const build = (current: M.FollowUpQuestion[]): { created: M.FollowUpQuestion[]; skipped: string[] } => {
    const open = new Set(current.filter((q) => q.status === 'OPEN').map((q) => normalizeQuestion(q.text)));
    const created: M.FollowUpQuestion[] = []; const skipped: string[] = [];
    for (const text of texts) {
      const key = normalizeQuestion(text);
      if (!key || open.has(key)) { skipped.push(text); continue; }
      open.add(key);
      created.push({ question_id: `Q-${hex()}`, dimension_id: dimensionId, text, target_audience: 'team', status: 'OPEN' });
    }
    return { created, skipped };
  };
  if (!config.mock.aurora) {
    if (!await A.fetchTeam(teamId)) return null;
    return A.withTeamTransaction(teamId, async () => {
      const current = (await A.fetchDimensionScores(teamId))[dimensionId]?.follow_up_questions ?? [];
      const out = build(current);
      for (const fu of out.created) await A.insertFollowUpRow(teamId, fu);
      return out;
    });
  }
  const dims = M.scoresFor(teamId);
  const team = M.teams().find((t) => t.id === teamId);
  if (!dims || !team) return null;
  const score = dims[dimensionId] ?? emptyScore(dimensionId);
  const out = build(score.follow_up_questions);
  if (out.created.length > 0) {
    dims[dimensionId] = { ...score, follow_up_questions: [...score.follow_up_questions, ...out.created], updated_at: clock.nowIso() };
    team.updated_at = clock.nowIso();
  }
  return out;
}

// ─── Feedback (HITL tasks) ──────────────────────────────────────────────────

export interface FeedbackTaskOut extends M.FeedbackTask {
  virtual: boolean;
}

function virtualFeedbackTasks(): FeedbackTaskOut[] {
  const out: FeedbackTaskOut[] = [];
  for (const team of M.teams()) {
    const dims = M.scoresFor(team.id) ?? {};
    for (const dimId of M.DIMENSION_IDS) {
      const score = dims[dimId];
      if (!score) continue;
      for (const q of score.follow_up_questions) {
        if (q.status !== 'OPEN') continue;
        out.push({
          task_id: `virtual-${q.question_id}`, team_id: team.id, kind: 'follow_up', status: 'OPEN',
          dimension_id: dimId, question: q.text, created_at: score.updated_at, resolved_at: null,
          response: null, virtual: true,
        });
      }
    }
  }
  return out;
}

async function auroraVirtualFeedbackTasks(): Promise<FeedbackTaskOut[]> {
  const rows = await A.fetchOpenFollowUps();
  return rows.map((r) => ({
    task_id: `virtual-${r.question_id}`, team_id: r.team_id, kind: 'follow_up', status: 'OPEN',
    dimension_id: r.dimension_id, question: r.text, created_at: r.created_at, resolved_at: null,
    response: null, virtual: true,
  }));
}

export async function listFeedback(filters: { status?: string; team?: string; kind?: string }): Promise<FeedbackTaskOut[]> {
  if (!config.mock.aurora) {
    // The stored-task query can push team/kind down to SQL, but status can't
    // be pushed into it alone — a virtual task is always synthesized as
    // status OPEN, so an aurora-side status filter would silently drop every
    // virtual task when the caller asks for e.g. status=RESOLVED. Fetch both
    // unfiltered-by-status and filter in JS, matching the mock path exactly.
    const [stored, virtual] = await Promise.all([
      A.fetchFeedbackTasks({ team: filters.team, kind: filters.kind }),
      auroraVirtualFeedbackTasks(),
    ]);
    let all: FeedbackTaskOut[] = [...stored.map((t) => ({ ...t, virtual: false })), ...virtual];
    if (filters.status) all = all.filter((t) => t.status === filters.status);
    if (filters.team) all = all.filter((t) => t.team_id === filters.team);
    if (filters.kind) all = all.filter((t) => t.kind === filters.kind);
    return all.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  let all: FeedbackTaskOut[] = [
    ...M.feedback().map((t) => ({ ...t, virtual: false })),
    ...virtualFeedbackTasks(),
  ];
  if (filters.status) all = all.filter((t) => t.status === filters.status);
  if (filters.team) all = all.filter((t) => t.team_id === filters.team);
  if (filters.kind) all = all.filter((t) => t.kind === filters.kind);
  return all.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getFeedbackTask(taskId: string): Promise<FeedbackTaskOut | null> {
  if (!config.mock.aurora) {
    if (taskId.startsWith('virtual-')) {
      const q = await A.findFollowUpQuestion(taskId.slice('virtual-'.length));
      if (!q) return null;
      return {
        task_id: taskId, team_id: q.team_id, kind: 'follow_up', status: 'OPEN', dimension_id: q.dimension_id,
        question: q.text, created_at: q.created_at, resolved_at: null, response: null, virtual: true,
      };
    }
    const stored = await A.fetchFeedbackTask(taskId);
    return stored ? { ...stored, virtual: false } : null;
  }
  const stored = M.feedback().find((t) => t.task_id === taskId);
  if (stored) return { ...stored, virtual: false };
  return virtualFeedbackTasks().find((t) => t.task_id === taskId) ?? null;
}

// A "virtual-<question_id>" task (virtualFeedbackTasks above) has no row of
// its own — it's synthesized from an OPEN follow_up_question on a dimension
// score. Resolving/dismissing it has to flip that underlying question's
// status instead, or the task just reappears on the next listFeedback call.
function findVirtualFollowUp(
  taskId: string,
): { team: M.MockTeam; dimId: string; score: M.MockDimensionScore; q: M.FollowUpQuestion } | null {
  const questionId = taskId.slice('virtual-'.length);
  for (const team of M.teams()) {
    const dims = M.scoresFor(team.id) ?? {};
    for (const dimId of M.DIMENSION_IDS) {
      const score = dims[dimId];
      const q = score?.follow_up_questions.find((f) => f.question_id === questionId);
      if (q) return { team, dimId, score: score!, q };
    }
  }
  return null;
}

export async function createFeedback(...a: Parameters<typeof createFeedbackImpl>): ReturnType<typeof createFeedbackImpl> {
  const result = await createFeedbackImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentTeamRefs(result.team_id ? [result.team_id] : [], [(await searchRefs()).assessmentFeedbackRef(result.task_id)])); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function createFeedbackImpl(payload: {
  team_id?: string | null; kind: string; question: string; dimension_id?: string | null;
}): Promise<M.FeedbackTask> {
  const task: M.FeedbackTask = {
    task_id: `fb-${hex()}`, team_id: payload.team_id ?? null, kind: payload.kind,
    status: 'OPEN', dimension_id: payload.dimension_id ?? null, question: payload.question,
    created_at: clock.nowIso(), resolved_at: null, response: null,
  };
  if (!config.mock.aurora) { await A.insertFeedbackTask(task); return task; }
  M.feedback().push(task);
  return task;
}

export async function resolveFeedback(...a: Parameters<typeof resolveFeedbackImpl>): ReturnType<typeof resolveFeedbackImpl> {
  const result = await resolveFeedbackImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentTeamRefs(result?.team_id ? [result.team_id] : [], [(await searchRefs()).assessmentFeedbackRef(a[0])])); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function resolveFeedbackImpl(taskId: string, response: string): Promise<M.FeedbackTask | null> {
  if (!config.mock.aurora) {
    if (taskId.startsWith('virtual-')) {
      const q = await A.findFollowUpQuestion(taskId.slice('virtual-'.length));
      if (!q) return null;
      const ok = await A.setFollowUpStatus(taskId.slice('virtual-'.length), 'ANSWERED');
      if (!ok) return null;
      return {
        task_id: taskId, team_id: q.team_id, kind: 'follow_up', status: 'RESOLVED',
        dimension_id: q.dimension_id, question: q.text, created_at: q.created_at,
        resolved_at: clock.nowIso(), response,
      };
    }
    return A.resolveFeedbackTaskRow(taskId, response);
  }
  if (taskId.startsWith('virtual-')) {
    const hit = findVirtualFollowUp(taskId);
    if (!hit) return null;
    const createdAt = hit.score.updated_at;
    hit.q.status = 'ANSWERED';
    return {
      task_id: taskId, team_id: hit.team.id, kind: 'follow_up', status: 'RESOLVED',
      dimension_id: hit.dimId, question: hit.q.text, created_at: createdAt,
      resolved_at: clock.nowIso(), response,
    };
  }
  const task = M.feedback().find((t) => t.task_id === taskId);
  if (!task) return null;
  task.status = 'RESOLVED';
  task.response = response;
  task.resolved_at = clock.nowIso();
  return task;
}

export async function dismissFeedback(...a: Parameters<typeof dismissFeedbackImpl>): ReturnType<typeof dismissFeedbackImpl> {
  const result = await dismissFeedbackImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentTeamRefs(result?.team_id ? [result.team_id] : [], [(await searchRefs()).assessmentFeedbackRef(a[0])])); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function dismissFeedbackImpl(taskId: string): Promise<M.FeedbackTask | null> {
  if (!config.mock.aurora) {
    if (taskId.startsWith('virtual-')) {
      const q = await A.findFollowUpQuestion(taskId.slice('virtual-'.length));
      if (!q) return null;
      const ok = await A.setFollowUpStatus(taskId.slice('virtual-'.length), 'DROPPED');
      if (!ok) return null;
      return {
        task_id: taskId, team_id: q.team_id, kind: 'follow_up', status: 'DISMISSED',
        dimension_id: q.dimension_id, question: q.text, created_at: q.created_at,
        resolved_at: clock.nowIso(), response: null,
      };
    }
    return A.dismissFeedbackTaskRow(taskId);
  }
  if (taskId.startsWith('virtual-')) {
    const hit = findVirtualFollowUp(taskId);
    if (!hit) return null;
    const createdAt = hit.score.updated_at;
    hit.q.status = 'DROPPED';
    return {
      task_id: taskId, team_id: hit.team.id, kind: 'follow_up', status: 'DISMISSED',
      dimension_id: hit.dimId, question: hit.q.text, created_at: createdAt,
      resolved_at: clock.nowIso(), response: null,
    };
  }
  const task = M.feedback().find((t) => t.task_id === taskId);
  if (!task) return null;
  task.status = 'DISMISSED';
  task.resolved_at = clock.nowIso();
  return task;
}

// ─── Scoring-log synthesis — what a completed score-dimensions/
// process-self-assessment run actually produces ───────────────────────────
//
// A real orgiq-assessment-scorer run reads whatever the team already has —
// committed submission envelopes and intake evidence — and emits one
// ApplyScoreInput per dimension: some backed by a self-rating or linked
// evidence, the rest an honest "nothing here yet" placeholder. This mirrors
// that shape for the mock so a run actually changes the scorecard instead of
// writing a single-dimension log nobody applies (see launchRun below).
// Deterministic in team id + dimension id only — never Math.random — so two
// runs against the same unchanged team produce byte-identical scores.

// Self-rating strings in a DimensionHint are the rubric level's own name
// ("Leading", "Developing", ...) verbatim — resolve it back to a level number
// via the dimension's own rubric levels rather than a shared name->level map,
// since level names aren't guaranteed identical across dimensions.
function mapSelfRatingToLevel(dimensionId: string, selfRating: string): number | null {
  const trimmed = selfRating.trim();
  if (!trimmed) return null;
  const def = M.rubricDimension(dimensionId);
  const match = def?.levels.find((l) => l.name.toLowerCase() === trimmed.toLowerCase());
  return match ? match.level : null;
}

// A small deterministic hash of (teamId, dimensionId) -> 0..2, used only to
// pick a suggested_level for a dimension with zero evidence of any kind. Not
// a source of randomness — the same pair always yields the same number.
function seededNoEvidenceLevel(teamId: string, dimensionId: string): number {
  const str = `${teamId}:${dimensionId}`;
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) hash = (Math.imul(hash, 31) + str.charCodeAt(i)) >>> 0;
  return hash % 3;
}

/**
 * Build a full 17-dimension ScoringLog for `team` from what it actually has:
 * committed submission envelopes' dimension_hints (self-rating, claimed N/A,
 * evidence context), the raw intake evidence log, and any evidence already
 * scored onto `dims` from a prior run (so a rerun doesn't downgrade a
 * dimension to "no evidence" just because its intake item was consumed into
 * dims[id].evidence in the meantime). Every dimension with none of those gets
 * a low-confidence, no-evidence entry that names the follow-up question it
 * opens. Pure — shared by the mock path (launchRun) and, when an Aurora
 * run-completion path exists, that one too.
 */
export function buildScoringLogForTeam(
  team: M.MockTeam,
  dims: Record<string, M.MockDimensionScore> | undefined,
  evidenceLog: M.EvidenceLogItem[],
  envelopes: M.SubmissionEnvelope[],
  runId: string,
): M.ScoringLog {
  const committed = [...envelopes]
    .filter((e) => e.status === 'committed')
    .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
  const dimsMap = dims ?? {};

  const scores: M.ScoringLogEntry[] = M.DIMENSION_IDS.map((dimId): M.ScoringLogEntry => {
    const def = M.rubricDimension(dimId);
    const title = def?.title ?? `Dimension ${dimId}`;
    const scoredEvidence: { excerpt: string; supports_level: number | null }[] = dimsMap[dimId]?.evidence ?? [];
    const pendingEvidence = evidenceLog.filter((e) => e.dimension_id === dimId);
    const evidenceItems = [...scoredEvidence, ...pendingEvidence];
    let hint: M.DimensionHint | undefined;
    for (const env of committed) {
      hint = env.dimension_hints.find((h) => h.dimension_id === dimId);
      if (hint) break;
    }

    if (hint?.claimed_na) {
      return {
        dimension_id: dimId, is_na: true, suggested_level: null, confidence: 'moderate',
        rationale: `Self-assessment claims "${title}" is not applicable to this team`
          + `${hint.main_answer ? ` ("${hint.main_answer}")` : ''}. N/A is never self-granting — recording`
          + ' the claim and opening an exception request for lead review.',
        evidence_excerpts: hint.evidence_context ? [hint.evidence_context] : [],
        follow_up_questions: [], na_claimed: true, self_claimed_level: null,
        evidence_class: 'attested', cap_applied: false,
      };
    }

    if (hint) {
      const claimedLevel = mapSelfRatingToLevel(dimId, hint.self_rating);
      const excerpts = [hint.main_answer, hint.evidence_context, ...evidenceItems.map((e) => e.excerpt)]
        .filter((s): s is string => !!s);
      const corroborated = evidenceItems.length > 0;
      return {
        dimension_id: dimId, is_na: false, suggested_level: claimedLevel, confidence: corroborated ? 'moderate' : 'low',
        rationale: claimedLevel !== null
          ? `Self-assessment rates "${title}" as "${hint.self_rating}" (Level ${claimedLevel}).`
            + (corroborated ? ' Corroborated by linked intake evidence.' : " No corroborating evidence beyond the team's own account — self-rating only.")
          : `Self-assessment answered "${title}" but rating "${hint.self_rating}" does not match a known rubric level for this dimension — recorded unscored pending review.`,
        evidence_excerpts: excerpts, follow_up_questions: [], na_claimed: false,
        self_claimed_level: claimedLevel, evidence_class: corroborated ? 'documented' : 'attested', cap_applied: false,
      };
    }

    if (evidenceItems.length > 0) {
      const supported = evidenceItems.map((e) => e.supports_level).find((l): l is number => l != null) ?? null;
      return {
        dimension_id: dimId, is_na: false, suggested_level: supported, confidence: 'moderate',
        rationale: `Intake evidence links to "${title}" (${evidenceItems.length} item${evidenceItems.length === 1 ? '' : 's'})`
          + ' but no self-assessment rating was submitted for this dimension — scored from evidence alone.',
        evidence_excerpts: evidenceItems.map((e) => e.excerpt), follow_up_questions: [], na_claimed: false,
        self_claimed_level: null, evidence_class: 'documented', cap_applied: false,
      };
    }

    const level = seededNoEvidenceLevel(team.id, dimId);
    const question = `No evidence has been submitted for "${title}" — can the team describe current practice or link supporting documentation?`;
    return {
      dimension_id: dimId, is_na: false, suggested_level: level, confidence: 'low',
      rationale: `No evidence was found for "${title}" — no self-assessment answer, no linked intake evidence.`
        + ` Suggested Level ${level} is a floor estimate only, not a verified score.`,
      evidence_excerpts: [], follow_up_questions: [question], na_claimed: false,
      self_claimed_level: null, evidence_class: null, cap_applied: false,
    };
  });

  return {
    team_id: team.id,
    envelope_id: committed[0]?.envelope_id ?? null,
    stamp: `${stampNow()}-${hex(12)}`,
    source: 'mock',
    scores,
    run_id: runId,
  };
}

// A dimension counts as "from evidence" iff buildScoringLogForTeam found a
// self-rating, an N/A claim, or intake evidence for it — the same predicate
// as the three non-filler branches above. Used only to keep run.completed's
// summary text honest about what actually happened.
export function summarizeScoringLog(log: M.ScoringLog): { fromEvidence: number; noEvidence: number; followUpsOpened: number } {
  const fromEvidence = log.scores.filter((s) => s.na_claimed || s.self_claimed_level !== null || s.evidence_excerpts.length > 0).length;
  return {
    fromEvidence,
    noEvidence: log.scores.length - fromEvidence,
    followUpsOpened: log.scores.filter((s) => s.follow_up_questions.length > 0).length,
  };
}

/**
 * What a completed scoring run should SAY, given what apply-scores actually
 * did with its envelope.
 *
 * The run record is the truth of completion, never the agent's self-report
 * (docs/assessment-tenant.md, "Agentic support"). `completeRun` used to
 * discard applyScores' result entirely, so a run whose every entry the
 * deterministic verb refused still reported `completed` with a cheerful
 * "Scored 17 dimensions: …" summary and a scoring-log file path — the exact
 * failure mode a mock is supposed to make impossible, since nothing in the
 * scorecard had moved. Now: some refused is said out loud in the summary;
 * ALL refused is a failed run, because the command did not do its job.
 */
function reconcileRunOutcome(
  base: { status: 'completed' | 'failed'; summary: string; error: string | null },
  result: ApplyScoresResult | null,
): { status: 'completed' | 'failed'; summary: string; error: string | null } {
  if (!result || result.rejected.length === 0) return base;
  const detail = result.rejected.map((r) => `dimension ${r.dimension_id}: ${r.reason}`).join('; ');
  if (result.applied.length === 0) {
    return {
      status: 'failed',
      summary: base.summary,
      error: `apply-scores refused every entry in the scoring log — ${detail}`,
    };
  }
  return {
    ...base,
    summary: `${base.summary} ${result.rejected.length} entr${result.rejected.length === 1 ? 'y' : 'ies'} refused by apply-scores — ${detail}`,
  };
}

// Convert a ScoringLog into the payload applyScores expects, attributing
// every entry to this run so history/exceptions/follow-ups trace back to it.
function scoringLogToApplyPayload(log: M.ScoringLog, runId: string): ApplyScoresPayload {
  return {
    relevant_dimension_ids: [...M.DIMENSION_IDS],
    scores: log.scores.map((s) => ({
      dimension_id: s.dimension_id, is_na: s.is_na || s.na_claimed, suggested_level: s.suggested_level,
      confidence: s.confidence, rationale: s.rationale, evidence_excerpts: s.evidence_excerpts,
      follow_up_questions: s.follow_up_questions, self_claimed_level: s.self_claimed_level,
      evidence_class: s.evidence_class,
      source_meeting: runId, changed_by: 'agent:score-dimensions',
    })),
  };
}

// ─── Runs ───────────────────────────────────────────────────────────────────

export async function listRuns(filters: { command?: string; team?: string; status?: string; limit?: number }): Promise<M.MockRun[]> {
  if (!config.mock.aurora) return A.fetchRuns(filters);
  let all = [...M.runs()];
  if (filters.command) all = all.filter((r) => r.command === filters.command);
  if (filters.team) all = all.filter((r) => r.team_id === filters.team);
  if (filters.status) all = all.filter((r) => r.status === filters.status);
  all.sort((a, b) => b.started_at.localeCompare(a.started_at));
  return all.slice(0, filters.limit ?? 50);
}

export async function getRun(runId: string): Promise<M.MockRun | null> {
  if (!config.mock.aurora) return A.fetchRun(runId);
  return M.runs().find((r) => r.id === runId) ?? null;
}

export async function createRunRecord(...a: Parameters<typeof createRunRecordImpl>): ReturnType<typeof createRunRecordImpl> {
  const result = await createRunRecordImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentTeamRefs(result.team_id ? [result.team_id] : [], [(await searchRefs()).assessmentRunRef(result.id)])); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function createRunRecordImpl(payload: {
  command: string; team_id?: string | null; status?: M.RunStatus; summary?: string; args?: Record<string, unknown>;
}): Promise<M.MockRun> {
  const now = clock.nowIso();
  const rec: M.MockRun = {
    id: `run-${stampNow()}-${payload.command}-${hex(12)}`, command: payload.command,
    team_id: payload.team_id ?? null, args: payload.args ?? {}, status: payload.status ?? 'completed',
    source: 'engine', started_at: now, finished_at: payload.status === 'running' ? null : now,
    summary: payload.summary ?? '', error: null, files_written: [],
  };
  if (!config.mock.aurora) { await A.insertRun(rec); return rec; }
  M.runs().unshift(rec);
  return rec;
}

const RUN_CONCURRENCY_CAP = 3;
const MOCK_RUN_DURATION_MS = 8_000;

// Commands whose contract is "emit an ApplyScoresPayload" — the only ones
// where completion should actually change the scorecard. Everything else
// (classify-transcript, develop-jira-story, ...) just reports done.
const SCORE_APPLYING_COMMANDS = new Set(['score-dimensions', 'process-self-assessment']);

// Review-deck commands write a deck revision on completion through
// providers/assessment-decks.ts. That module imports this one, so it is
// reached by dynamic import at completion time rather than a static cycle.
export { DECK_COMMANDS };

export type LaunchRunResult =
  | { ok: true; run_id: string; started_at: string }
  | { ok: false; status: 400 | 409 | 429 | 503; reason: string };

/**
 * Launch an assessment-agent run. Duplicate-guarded per (command, team_id)
 * and capped at RUN_CONCURRENCY_CAP concurrently running records.
 *
 * Aurora admission and durable dispatch payload commit under one table lock,
 * so duplicate/cap checks are atomic across middleware replicas. A background
 * worker claims persisted runs and records real agent output or failure.
 */
export async function launchRun(...a: Parameters<typeof launchRunImpl>): ReturnType<typeof launchRunImpl> {
  const result = await launchRunImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentTeamRefs(a[2] ? [a[2]] : [], result.ok ? [(await searchRefs()).assessmentRunRef(result.run_id)] : [])); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function launchRunImpl(
  command: string, args: Record<string, unknown>, teamId: string | null,
  // Who launched it — the session sub the route resolved, never the body
  // (same attribution rule as bot_runs.dispatched_by). Persisted on Aurora;
  // the in-memory fixture has no column for it.
  launchedBy: string | null = null,
  // Drafter input for a review-deck command (see assessmentRunInput).
  deckInput?: Record<string, unknown>,
): Promise<LaunchRunResult> {
  if (DECK_COMMANDS.has(command) && !deckInput) {
    return { ok: false, status: 400, reason: `${command} is launched from the review-deck routes (POST /teams/:teamId/decks, POST /decks/:id/revise)` };
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, status: 400, reason: 'args must be an object' };
  // Pin the exact submission once, before dispatch. Callback time must not
  // select a different envelope that arrived while the agent was working.
  const submissionId = args['submission'];
  if (submissionId != null && typeof submissionId !== 'string') {
    return { ok: false, status: 400, reason: 'submission must be an envelope id' };
  }
  const submissions = teamId ? (config.mock.aurora ? M.submissionsFor(teamId) : await A.fetchSubmissionsForTeam(teamId)) : [];
  const selected = typeof submissionId === 'string' ? submissions.find(e => e.envelope_id === submissionId && e.status === 'committed') : undefined;
  if (submissionId && !selected) return { ok: false, status: 400, reason: 'submission must be committed and belong to this team' };
  args = { ...args, submission: selected?.envelope_id ?? null };
  if (!config.mock.aurora) {
    if (config.mock.agentcore || process.env['DEV_OFFLINE'] === 'true') {
      return { ok: false, status: 503, reason: 'Live assessment dispatch is unavailable while AgentCore is mocked or offline' };
    }
    const team = teamId ? await A.fetchTeam(teamId) : null;
    if (teamId && !team) return { ok: false, status: 400, reason: 'team not found' };
    let dispatch: ReturnType<typeof assessmentRunInput>;
    try {
      dispatch = assessmentRunInput(command, args, teamId,
        teamId ? await A.fetchEvidenceLog(teamId) : [], selected,
        M.rubricDimensions(team?.rubric_version ?? M.DEFAULT_RUBRIC_VERSION), deckInput);
    } catch (error) {
      return { ok: false, status: 400, reason: error instanceof Error ? error.message : 'Invalid run input' };
    }
    const startedAt = clock.nowIso();
    const id = `run-${stampNow()}-${command}-${hex(12)}`;
    const rec: M.MockRun = {
      id, command, team_id: teamId, args, status: 'running', source: 'agent',
      started_at: startedAt, finished_at: null, summary: '', error: null, files_written: [],
    };
    dispatch.payload['auth'] = { tenant: 'assessment', sub: launchedBy };
    const admitted = await A.reserveRun(rec, launchedBy, dispatch, RUN_CONCURRENCY_CAP);
    if (admitted === 'duplicate') return { ok: false, status: 409, reason: `a "${command}" run is already in progress for ${teamId ?? 'this scope'}` };
    if (admitted === 'capacity') return { ok: false, status: 429, reason: `maximum of ${RUN_CONCURRENCY_CAP} concurrent runs already in progress` };
    assessmentBroker.publish({ type: 'run.started', run_id: id, command, team_id: teamId, ts: startedAt });
    return { ok: true, run_id: id, started_at: startedAt };
  }
  const duplicate = M.runs().find((r) => r.command === command && r.team_id === teamId && r.status === 'running');
  if (duplicate) {
    return { ok: false, status: 409, reason: `a "${command}" run is already in progress for ${teamId ?? 'this scope'}` };
  }
  const runningCount = M.runs().filter((r) => r.status === 'running').length;
  if (runningCount >= RUN_CONCURRENCY_CAP) {
    return { ok: false, status: 429, reason: `maximum of ${RUN_CONCURRENCY_CAP} concurrent runs already in progress` };
  }

  const startedAt = clock.nowIso();
  const id = `run-${stampNow()}-${command}-${hex(12)}`;
  const rec: M.MockRun = {
    id, command, team_id: teamId, args, status: 'running', source: 'agent',
    started_at: startedAt, finished_at: null, summary: '', error: null, files_written: [],
  };
  M.runs().unshift(rec);
  assessmentBroker.publish({ type: 'run.started', run_id: id, command, team_id: teamId, ts: startedAt });

  // Progress ticks so a live activity feed has motion during the run instead
  // of jumping straight from "started" to "completed" ~8s later.
  const PROGRESS_TICKS = 3;
  let ticksSent = 0;
  const progressTimer = setInterval(() => {
    const r = M.runs().find((x) => x.id === id);
    if (!r || r.status !== 'running') { clearInterval(progressTimer); return; }
    ticksSent += 1;
    const percent = Math.min(90, Math.round((ticksSent / (PROGRESS_TICKS + 1)) * 100));
    assessmentBroker.publish({ type: 'run.progress', run_id: id, command, team_id: teamId, percent, ts: clock.nowIso() });
    if (ticksSent >= PROGRESS_TICKS) clearInterval(progressTimer);
  }, MOCK_RUN_DURATION_MS / (PROGRESS_TICKS + 1));
  progressTimer.unref?.();

  const timer = setTimeout(() => {
    void (async () => {
      const r = M.runs().find((x) => x.id === id);
      if (!r || r.status !== 'running') return;
      if (DECK_COMMANDS.has(command)) {
        // The offline drafter: a deterministic narrative obeying the same
        // contract, through the same completion seam a real result takes.
        const decks = await import('./assessment-decks.js');
        let deckResult: unknown;
        try { deckResult = await decks.mockDeckRunResult(r); } catch (error) {
          await completeRun(id, { status: 'failed', error: error instanceof Error ? error.message : 'offline drafter failed' });
          return;
        }
        await completeRun(id, { status: 'completed', deck_result: deckResult });
        return;
      }
      const finishedAt = clock.nowIso();
      r.status = 'completed';
      r.finished_at = finishedAt;
      r.summary = `Mock run completed for ${command}${teamId ? ` on ${teamId}` : ''}.`;

      const team = teamId ? M.teams().find((t) => t.id === teamId) : undefined;
      if (teamId && team && SCORE_APPLYING_COMMANDS.has(command) && M.scoresFor(teamId)) {
        const envelopes = M.submissionsFor(teamId).filter(e => e.envelope_id === r.args.submission);
        const log = buildScoringLogForTeam(team, M.scoresFor(teamId), M.evidenceLogFor(teamId), envelopes, id);
        if (r.args.submission && envelopes[0]) {
          const dimensions = new Set(envelopes[0].dimension_hints.map(h => h.dimension_id));
          log.scores = log.scores.filter(score => dimensions.has(score.dimension_id));
        }
        M.addScoringLog(log);
        r.files_written = [`workspace/teams/${teamId}/reports/scoring_log_${log.stamp}.json`];

        // Same seam a real agent's output goes through — no separate mock
        // mutation path for current_level/history/follow-ups/exceptions.
        await applyScores(teamId, scoringLogToApplyPayload(log, id), `agent:${command}`);
        if (team.workflow_step < 3) team.workflow_step = 3; // "Score"

        const { fromEvidence, noEvidence, followUpsOpened } = summarizeScoringLog(log);
        r.summary = `Scored ${log.scores.length} dimensions: ${fromEvidence} from evidence, `
          + `${noEvidence} low-confidence with no evidence; ${followUpsOpened} follow-up${followUpsOpened === 1 ? '' : 's'} opened.`;
      }
      assessmentBroker.publish({ type: 'run.completed', run_id: id, command, team_id: teamId, summary: r.summary, ts: finishedAt });
      try { await noteSearchWrite(...await (await searchRefs()).assessmentTeamRefs(teamId ? [teamId] : [], [(await searchRefs()).assessmentRunRef(id)])); } catch { /* the index never fails the run */ }
    })();
  }, MOCK_RUN_DURATION_MS);
  timer.unref?.();

  return { ok: true, run_id: id, started_at: startedAt };
}

// ─── Command registry + stop ────────────────────────────────────────────────
//
// The command names mirror the source registry; tools below describe the
// actual Strands implementation. Draft output stays in the run ledger.

export interface AgentCommandInfo {
  name: string;
  summary: string;
  allowed_tools: string[];
}

// These are the deployed Strands tools, not the source application's
// filesystem/Bash allowlist. The BFF alone persists score results.
const SCORER_TOOLS = ['classify_evidence', 'score_dimension'];
const DRAFTER_TOOLS = ['check_story_draft', 'validate_facts'];
export const AGENT_COMMANDS: AgentCommandInfo[] = [
  { name: 'classify-transcript', summary: 'Classify source material into evidence types and relevant dimensions.', allowed_tools: SCORER_TOOLS },
  { name: 'score-dimensions', summary: 'Score saved team evidence against the rubric.', allowed_tools: SCORER_TOOLS },
  { name: 'process-self-assessment', summary: 'Score one selected committed submission.', allowed_tools: SCORER_TOOLS },
  { name: 'develop-jira-story', summary: 'Draft a story from one recommendation for human review.', allowed_tools: DRAFTER_TOOLS },
  { name: 'extract-enterprise-context', summary: 'Extract source-backed governance facts for review.', allowed_tools: DRAFTER_TOOLS },
  { name: 'validate-outputs', summary: 'Review supplied content for traceability and unsupported claims.', allowed_tools: DRAFTER_TOOLS },
  { name: 'draft-confluence-page', summary: 'Draft a Markdown page in the run ledger; publishing is separate.', allowed_tools: DRAFTER_TOOLS },
  { name: 'suggest-confluence-content', summary: 'Suggest content edits from supplied source material.', allowed_tools: DRAFTER_TOOLS },
  { name: 'draw-diagram', summary: 'Draft a safe draw.io XML diagram in the run ledger.', allowed_tools: DRAFTER_TOOLS },
  { name: 'draft-review-deck', summary: 'Write the narrative of a team review deck; every number comes from the scorecard.', allowed_tools: DRAFTER_TOOLS },
  { name: 'revise-review-deck', summary: 'Revise a review deck as instructed; facts are re-applied after the edit.', allowed_tools: DRAFTER_TOOLS },
];

export async function listCommands(): Promise<AgentCommandInfo[]> {
  return AGENT_COMMANDS;
}

export type StopRunResult = { ok: true; run: M.MockRun } | { ok: false; status: 404 | 409; reason: string };

/**
 * Stop a run. Only a `running` record can be stopped; a terminal one 409s
 * rather than being silently rewritten, because the record is the truth of
 * what happened and "stopped" must never overwrite "completed".
 */
export async function stopRun(...a: Parameters<typeof stopRunImpl>): ReturnType<typeof stopRunImpl> {
  const result = await stopRunImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentRunRefs(a[0])); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function stopRunImpl(runId: string): Promise<StopRunResult> {
  if (!config.mock.aurora) {
    const result = await A.withRunTransaction<StopRunResult>(runId, async () => {
    const run = await A.fetchRun(runId);
    if (!run) return { ok: false, status: 404, reason: 'run not found' };
    if (run.status !== 'running') return { ok: false, status: 409, reason: `run is already ${run.status}` };
    const finishedAt = clock.nowIso();
    const reason = 'stopped by operator';
    const summary = `Stopped by operator before ${run.command} finished.`;
    await A.updateRunStatus(runId, { status: 'failed', finished_at: finishedAt, summary, error: reason });
    return { ok: true, run: { ...run, status: 'failed', finished_at: finishedAt, error: reason, summary } };
    });
    if (result.ok) assessmentBroker.publish({ type: 'run.failed', run_id: runId, command: result.run.command,
      team_id: result.run.team_id, reason: result.run.error!, ts: result.run.finished_at! });
    return result;
  }
  const run = M.runs().find((r) => r.id === runId);
  if (!run) return { ok: false, status: 404, reason: 'run not found' };
  if (run.status !== 'running') return { ok: false, status: 409, reason: `run is already ${run.status}` };
  run.status = 'failed';
  run.finished_at = clock.nowIso();
  run.error = 'stopped by operator';
  run.summary = `Stopped by operator before ${run.command} finished.`;
  assessmentBroker.publish({
    type: 'run.failed', run_id: run.id, command: run.command, team_id: run.team_id, reason: run.error, ts: run.finished_at,
  });
  return { ok: true, run };
}

export type CompleteRunResult = { ok: true; run: M.MockRun } | { ok: false; status: 400 | 404 | 409; reason: string };

/**
 * The run-completion callback (POST /runs/:runId/complete) — the ONLY way a
 * `running` record leaves that state on the real Aurora path (see the route
 * comment). Mirrors what the mock's launchRun setTimeout has always done for
 * a score-applying command: build a ScoringLog, persist it, and run it
 * through the exact same applyScores seam an interactive
 * POST /teams/:id/scores/apply goes through — never a separate mutation
 * path. `requestedBy` on that applyScores call is `agent:<command>`, the
 * same attribution convention scoringLogToApplyPayload already used for
 * `changed_by`, so any exception a scoring run opens can never be
 * self-approved by a human (nothing signs in as `agent:score-dimensions`).
 *
 * Idempotency: a run that isn't `running` 409s rather than being silently
 * reprocessed — the record is the truth of what happened once, and a
 * duplicate/late callback (agent retry, or the mock's fake timer racing a
 * real caller) must never double-apply a scoring log.
 */
export async function completeRun(...a: Parameters<typeof completeRunImpl>): ReturnType<typeof completeRunImpl> {
  const result = await completeRunImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentRunRefs(a[0])); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function completeRunImpl(
  runId: string,
  patch: {
    status: 'completed' | 'failed'; summary?: string; error?: string;
    files_written?: string[]; scoring_log?: M.ScoringLogEntry[];
    /** A review-deck command's drafter output (parsed JSON). */
    deck_result?: unknown;
  },
): Promise<CompleteRunResult> {
  if (!config.mock.aurora) {
    const result = await A.withRunTransaction<CompleteRunResult>(runId, async () => {
    const run = await A.fetchRun(runId);
    if (!run) return { ok: false, status: 404, reason: 'run not found' };
    if (run.status !== 'running') return { ok: false, status: 409, reason: `run is already ${run.status}` };
    if (patch.status === 'completed' && SCORE_APPLYING_COMMANDS.has(run.command) && !patch.scoring_log?.length) {
      return { ok: false, status: 400, reason: 'A scoring run requires a non-empty scoring_log to complete' };
    }

    const finishedAt = clock.nowIso();
    let summary = patch.summary ?? (patch.status === 'completed'
      ? `Completed ${run.command}${run.team_id ? ` on ${run.team_id}` : ''}.`
      : `Failed ${run.command}${run.team_id ? ` on ${run.team_id}` : ''}.`);
    let status = patch.status;
    let errorText = patch.status === 'failed' ? (patch.error ?? 'agent reported failure') : null;
    let filesWritten = patch.files_written ?? run.files_written;

    if (patch.status === 'completed' && run.team_id && SCORE_APPLYING_COMMANDS.has(run.command) && patch.scoring_log?.length) {
      // Acquire the team lock before child inserts acquire FK key-share locks.
      // The nested scope reuses this run transaction and retains its lock until commit.
      await A.withTeamTransaction(run.team_id, async () => undefined);
      const envelopes = await A.fetchSubmissionsForTeam(run.team_id);
      const target = envelopes.find(e => e.envelope_id === run.args.submission);
      if (run.args.submission && (!target || patch.scoring_log.some(score => !target.dimension_hints.some(h => h.dimension_id === score.dimension_id)))) {
        return { ok: false, status: 400, reason: 'Scoring output must match the selected submission dimensions' };
      }
      const log: M.ScoringLog = {
        team_id: run.team_id, envelope_id: target?.envelope_id ?? null,
        stamp: `${stampNow()}-${hex(12)}`, source: 'agent', scores: patch.scoring_log, run_id: runId,
      };
      await A.insertScoringLog(log);
      const applied = await applyScores(run.team_id, scoringLogToApplyPayload(log, runId), `agent:${run.command}`);
      const { fromEvidence, noEvidence, followUpsOpened } = summarizeScoringLog(log);
      summary = patch.summary ?? `Scored ${log.scores.length} dimensions: ${fromEvidence} from evidence, `
        + `${noEvidence} low-confidence with no evidence; ${followUpsOpened} follow-up${followUpsOpened === 1 ? '' : 's'} opened.`;
      filesWritten = patch.files_written ?? [`workspace/teams/${run.team_id}/reports/scoring_log_${log.stamp}.json`];
      ({ status, summary, error: errorText } = reconcileRunOutcome({ status, summary, error: errorText }, applied));
    }

    if (patch.status === 'completed' && DECK_COMMANDS.has(run.command)) {
      const decks = await import('./assessment-decks.js');
      const outcome = await decks.applyDeckRunResult(run, patch.deck_result);
      if (outcome.ok) summary = patch.summary ?? outcome.summary;
      else { status = 'failed'; errorText = outcome.reason; }
    }

    await A.updateRunStatus(runId, { status, finished_at: finishedAt, summary, error: errorText, files_written: filesWritten });


    return { ok: true, run: { ...run, status, finished_at: finishedAt, summary, error: errorText, files_written: filesWritten } };
    });
    if (result.ok) {
      const run = result.run;
      assessmentBroker.publish(run.status === 'completed'
        ? { type: 'run.completed', run_id: runId, command: run.command, team_id: run.team_id, summary: run.summary, ts: run.finished_at! }
        : { type: 'run.failed', run_id: runId, command: run.command, team_id: run.team_id, reason: run.error ?? 'agent reported failure', ts: run.finished_at! });
    }
    return result;
  }

  // Mock path: accept the same callback (a local agent driving `agentcore
  // dev` can call this directly) WITHOUT breaking launchRun's existing fake
  // 8s-timer completion — both check `status === 'running'` before acting,
  // so whichever gets there first wins and the other is a clean 409, never
  // a double-apply.
  const run = M.runs().find((r) => r.id === runId);
  if (!run) return { ok: false, status: 404, reason: 'run not found' };
  if (run.status !== 'running') return { ok: false, status: 409, reason: `run is already ${run.status}` };
    if (patch.status === 'completed' && SCORE_APPLYING_COMMANDS.has(run.command) && !patch.scoring_log?.length) {
      return { ok: false, status: 400, reason: 'A scoring run requires a non-empty scoring_log to complete' };
    }

  if (patch.status === 'completed' && SCORE_APPLYING_COMMANDS.has(run.command) && run.args.submission && patch.scoring_log?.length) {
    const target = run.team_id ? M.submissionsFor(run.team_id).find(e => e.envelope_id === run.args.submission) : undefined;
    if (!target || patch.scoring_log.some(score => !target.dimension_hints.some(h => h.dimension_id === score.dimension_id))) {
      return { ok: false, status: 400, reason: 'Scoring output must match the selected submission dimensions' };
    }
  }
  const finishedAt = clock.nowIso();
  run.status = patch.status;
  run.finished_at = finishedAt;
  run.error = patch.status === 'failed' ? (patch.error ?? 'agent reported failure') : null;
  run.summary = patch.summary ?? (patch.status === 'completed'
    ? `Completed ${run.command}${run.team_id ? ` on ${run.team_id}` : ''}.`
    : `Failed ${run.command}${run.team_id ? ` on ${run.team_id}` : ''}.`);
  if (patch.files_written) run.files_written = patch.files_written;

  const team = run.team_id ? M.teams().find((t) => t.id === run.team_id) : undefined;
  if (patch.status === 'completed' && run.team_id && team && SCORE_APPLYING_COMMANDS.has(run.command)
    && patch.scoring_log?.length && M.scoresFor(run.team_id)) {
    const envelopes = M.submissionsFor(run.team_id);
    const target = envelopes.find(e => e.envelope_id === run.args.submission);

    const log: M.ScoringLog = {
      team_id: run.team_id, envelope_id: target?.envelope_id ?? null,
      stamp: `${stampNow()}-${hex(12)}`, source: 'agent', scores: patch.scoring_log, run_id: runId,
    };
    M.addScoringLog(log);
    run.files_written = patch.files_written ?? [`workspace/teams/${run.team_id}/reports/scoring_log_${log.stamp}.json`];

    const applied = await applyScores(run.team_id, scoringLogToApplyPayload(log, runId), `agent:${run.command}`);
    if (team.workflow_step < 3) team.workflow_step = 3; // "Score"

    const { fromEvidence, noEvidence, followUpsOpened } = summarizeScoringLog(log);
    run.summary = patch.summary ?? `Scored ${log.scores.length} dimensions: ${fromEvidence} from evidence, `
      + `${noEvidence} low-confidence with no evidence; ${followUpsOpened} follow-up${followUpsOpened === 1 ? '' : 's'} opened.`;
    const reconciled = reconcileRunOutcome({ status: run.status, summary: run.summary, error: run.error }, applied);
    run.status = reconciled.status;
    run.summary = reconciled.summary;
    run.error = reconciled.error;
  }

  if (patch.status === 'completed' && DECK_COMMANDS.has(run.command)) {
    const decks = await import('./assessment-decks.js');
    const outcome = await decks.applyDeckRunResult(run, patch.deck_result);
    if (outcome.ok) run.summary = patch.summary ?? outcome.summary;
    else { run.status = 'failed'; run.error = outcome.reason; }
  }

  assessmentBroker.publish(run.status === 'completed'
    ? { type: 'run.completed', run_id: run.id, command: run.command, team_id: run.team_id, summary: run.summary, ts: finishedAt }
    : { type: 'run.failed', run_id: run.id, command: run.command, team_id: run.team_id, reason: run.error ?? 'agent reported failure', ts: finishedAt });

  return { ok: true, run };
}

// ─── Rollup ─────────────────────────────────────────────────────────────────

export interface RollupResponse {
  target_level: number;
  teams_total: number;
  dimensions_assessed: number;
  dimensions_applicable: number;
  at_or_above_target: number;
  claims_open: number;
  by_cohort: Record<Cohort, { teams: number; at_or_above_target: number; assessed: number; applicable: number }>;
  generated_at: string;
}

// Uses application-level SQL (via A.fetchAllTeams / A.fetchAllDimensionScores)
// rather than schema/assessment_schema.sql's `v_assessment_team_rollup` view:
// the view's aggregation (assessed_dimensions = current_level IS NOT NULL OR
// is_na) doesn't carry the target-level-dependent at_or_above_target /
// claims_open fields this wire shape needs, and reusing teamCertification
// here — the exact same function the mock path and getTeamDetail use —
// keeps the three call sites from drifting into slightly different
// definitions of "assessed" or "claim_open".
function computeRollup(teams: M.MockTeam[], dimsByTeam: Map<string, Record<string, M.MockDimensionScore>>, target: number, cohort: Cohort | undefined): RollupResponse {
  const filtered = teams.filter((t) => !cohort || t.cohort === cohort);
  const byCohort: RollupResponse['by_cohort'] = {
    white_glove: { teams: 0, at_or_above_target: 0, assessed: 0, applicable: 0 },
    self_service: { teams: 0, at_or_above_target: 0, assessed: 0, applicable: 0 },
    general: { teams: 0, at_or_above_target: 0, assessed: 0, applicable: 0 },
  };
  let assessed = 0, applicable = 0, atOrAbove = 0, claimsOpen = 0;
  for (const t of filtered) {
    const dims = Object.values(dimsByTeam.get(t.id) ?? {});
    const c = teamCertification(dims, target);
    assessed += c.assessed; applicable += c.applicable; atOrAbove += c.at_or_above_target; claimsOpen += c.claims_open;
    byCohort[t.cohort].teams += 1;
    byCohort[t.cohort].at_or_above_target += c.at_or_above_target;
    byCohort[t.cohort].assessed += c.assessed;
    byCohort[t.cohort].applicable += c.applicable;
  }
  return {
    target_level: target, teams_total: filtered.length, dimensions_assessed: assessed,
    dimensions_applicable: applicable, at_or_above_target: atOrAbove, claims_open: claimsOpen,
    by_cohort: byCohort, generated_at: clock.nowIso(),
  };
}

export async function getRollup(cohort?: Cohort): Promise<RollupResponse> {
  if (!config.mock.aurora) {
    const [teams, dimsByTeam, cfg] = await Promise.all([A.fetchAllTeams(), A.fetchAllDimensionScores(), A.fetchConfiguration()]);
    return computeRollup(teams, dimsByTeam, cfg.target_level, cohort);
  }
  const dimsByTeam = new Map(M.teams().map((t) => [t.id, M.scoresFor(t.id) ?? {}]));
  return computeRollup(M.teams(), dimsByTeam, M.configuration().target_level, cohort);
}

// ─── Configuration ──────────────────────────────────────────────────────────

export async function getConfiguration(): Promise<M.AssessmentConfiguration> {
  if (!config.mock.aurora) return A.fetchConfiguration();
  return M.configuration();
}

export async function updateConfiguration(...a: Parameters<typeof updateConfigurationImpl>): ReturnType<typeof updateConfigurationImpl> {
  const result = await updateConfigurationImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentAllTeamRefs()); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function updateConfigurationImpl(patch: { target_level?: number; motions?: M.MotionConfig[] }): Promise<M.AssessmentConfiguration> {
  if (!config.mock.aurora) return A.upsertConfiguration(patch);
  const cfg = M.configuration();
  if (patch.target_level !== undefined) cfg.target_level = patch.target_level;
  if (patch.motions !== undefined) cfg.motions = patch.motions;
  cfg.updated_at = clock.nowIso();
  return cfg;
}

// ─── Submissions ────────────────────────────────────────────────────────────

function baseEnvelopeId(envelopeId: string): string {
  return envelopeId.replace(/-r\d+$/, '');
}

export interface SubmissionListing {
  envelopes: Array<M.SubmissionEnvelope & { team_id: string }>;
  groups: Array<{ base_id: string; team_id: string; revisions: number; latest_envelope_id: string; status: M.SubmissionStatus }>;
}

// The wire's view: 'processed' requires this envelope's run to have applied
// every hinted dimension (M.isSubmissionProcessed), else the real
// persisted value. Never written back — schema/assessment_schema.sql's CHECK
// on assessment_submissions.status only allows staged/committed/superseded,
// so the DB row (mock or Aurora) always keeps the real value; this is purely
// a read-time projection for the "Processed" pill/filter.
function wireSubmissionStatus(
  env: Pick<M.SubmissionEnvelope, 'envelope_id' | 'status' | 'dimension_hints' | 'ingested_at'>,
  dims: Record<string, M.MockDimensionScore>,
  logs: M.ScoringLog[],
): M.SubmissionStatus {
  return M.isSubmissionProcessed(env, dims, logs) ? 'processed' : env.status;
}

// Pure: groups a flat envelope list into the wire's {envelopes, groups}
// shape. Shared by both paths — only how `envelopes` is assembled differs.
function buildSubmissionListing(envelopes: SubmissionListing['envelopes']): SubmissionListing {
  envelopes.sort((a, b) => b.ingested_at.localeCompare(a.ingested_at));
  // `revisions` is COUNTED from the envelopes in the group, not read off the
  // newest one's `revision` number. Those two agree only while the chain is
  // 1,2,3,… with nothing deleted: clear revision 1 (DELETE /submissions) and
  // the row went on saying "3 revisions" above 2 of them — the same shape as
  // a banner reading "6 pending" over 5 cards.
  const grouped = new Map<string, SubmissionListing['envelopes']>();
  for (const env of envelopes) {
    const key = `${env.team_id}:${baseEnvelopeId(env.envelope_id)}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(env);
    else grouped.set(key, [env]);
  }
  const groups = [...grouped.values()].map((bucket) => {
    const latest = bucket.reduce((best, env) => (env.revision > best.revision ? env : best), bucket[0]!);
    return {
      base_id: baseEnvelopeId(latest.envelope_id), team_id: latest.team_id,
      revisions: bucket.length, latest_envelope_id: latest.envelope_id, status: latest.status,
    };
  });
  return { envelopes, groups };
}

export async function listSubmissions(): Promise<SubmissionListing> {
  if (!config.mock.aurora) {
    const [envelopes, dimsByTeam, logs] = await Promise.all([A.fetchAllSubmissions(), A.fetchAllDimensionScores(), A.fetchAllScoringLogs()]);
    const withStatus = envelopes.map((e) => ({ ...e, status: wireSubmissionStatus(e, dimsByTeam.get(e.team_id) ?? {}, logs.filter(log => log.team_id === e.team_id)) }));
    return buildSubmissionListing(withStatus);
  }
  const envelopes: SubmissionListing['envelopes'] = M.submissions().map((env) => ({
    ...env, status: wireSubmissionStatus(env, M.scoresFor(env.team_id) ?? {}, M.scoringLogsFor(env.team_id)),
  }));
  return buildSubmissionListing(envelopes);
}

export async function getSubmissionDetail(teamId: string, envelopeId: string): Promise<M.SubmissionEnvelope | null> {
  if (!config.mock.aurora) {
    const env = await A.fetchSubmission(teamId, envelopeId);
    if (!env) return null;
    const [dims, logs] = await Promise.all([A.fetchDimensionScores(teamId), A.fetchScoringLogs(teamId)]);
    return { ...env, status: wireSubmissionStatus(env, dims, logs) };
  }
  const env = M.findSubmission(teamId, envelopeId);
  if (!env) return null;
  const dims = M.scoresFor(teamId) ?? {};
  return { ...env, status: wireSubmissionStatus(env, dims, M.scoringLogsFor(teamId)) };
}

export async function deleteSubmission(...a: Parameters<typeof deleteSubmissionImpl>): ReturnType<typeof deleteSubmissionImpl> {
  const result = await deleteSubmissionImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentTeamRefs([a[0]])); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function deleteSubmissionImpl(teamId: string, envelopeId: string): Promise<boolean> {
  if (!config.mock.aurora) return A.deleteSubmissionRow(teamId, envelopeId);
  return M.removeSubmission(teamId, envelopeId);
}

export async function updateSubmissionLink(
  teamId: string, envelopeId: string,
  patch: { url?: string; dimension_id?: string; status: 'fetched' | 'skipped' },
): Promise<M.SubmissionEnvelope | null> {
  if (!config.mock.aurora) {
    const env = await A.fetchSubmission(teamId, envelopeId);
    if (!env) return null;
    const links = env.links ?? [];
    const link = (patch.url ? links.find((l) => l.url === patch.url) : undefined)
      ?? (patch.dimension_id ? links.find((l) => l.dimension_id === patch.dimension_id) : undefined);
    if (link) {
      link.status = patch.status;
      await A.saveSubmissionEnvelope(env);
    }
    return env;
  }
  const env = M.findSubmission(teamId, envelopeId);
  if (!env) return null;
  // `dimension_id` is nullable on an unmatched link (EnvelopeLink in
  // mock/assessment.ts), so it can't identify every link on its own — match
  // by url first (unique per envelope), falling back to dimension_id only
  // when no url was given or it didn't match. An envelope with no `links`
  // array (the seeded fixture predates evidence links) or no matching link
  // is still a valid target — the update is just a no-op on the link side,
  // and the envelope is returned unchanged rather than 404ing.
  const links = env.links ?? [];
  const link = (patch.url ? links.find((l) => l.url === patch.url) : undefined)
    ?? (patch.dimension_id ? links.find((l) => l.dimension_id === patch.dimension_id) : undefined);
  if (link) link.status = patch.status;
  return env;
}

export interface ParsedSubmissionRow {
  team_id: string | null; team_name_raw: string; classification: 'new' | 'seen' | 'unknown';
}

// `teams` is passed in (M.teams() for the mock path, A.fetchAllTeams()
// for Aurora) so this stays pure and shared rather than reading module state
// directly — same reasoning as computeScoreEntry/computeTeamPlan.
function classifyLegacyRow(row: { team_name_raw: string; team_id?: string }, teams: M.MockTeam[]): ParsedSubmissionRow {
  if (row.team_id && teams.some((t) => t.id === row.team_id)) {
    return { team_id: row.team_id, team_name_raw: row.team_name_raw, classification: 'seen' };
  }
  const match = teams.find((t) => t.name.toLowerCase() === row.team_name_raw.toLowerCase());
  if (match) return { team_id: match.id, team_name_raw: row.team_name_raw, classification: 'seen' };
  return { team_id: null, team_name_raw: row.team_name_raw, classification: 'unknown' };
}

// ─── Forms-export column mapping ────────────────────────────────────────────
// Ports the real column semantics from the source app's
// `sdlcd/workflows/submissions/{mapping,parser,naming}.py` + `forms_mapping.yaml`,
// simplified for a client-parsed CSV: headers arrive as object keys, so there's
// no index bookkeeping, just per-header classification against the same
// exact-header / regex / prefix rules the source uses.

const METADATA_HEADERS = {
  id: 'Id',
  completion_time: 'Completion time',
  email: 'Email',
  name: 'Name',
  team_name: 'What is your team name?',
} as const;

const SELF_CERT_PREFIX = 'I confirm that the information provided is accurate';
const AFFIRMATIVE_PREFIX = 'I confirm';
const EVIDENCE_CONTEXT_RE = /^Evidence \/ Additional Context for Dimension (\d+)/;
const UPLOAD_RE = /^Upload Evidence for Dimension (\d+)/;
const RATING_MATRIX_PREFIX = 'How would you rate';
const NA_CLAIM_RE = /\b(not applicable|n\/a|does not apply)\b/i;

// forms_mapping.yaml's `rating_matrix.aspects` wording, kept as a fallback for
// when it drifts from the mock rubric's own `title` (e.g. "& Deployment").
// `resolveDimensionIdForAspect` tries RUBRIC_DIMENSIONS titles first.
const RATING_ASPECT_ALIASES: Record<string, string> = {
  'continuous integration (ci)': '1',
  'continuous delivery & deployment (cd)': '2',
  'infrastructure & operational automation': '3',
  'source control & traceability': '4',
  'automated testing': '5',
  'security testing (sast/sca/secrets/iac)': '6',
  'performance & reliability testing': '7',
  'code review & secure sdlc practices': '8',
  'engineering governance': '9',
  'monitoring & observability': '10',
  'environment management': '11',
  'operational delivery & reliability': '12',
  'platform reusability & patterns': '13',
  'software development mindset & automation culture': '14',
  'agile work planning & backlog management': '15',
  'design standards & technical decisions': '16',
  'engineering metrics & continuous improvement': '17',
};

function resolveDimensionIdForAspect(aspect: string): string | null {
  const norm = aspect.trim().toLowerCase();
  const byTitle = M.RUBRIC_DIMENSIONS.find((d) => d.title.trim().toLowerCase() === norm);
  if (byTitle) return byTitle.id;
  return RATING_ASPECT_ALIASES[norm] ?? null;
}

type ColumnRole = 'metadata' | 'self_cert' | 'evidence_context' | 'upload' | 'rating_matrix'
  | 'question_main' | 'question_follow_up' | 'unclassified';

interface FormsColumn {
  index: number;
  header: string;
  role: ColumnRole;
  dimensionId: string | null;
  aspect: string | null;
}

// Classifies the header row exactly once (all data rows share the same
// columns); positional pairing of the two question columns preceding each
// "Evidence / Additional Context for Dimension N" header mirrors
// mapping.py's `_pair_questions_positionally` — those columns carry no
// dimension number of their own.
function classifyFormsColumns(headers: string[]): { columns: FormsColumn[]; warnings: string[] } {
  const warnings: string[] = [];
  const metadataHeaders = new Set<string>(Object.values(METADATA_HEADERS));
  const columns: FormsColumn[] = headers.map((header, index) => ({
    index, header, role: 'unclassified', dimensionId: null, aspect: null,
  }));

  for (const col of columns) {
    if (metadataHeaders.has(col.header)) col.role = 'metadata';
  }
  for (const col of columns) {
    if (col.role === 'unclassified' && col.header.startsWith(SELF_CERT_PREFIX)) col.role = 'self_cert';
  }
  for (const col of columns) {
    if (col.role !== 'unclassified') continue;
    const evidence = EVIDENCE_CONTEXT_RE.exec(col.header);
    if (evidence) { col.role = 'evidence_context'; col.dimensionId = evidence[1] ?? null; continue; }
    const upload = UPLOAD_RE.exec(col.header);
    if (upload) { col.role = 'upload'; col.dimensionId = upload[1] ?? null; }
  }
  for (const col of columns) {
    if (col.role !== 'unclassified' || !col.header.startsWith(RATING_MATRIX_PREFIX)) continue;
    if (!col.header.includes('?.')) {
      warnings.push(`Rating-matrix header missing '?.' delimiter: ${col.header}`);
      continue;
    }
    const aspect = (col.header.split('?.', 2)[1] ?? '').trim();
    const dimensionId = resolveDimensionIdForAspect(aspect);
    if (!dimensionId) {
      warnings.push(`Unknown rating-matrix aspect "${aspect}" in header: ${col.header}`);
      continue;
    }
    col.role = 'rating_matrix'; col.dimensionId = dimensionId; col.aspect = aspect;
  }
  const evidenceCols = columns.filter((c) => c.role === 'evidence_context').sort((a, b) => a.index - b.index);
  for (const ec of evidenceCols) {
    const found: FormsColumn[] = [];
    let i = ec.index - 1;
    while (i >= 0 && found.length < 2) {
      const candidate = columns[i]!;
      if (candidate.role === 'unclassified') found.push(candidate);
      i -= 1;
    }
    if (found[0]) { found[0].role = 'question_follow_up'; found[0].dimensionId = ec.dimensionId; }
    if (found[1]) { found[1].role = 'question_main'; found[1].dimensionId = ec.dimensionId; }
    if (found.length < 2) {
      warnings.push(`Dimension ${ec.dimensionId}: only found ${found.length} question column(s) preceding "${ec.header}" (expected 2)`);
    }
  }
  for (const col of columns) {
    if (col.role === 'unclassified' && /dimension/i.test(col.header) && /\d/.test(col.header)) {
      warnings.push(`Unmapped Dimension-pattern header: ${col.header}`);
    }
  }
  return { columns, warnings };
}

function extractUrls(value: string): string[] {
  if (!value || (!value.includes('http://') && !value.includes('https://'))) return [];
  return value.split(/[;\s]+/).filter((t) => t.startsWith('http://') || t.startsWith('https://'));
}

interface FormsLink { url: string; label: string; dimension_id: string | null }

function buildDimensionHints(record: Record<string, string>, columns: FormsColumn[]): M.DimensionHint[] {
  const dimensionIds = [...new Set(columns.filter((c) => c.dimensionId).map((c) => c.dimensionId as string))]
    .sort((a, b) => (Number(a) || 0) - (Number(b) || 0));
  const hints: M.DimensionHint[] = [];
  for (const dimensionId of dimensionIds) {
    const mainCol = columns.find((c) => c.dimensionId === dimensionId && c.role === 'question_main');
    const followCol = columns.find((c) => c.dimensionId === dimensionId && c.role === 'question_follow_up');
    const evidenceCol = columns.find((c) => c.dimensionId === dimensionId && c.role === 'evidence_context');
    const ratingCol = columns.find((c) => c.dimensionId === dimensionId && c.role === 'rating_matrix');

    const mainAnswer = (mainCol ? record[mainCol.header] : '')?.trim() ?? '';
    const followUpAnswer = (followCol ? record[followCol.header] : '')?.trim() ?? '';
    const evidenceContext = (evidenceCol ? record[evidenceCol.header] : '')?.trim() ?? '';
    const selfRating = (ratingCol ? record[ratingCol.header] : '')?.trim() ?? '';

    if (!mainAnswer && !followUpAnswer && !evidenceContext && !selfRating) continue;

    hints.push({
      dimension_id: dimensionId,
      main_answer: mainAnswer,
      matched_level: null,
      follow_up_answer: followUpAnswer || null,
      evidence_context: evidenceContext,
      self_rating: selfRating,
      self_rating_aspect: ratingCol?.aspect ?? '',
      claimed_na: NA_CLAIM_RE.test(mainAnswer),
    });
  }
  return hints;
}

function matchTeamId(record: Record<string, string>, teamNameRaw: string, teams: M.MockTeam[]): string | null {
  const idColumnKey = Object.keys(record).find((k) => /^team[\s_-]?id$/i.test(k));
  const idColumnValue = idColumnKey ? record[idColumnKey]?.trim() : '';
  if (idColumnValue && teams.some((t) => t.id === idColumnValue)) return idColumnValue;
  const match = teams.find((t) => t.name.toLowerCase() === teamNameRaw.trim().toLowerCase());
  return match ? match.id : null;
}

// Mock-path predicate, reading the submissions fixture directly. The Aurora path
// builds an equivalent `(teamId, formId) => boolean` from A.fetchCommittedFormIds()
// instead (a single bulk query) and passes it into parseFormsRecords the
// same way — see parseSubmission below.
function mockHasCommittedEnvelopeForForm(teamId: string, formId: string): boolean {
  if (!formId) return false;
  return M.submissionsFor(teamId).some((e) => e.status === 'committed' && e.source.form_submission_id === formId);
}

export interface ParsedFormsRow {
  /** Committed matches, including teams the parser could not resolve by name. */
  seen_team_ids: string[];
  row_index: number;
  form_id: string;
  status: 'new' | 'seen' | 'unknown_team';
  team_id: string | null;
  team_name_raw: string;
  classification: 'new' | 'seen' | 'unknown';
  submitter_name: string;
  submitter_email: string;
  submitted_at: string;
  self_certified: boolean;
  dimensions_informed: number;
  links: FormsLink[];
}

interface StagedFormsRow {
  row_index: number;
  form_id: string;
  team_id: string | null;
  team_name_raw: string;
  submitter_name: string;
  submitter_email: string;
  submitted_at: string;
  self_certified: boolean;
  dimension_hints: M.DimensionHint[];
  links: FormsLink[];
}

interface StagedParse {
  source_file: string;
  rows: StagedFormsRow[];
  created_at: number;
}

// Module-level staging store: a parse is held here until a commit consumes
// it (via staging_token) or it expires. Process-local, matching the mock
// provider's other in-memory state (the submissions fixture et al.) — swap for a
// shared cache before running middleware horizontally.
const STAGED_PARSES = new Map<string, StagedParse>();
const STAGE_TTL_MS = 30 * 60 * 1000;

function pruneStagedParses(): void {
  const cutoff = clock.now().getTime() - STAGE_TTL_MS;
  for (const [token, staged] of STAGED_PARSES) {
    if (staged.created_at < cutoff) STAGED_PARSES.delete(token);
  }
}

// `teams`/`hasCommittedEnvelopeForForm` are passed in rather than read from
// module state, so the parsing pipeline is shared verbatim by the mock path
// (M.teams(), mockHasCommittedEnvelopeForForm) and the Aurora path
// (A.fetchAllTeams(), a predicate built from A.fetchCommittedFormIds()).
function parseFormsRecords(
  records: Array<Record<string, string>>,
  sourceFile: string,
  teams: M.MockTeam[],
  hasCommittedEnvelopeForForm: (teamId: string, formId: string) => boolean,
): { rows: ParsedFormsRow[]; staged: StagedFormsRow[]; warnings: string[] } {
  const headers = records.length > 0 ? Object.keys(records[0]!) : [];
  const { columns, warnings } = classifyFormsColumns(headers);
  if (headers.length > 0 && !headers.includes(METADATA_HEADERS.team_name)) {
    warnings.push(`Missing expected column: ${METADATA_HEADERS.team_name}`);
  }

  const rows: ParsedFormsRow[] = [];
  const staged: StagedFormsRow[] = [];

  records.forEach((record, index) => {
    const formId = (record[METADATA_HEADERS.id] ?? '').trim();
    const submitterName = (record[METADATA_HEADERS.name] ?? '').trim();
    const submitterEmail = (record[METADATA_HEADERS.email] ?? '').trim();
    const submittedAt = (record[METADATA_HEADERS.completion_time] ?? '').trim();
    const teamNameRaw = (record[METADATA_HEADERS.team_name] ?? '').trim();
    const selfCertHeader = Object.keys(record).find((h) => h.startsWith(SELF_CERT_PREFIX));
    const selfCertified = selfCertHeader ? (record[selfCertHeader] ?? '').trim().startsWith(AFFIRMATIVE_PREFIX) : false;

    const dimensionHints = buildDimensionHints(record, columns);
    const links: FormsLink[] = [];
    for (const col of columns) {
      const value = record[col.header] ?? '';
      for (const url of extractUrls(value)) links.push({ url, label: col.header, dimension_id: col.dimensionId });
    }

    const teamId = matchTeamId(record, teamNameRaw, teams);
    const status: ParsedFormsRow['status'] = teamId === null
      ? 'unknown_team'
      : hasCommittedEnvelopeForForm(teamId, formId) ? 'seen' : 'new';

    rows.push({
      seen_team_ids: teams.filter(t => hasCommittedEnvelopeForForm(t.id, formId)).map(t => t.id),
      row_index: index,
      form_id: formId,
      status,
      team_id: teamId,
      team_name_raw: teamNameRaw,
      classification: status === 'unknown_team' ? 'unknown' : status,
      submitter_name: submitterName,
      submitter_email: submitterEmail,
      submitted_at: submittedAt,
      self_certified: selfCertified,
      dimensions_informed: dimensionHints.length,
      links,
    });
    staged.push({
      row_index: index, form_id: formId, team_id: teamId, team_name_raw: teamNameRaw,
      submitter_name: submitterName, submitter_email: submitterEmail, submitted_at: submittedAt,
      self_certified: selfCertified, dimension_hints: dimensionHints, links,
    });
  });

  void sourceFile; // kept for signature symmetry with the caller; stored by parseSubmission
  return { rows, staged, warnings };
}

export interface ParseSubmissionResult {
  staging_token: string;
  source_file: string;
  mapping_warnings: string[];
  rows: Array<ParsedSubmissionRow | ParsedFormsRow>;
}

export async function parseSubmission(...a: Parameters<typeof parseSubmissionImpl>): ReturnType<typeof parseSubmissionImpl> {
  const result = await parseSubmissionImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentAllTeamRefs()); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function parseSubmissionImpl(
  payload:
    | { rows: Array<{ team_name_raw: string; team_id?: string }> }
    | { source_file?: string; records: Array<Record<string, string>> },
): Promise<ParseSubmissionResult> {
  if (!config.mock.aurora) {
    const teams = await A.fetchAllTeams();
    if ('rows' in payload) {
      return {
        staging_token: randomUUID(), source_file: '', mapping_warnings: [],
        rows: (payload.rows ?? []).map((row) => classifyLegacyRow(row, teams)),
      };
    }
    const sourceFile = payload.source_file ?? '';
    const committedFormIds = await A.fetchCommittedFormIds();
    const hasCommitted = (teamId: string, formId: string) => !!formId && committedFormIds.has(`${teamId}:${formId}`);
    const { rows, staged, warnings } = parseFormsRecords(payload.records ?? [], sourceFile, teams, hasCommitted);
    pruneStagedParses();
    const stagingToken = randomUUID();
    // See STAGED_PARSES declaration: this stays module-level memory even on
    // the Aurora path — a 30-minute wizard scratch, not durable state.
    STAGED_PARSES.set(stagingToken, { source_file: sourceFile, rows: staged, created_at: clock.now().getTime() });
    return { staging_token: stagingToken, source_file: sourceFile, mapping_warnings: warnings, rows };
  }

  if ('rows' in payload) {
    return {
      staging_token: randomUUID(),
      source_file: '',
      mapping_warnings: [],
      rows: (payload.rows ?? []).map((row) => classifyLegacyRow(row, M.teams())),
    };
  }

  const sourceFile = payload.source_file ?? '';
  const { rows, staged, warnings } = parseFormsRecords(payload.records ?? [], sourceFile, M.teams(), mockHasCommittedEnvelopeForForm);
  pruneStagedParses();
  const stagingToken = randomUUID();
  STAGED_PARSES.set(stagingToken, { source_file: sourceFile, rows: staged, created_at: clock.now().getTime() });
  return { staging_token: stagingToken, source_file: sourceFile, mapping_warnings: warnings, rows };
}

// ─── Commit: build one SubmissionEnvelope per selected staged row ───────────

function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'unknown';
}

// Parses an MS Forms "Completion time" export value (`M/D/YYYY H:mm[:ss]`) as
// UTC, mirroring naming.py's `parse_forms_timestamp`. Falls back to now.
function parseFormsTimestamp(value: string): Date | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if (!m) return null;
  const [, mo, da, yr, hh, mi, ss] = m;
  // Excel-style CSV output writes a two-digit year; both spellings are the export's.
  const year = yr!.length === 2 ? 2000 + Number(yr) : Number(yr);
  const date = new Date(Date.UTC(year, Number(mo) - 1, Number(da), Number(hh ?? '0'), Number(mi ?? '0'), Number(ss ?? '0')));
  return Number.isNaN(date.getTime()) ? null : date;
}

function envelopeStamp(completionTime: string): string {
  const parsed = parseFormsTimestamp(completionTime) ?? clock.now();
  return parsed.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// `sub-<UTC stamp>-form<Id>-<submitter-slug>[-rN]`, mirroring naming.py's
// `build_envelope_id` — used only for a brand-new (revision 1) envelope. A
// later revision instead reuses the existing envelope's base id (see
// `commitSubmissions`), matching how the seeded fixture's `-r2`/`-r3`
// envelopes keep the ORIGINAL submission's stamp.
function buildEnvelopeId(completionTime: string, formId: string, submitterName: string): string {
  return `sub-${envelopeStamp(completionTime)}-form${slugify(formId)}-${slugify(submitterName)}`;
}

export interface CommitResultRow {
  row_index: number;
  team_id: string;
  envelope_id: string;
  links: M.EnvelopeLink[];
  skipped?: boolean;
  reason?: string;
  /** Set when this row lost a race — the same envelope_id was already
   * committed by a concurrent request (see commitSubmissions' Aurora
   * branch). The route maps a result carrying any `conflict: true` row to
   * a 409 rather than a raw 500. */
  conflict?: boolean;
}

export async function commitSubmissions(...a: Parameters<typeof commitSubmissionsImpl>): ReturnType<typeof commitSubmissionsImpl> {
  const result = await commitSubmissionsImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentAllTeamRefs()); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function commitSubmissionsImpl(
  payload:
    | { team_id: string; envelope_ids: string[] }
    | { staging_token: string; selections: Array<{ row_index: number; team_id: string }> },
): Promise<{ committed: string[]; results?: CommitResultRow[] }> {
  if (!config.mock.aurora) {
    if ('envelope_ids' in payload) {
      const committed: string[] = [];
      for (const envelopeId of payload.envelope_ids) {
        if (await A.markSubmissionCommitted(payload.team_id, envelopeId)) committed.push(envelopeId);
      }
      return { committed };
    }

    pruneStagedParses();
    const staged = STAGED_PARSES.get(payload.staging_token);
    if (!staged) throw new NotFoundError('staging token not found or expired');

    const committed: string[] = [];
    const results: CommitResultRow[] = [];
    const nowIso = clock.nowIso();

    for (const selection of payload.selections) {
      const row = staged.rows.find((r) => r.row_index === selection.row_index);
      if (!row) {
        results.push({ row_index: selection.row_index, team_id: selection.team_id, envelope_id: '', links: [], skipped: true, reason: 'row not found in staged parse' });
        continue;
      }

      const teamId = selection.team_id;
      const existingForTeam = await A.fetchSubmissionsForTeam(teamId);
      const existing = existingForTeam
        .filter((e) => row.form_id && e.source.form_submission_id === row.form_id)
        .sort((a, b) => a.revision - b.revision)
        .pop();

      const revision = existing ? existing.revision + 1 : 1;
      const envelopeId = existing
        ? `${baseEnvelopeId(existing.envelope_id)}-r${revision}`
        : buildEnvelopeId(row.submitted_at, row.form_id, row.submitter_name);

      const links: M.EnvelopeLink[] = row.links.map((l) => ({ ...l, status: 'pending' }));

      const envelope: M.SubmissionEnvelope = {
        schema_version: '1.0',
        envelope_id: envelopeId,
        source: { kind: 'ms_forms_export', system: 'microsoft_forms', origin_file: staged.source_file, origin_row: row.row_index + 1, form_submission_id: row.form_id },
        team_id: teamId,
        team_name_raw: row.team_name_raw,
        submitter: { name: row.submitter_name, email: row.submitter_email, is_primary_contact: false },
        submitted_at: row.submitted_at,
        ingested_at: nowIso,
        assessment_date: row.submitted_at,
        self_certified: row.self_certified,
        supersedes: existing ? existing.envelope_id : null,
        dimension_hints: row.dimension_hints,
        links,
        status: 'committed',
        revision,
      };

      // The envelope's own submitted_at/assessment_date stay the raw
      // MS-Forms wire string (see the interface comment) — these parsed
      // ISO values are only for the DB's typed columns.
      const parsedSubmitted = parseFormsTimestamp(row.submitted_at);
      const submittedAtIso = (parsedSubmitted ?? clock.now()).toISOString();
      const assessmentDateIso = parsedSubmitted ? submittedAtIso.slice(0, 10) : null;
      // Atomic: supersede the prior envelope (if any) and insert the
      // replacement in one transaction, with a conflict-safe insert
      // (`envelope_id` is client-computed — two concurrent commits for the
      // same row can race to the same id). `inserted === false` means a
      // concurrent request already won; the supersede was rolled back too,
      // so `existing` (if any) is still `committed`, never left orphaned.
      const inserted = await A.commitSubmissionEnvelope(envelope, submittedAtIso, assessmentDateIso, existing ? existing.envelope_id : null);
      if (!inserted) {
        results.push({
          row_index: row.row_index, team_id: teamId, envelope_id: envelopeId, links,
          skipped: true, conflict: true,
          reason: 'envelope_id already exists — a concurrent commit likely already inserted it',
        });
        continue;
      }

      committed.push(envelopeId);
      results.push({ row_index: row.row_index, team_id: teamId, envelope_id: envelopeId, links });
    }

    return { committed, results };
  }

  if ('envelope_ids' in payload) {
    const committed: string[] = [];
    for (const envelopeId of payload.envelope_ids) {
      const env = M.findSubmission(payload.team_id, envelopeId);
      if (!env) continue;
      env.status = 'committed';
      committed.push(envelopeId);
    }
    return { committed };
  }

  pruneStagedParses();
  const staged = STAGED_PARSES.get(payload.staging_token);
  if (!staged) throw new NotFoundError('staging token not found or expired');

  const committed: string[] = [];
  const results: CommitResultRow[] = [];
  const nowIso = clock.nowIso();

  for (const selection of payload.selections) {
    const row = staged.rows.find((r) => r.row_index === selection.row_index);
    if (!row) {
      results.push({ row_index: selection.row_index, team_id: selection.team_id, envelope_id: '', links: [], skipped: true, reason: 'row not found in staged parse' });
      continue;
    }

    const teamId = selection.team_id;
    const existing = M.submissionsFor(teamId)
      .filter((e) => row.form_id && e.source.form_submission_id === row.form_id)
      .sort((a, b) => a.revision - b.revision)
      .pop();

    const revision = existing ? existing.revision + 1 : 1;
    const envelopeId = existing
      ? `${baseEnvelopeId(existing.envelope_id)}-r${revision}`
      : buildEnvelopeId(row.submitted_at, row.form_id, row.submitter_name);

    const links: M.EnvelopeLink[] = row.links.map((l) => ({ ...l, status: 'pending' }));

    const envelope: M.SubmissionEnvelope = {
      schema_version: '1.0',
      envelope_id: envelopeId,
      source: { kind: 'ms_forms_export', system: 'microsoft_forms', origin_file: staged.source_file, origin_row: row.row_index + 1, form_submission_id: row.form_id },
      team_id: teamId,
      team_name_raw: row.team_name_raw,
      submitter: { name: row.submitter_name, email: row.submitter_email, is_primary_contact: false },
      submitted_at: row.submitted_at,
      ingested_at: nowIso,
      assessment_date: row.submitted_at,
      self_certified: row.self_certified,
      supersedes: existing ? existing.envelope_id : null,
      dimension_hints: row.dimension_hints,
      links,
      status: 'committed',
      revision,
    };

    if (existing) existing.status = 'superseded';
    M.upsertSubmission(envelope);
    committed.push(envelopeId);
    results.push({ row_index: row.row_index, team_id: teamId, envelope_id: envelopeId, links });
  }

  return { committed, results };
}

export async function clearSubmissions(...a: Parameters<typeof clearSubmissionsImpl>): ReturnType<typeof clearSubmissionsImpl> {
  const result = await clearSubmissionsImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentAllTeamRefs()); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function clearSubmissionsImpl(
  payload: { targets: Array<{ team_id: string; envelope_id: string }>; reset?: boolean },
): Promise<{ cleared: number }> {
  if (!config.mock.aurora) {
    let cleared = 0;
    const resetTeams = new Set<string>();
    for (const { team_id, envelope_id } of payload.targets ?? []) {
      if (await A.deleteSubmissionRow(team_id, envelope_id)) { cleared += 1; resetTeams.add(team_id); }
    }
    if (payload.reset) for (const teamId of resetTeams) await resetAssessment(teamId);
    return { cleared };
  }
  let cleared = 0;
  const resetTeams = new Set<string>();
  for (const { team_id, envelope_id } of payload.targets ?? []) {
    if (M.removeSubmission(team_id, envelope_id)) { cleared += 1; resetTeams.add(team_id); }
  }
  if (payload.reset) for (const teamId of resetTeams) await resetAssessment(teamId);
  return { cleared };
}

// ─── Knowledge ──────────────────────────────────────────────────────────────

/**
 * Stamps each SYNCED section with when it last pulled.
 *
 * A pull touches every node in the section, so the newest `updated_at` is the
 * pull. Deriving it here rather than storing it means the rail cannot claim a
 * sync that did not move any rows — and the alternative, a column, would have
 * to be written by the same code path that already does the touching.
 */
function withSyncStamp(sections: M.KnowledgeSection[]): M.KnowledgeSection[] {
  return sections.map((sec) => {
    if (sec.kind !== 'synced') return sec;
    let newest: string | undefined;
    for (const n of sec.nodes) {
      const at = n.updated_at;
      if (at && (newest === undefined || at > newest)) newest = at;
    }
    return newest === undefined ? sec : { ...sec, last_pulled_at: newest };
  });
}

export async function getKnowledgeTree(): Promise<{ sections: M.KnowledgeSection[]; sourceConfigured?: boolean }> {
  const sections=withSyncStamp(config.mock.aurora ? M.knowledgeSections() : await A.fetchKnowledgeTree());
  if (!sourceConfigured()) return {sections,sourceConfigured:false};
  const tree=await readSourceTree();
  const prior=sections.find(section=>section.kind==='synced');
  const synced:M.KnowledgeSection={key:prior?.key ?? 'confluence',title:prior?.title ?? 'Confluence',kind:'synced',provider:'confluence',last_pulled_at:tree.pulled_at,
    nodes:[...tree.nodes].sort((a,b)=>a.position-b.position).map(node=>({id:`page:${node.page_id}`,title:node.title,parent_id:node.parent_id && tree.nodes.some(candidate=>candidate.page_id===node.parent_id)?`page:${node.parent_id}`:null,is_dir:node.has_children,classification:'synced',editable:true,viewable:true,page_id:node.page_id,updated_at:tree.pulled_at}))};
  return {sections:[...sections.filter(section=>section.kind!=='synced'),synced],sourceConfigured:true};
}

// Synced Confluence pages are read-only mirrors. In the source app they come
// from a separate endpoint (`/confluence/pages/:id`); here the explorer asks
// the one doc endpoint for every node, and a `page:` id with no local doc
// 404'd — so selecting any synced page rendered an error. Under mock the
// page body is synthesised from the tree node, in one place.
const SYNCED_PAGE_BODIES: Record<string, string> = {
  '100002': `Every team is assessed against **17 dimensions**, each scored on a 0–5 growth scale: Below Baseline, Initial, Developing, Defined, Measured, Optimizing.

## Two tracks, never one number
- **Claimed level** — what the team's self-rating implies.
- **Verified level** — what the evidence on file actually establishes.
A gap between the two is the normal state of a baseline, not a fault.

## Levels 4 and 5 are exceptional
Level 4 requires *observed* evidence — pipelines, dashboards, code. Level 5 additionally requires that practice sustained over time.`,
  '100003': `Each team follows the playbook for its cohort.

- **White Glove** — Kick-off with the named lead, two 1:1 assessment reviews with transcripts into intake, an evidence walk-through against the open claims, then the summary published to the team's Confluence space.
- **Self-Service** — The team completes the Forms self-assessment, the envelope is ingested and its links fetched, \`process-self-assessment\` scores what the envelope informs, and follow-ups go back through Teams.`,
  '100004': `## Northstar Payments
Northstar is a White Glove team led by Jonas Lindqvist, with Asha Nair as the assessor.

1. Kick-off with Deepa Natarajan and Idris Diallo.
2. Review the two repositories, northstar-payments-api and northstar-payments-infra, against the open claims.
3. Walk through the governance review minutes with the team.
4. Publish the summary to the PAY space.`,
  '100005': `**Why did my verified level come out below what I rated?**
Because verification can only reach as far as the evidence on file. Nothing was revised down — the claim stays open until an artifact lets us see the practice.

**Can a dimension be N/A?**
Only through an approved exception. A claimed N/A is recorded as a request for a human to approve.`,
};

function syncedPageDoc(id: string): M.KnowledgeDoc | null {
  const node = M.knowledgeSections().flatMap((sec) => sec.nodes).find((n) => n.id === id);
  if (!node?.page_id) return null;
  const body = SYNCED_PAGE_BODIES[node.page_id]
    ?? `_${node.title}_ — synced from Confluence. Edit it there; this mirror is read-only.`;
  return {
    id, title: node.title, classification: 'synced',
    markdown: `# ${node.title}\n\n${body}\n`,
    editable: false, path: `confluence/${node.page_id}`, updated_at: node.updated_at ?? clock.nowIso(),
  };
}

export async function getKnowledgeDoc(id: string): Promise<M.KnowledgeDoc | null> {
  if (sourceConfigured() && id.startsWith('page:')) {
    const page=await readSourcePage(id);
    return {id,title:page.meta.title,classification:'synced',markdown:page.markdown,editable:true,path:`confluence/${page.meta.page_id}`,updated_at:page.meta.last_pulled_at};
  }
  if (!config.mock.aurora) {
    const doc = await A.fetchKnowledgeDoc(id);
    if (doc) return doc;
    return null; // Production never manufactures a Confluence body from demo fixtures.
  }
  return M.findKnowledgeDoc(id) ?? (id.startsWith('page:') ? syncedPageDoc(id) : null);
}

export async function putKnowledgeDoc(...a: Parameters<typeof putKnowledgeDocImpl>): ReturnType<typeof putKnowledgeDocImpl> {
  const result = await putKnowledgeDocImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentDocumentRefs([a[0]])); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function putKnowledgeDocImpl(
  id: string, markdown: string, opts: { label?: string | null; actor?: string } = {},
): Promise<{ ok: boolean; updated_at: string } | null> {
  await assertLegacyDocumentWritable(id);
  if (!config.mock.aurora) {
    const doc = await A.fetchKnowledgeDoc(id);
    if (!doc) return null;
    const stamp = stampNow();
    await A.insertKnowledgeDocVersion(id, {
      stamp, label: opts.label ?? null, size: doc.markdown.length, savedAt: doc.updated_at,
      markdown: doc.markdown, savedBy: opts.actor ?? null,
    });
    const now = clock.nowIso();
    await A.updateKnowledgeDocMarkdown(id, markdown, now);
    assessmentBroker.publish({ type: 'knowledge.doc.saved', id, stamp, by: opts.actor ?? 'unknown', ts: now });
    return { ok: true, updated_at: now };
  }
  const doc = M.findKnowledgeDoc(id);
  if (!doc) return null;
  const stamp = stampNow();
  const versions = M.ensureVersionsFor(id);
  versions.push({ stamp, label: opts.label ?? null, saved_at: doc.updated_at, markdown: doc.markdown });
  doc.markdown = markdown;
  doc.updated_at = clock.nowIso();
  assessmentBroker.publish({ type: 'knowledge.doc.saved', id, stamp, by: opts.actor ?? 'unknown', ts: doc.updated_at });
  return { ok: true, updated_at: doc.updated_at };
}

export async function getKnowledgeDocVersions(id: string): Promise<M.KnowledgeDocVersion[] | null> {
  if (!config.mock.aurora) {
    if (!(await A.fetchKnowledgeDoc(id))) return null;
    return A.fetchKnowledgeDocVersions(id);
  }
  if (!M.findKnowledgeDoc(id)) return null;
  // `size` is markdown.length, computed here. Stored beside the markdown it
  // counted, the seeded snapshots claimed 210 B and 340 B over 61 and 130.
  return [...M.versionsFor(id)].sort((a, b) => b.stamp.localeCompare(a.stamp)).map(M.docVersionOut);
}

export async function getKnowledgeDocVersion(id: string, stamp: string): Promise<M.KnowledgeDocVersion | null> {
  if (!config.mock.aurora) return A.fetchKnowledgeDocVersion(id, stamp);
  const version = M.versionsFor(id).find((v) => v.stamp === stamp);
  return version ? M.docVersionOut(version) : null;
}

export async function restoreKnowledgeDocVersion(...a: Parameters<typeof restoreKnowledgeDocVersionImpl>): ReturnType<typeof restoreKnowledgeDocVersionImpl> {
  const result = await restoreKnowledgeDocVersionImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentDocumentRefs([a[0]])); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function restoreKnowledgeDocVersionImpl(
  id: string, stamp: string, actor = 'unknown',
): Promise<{ ok: boolean; updated_at: string } | null> {
  await assertLegacyDocumentWritable(id);
  if (!config.mock.aurora) {
    const doc = await A.fetchKnowledgeDoc(id);
    const version = doc ? await A.fetchKnowledgeDocVersion(id, stamp) : null;
    if (!doc || !version) return null;
    const restoreStamp = stampNow();
    await A.insertKnowledgeDocVersion(id, {
      stamp: restoreStamp, label: 'pre-restore snapshot', size: doc.markdown.length,
      savedAt: doc.updated_at, markdown: doc.markdown, savedBy: actor,
    });
    const now = clock.nowIso();
    await A.updateKnowledgeDocMarkdown(id, version.markdown, now);
    assessmentBroker.publish({ type: 'knowledge.doc.saved', id, stamp: restoreStamp, by: actor, ts: now });
    return { ok: true, updated_at: now };
  }
  const doc = M.findKnowledgeDoc(id);
  const version = M.versionsFor(id).find((v) => v.stamp === stamp);
  if (!doc || !version) return null;
  const restoreStamp = stampNow();
  const versions = M.ensureVersionsFor(id);
  versions.push({ stamp: restoreStamp, label: 'pre-restore snapshot', saved_at: doc.updated_at, markdown: doc.markdown });
  doc.markdown = version.markdown;
  doc.updated_at = clock.nowIso();
  assessmentBroker.publish({ type: 'knowledge.doc.saved', id, stamp: restoreStamp, by: actor, ts: doc.updated_at });
  return { ok: true, updated_at: doc.updated_at };
}

// ─── Pull / publish (mock Confluence sync) ──────────────────────────────────
//
// The source app syncs a whole Confluence space in one direction (pull) and
// pushes a single reviewed local draft the other way (publish). There is no
// real Confluence here — "pull" just bumps the synced section's pages'
// updated_at after a short delay (so the portal's pending state has
// something to show) and reports plausible counts; "publish" turns one
// editable local doc into a page node under the synced section, versioned by
// a simple in-memory counter.

const KNOWLEDGE_PULL_DELAY_MS = 1_500;
const publishedVersions = new Map<string, number>();

export type PullSectionResult = { ok: true } | { ok: false; status: 404 | 409 | 503; reason: string };

/**
 * Kicks off a mock Confluence pull for a synced section. Returns immediately
 * ("in progress") — the `knowledge.pulled` event (with plausible counts) is
 * published after KNOWLEDGE_PULL_DELAY_MS, which is what the portal's Pull
 * button actually waits on via the SSE stream, not this response.
 */
export async function pullKnowledgeSection(...a: Parameters<typeof pullKnowledgeSectionImpl>): ReturnType<typeof pullKnowledgeSectionImpl> {
  const result = await pullKnowledgeSectionImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentDocumentRefs()); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function pullKnowledgeSectionImpl(sectionKey: string): Promise<PullSectionResult> {
  if (sourceConfigured()) return {ok:false,status:409,reason:'Pull individual source pages so collaborative changes can be reviewed before replacement'};
  if (!config.mock.aurora) return {ok:false,status:503,reason:'Document source is not configured'};
  const section = M.knowledgeSections().find((s) => s.key === sectionKey && s.kind === 'synced');
  if (!section) return { ok: false, status: 404, reason: `no synced section "${sectionKey}"` };

  const timer = setTimeout(() => {
    const now = clock.nowIso();
    const pageNodes = section.nodes.filter((n) => !n.is_dir);
    for (const n of pageNodes) n.updated_at = now;
    assessmentBroker.publish({
      type: 'knowledge.pulled',
      section: sectionKey,
      pages: section.nodes.length,
      files_pulled: pageNodes.length,
      ts: now,
    });
  }, KNOWLEDGE_PULL_DELAY_MS);
  timer.unref?.();

  return { ok: true };
}

export type PublishDocResult = { ok: true; page_id: string; version: number } | { ok: false; status: 404 | 409 | 503; reason: string };

export type MoveNodeResult =
  | { ok: true; id: string; parent_id: string | null; position: number; section: string }
  | { ok: false; status: 400 | 404 | 409; reason: string };

/**
 * Reparents / reorders one node in the knowledge tree.
 *
 * The library's `TreeView` has shipped HTML5 drag-and-drop the whole time —
 * passing `onReorder` turns it on, and `TreeNode.status` ('pending' | 'moved')
 * exists so a host can draw the optimistic state while the server answers.
 * What was missing was somewhere to put the move, which is this.
 *
 * Four things are refused rather than quietly allowed, because each one would
 * make the tree tell a lie:
 *
 *  - a SYNCED section is a read-only mirror of Confluence. Dragging a page
 *    inside it would move something here and nowhere else, and the next pull
 *    would silently undo it. The user asked for this "assuming there is a
 *    remote source of course" — there is, and it owns that subtree.
 *  - crossing sections, for the same reason in reverse: `publish` is the one
 *    sanctioned way a doc leaves local, and it mints a page rather than
 *    relocating a file.
 *  - dropping a node onto its own descendant, which detaches the subtree from
 *    the root and makes it unreachable.
 *  - dropping into a leaf: only a directory can be a parent.
 *
 * Sibling order is the section array's own order filtered by parent, so a move
 * is a splice rather than a `position` column to keep in step; the Aurora path
 * does carry a real `position` and renumbers the destination's children.
 */
export async function moveKnowledgeNode(...a: Parameters<typeof moveKnowledgeNodeImpl>): ReturnType<typeof moveKnowledgeNodeImpl> {
  const result = await moveKnowledgeNodeImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentDocumentRefs()); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function moveKnowledgeNodeImpl(
  id: string, targetParentId: string | null, position: number, actor = 'unknown',
): Promise<MoveNodeResult> {
  if (!Number.isInteger(position) || position < 0) {
    return { ok: false, status: 400, reason: 'position must be a non-negative integer' };
  }
  if (id === targetParentId) return { ok: false, status: 409, reason: 'a node cannot be its own parent' };

  if (!config.mock.aurora) {
    const node = await A.fetchKnowledgeNode(id);
    if (!node) return { ok: false, status: 404, reason: `node "${id}" not found` };
    const sections = await A.fetchKnowledgeTree();
    const verdict = checkMove(sections, id, targetParentId);
    if (!verdict.ok) return verdict;
    const at = await A.moveKnowledgeNodeRow(id, targetParentId, position);
    assessmentBroker.publish({
      type: 'knowledge.moved', id, parent_id: targetParentId, position: at, by: actor,
      ts: clock.nowIso(),
    });
    return { ok: true, id, parent_id: targetParentId, position: at, section: verdict.section };
  }

  const sections = M.knowledgeSections();
  const verdict = checkMove(sections, id, targetParentId);
  if (!verdict.ok) return verdict;
  const section = sections.find((sec) => sec.key === verdict.section)!;

  const nodes = section.nodes;
  const from = nodes.findIndex((n) => n.id === id);
  const [moved] = nodes.splice(from, 1);
  moved!.parent_id = targetParentId;

  // Where the `position`-th child of the new parent starts in the flat array.
  const siblings = nodes.filter((n) => n.parent_id === targetParentId);
  const clamped = Math.min(position, siblings.length);
  const insertAt = clamped === siblings.length
    ? (siblings.length === 0
        // First child of this parent: sit directly after the parent row, or at
        // the head of the section when the parent is the section root.
        ? (targetParentId === null ? 0 : nodes.findIndex((n) => n.id === targetParentId) + 1)
        : nodes.indexOf(siblings[siblings.length - 1]!) + 1)
    : nodes.indexOf(siblings[clamped]!);
  nodes.splice(insertAt, 0, moved!);

  assessmentBroker.publish({
    type: 'knowledge.moved', id, parent_id: targetParentId, position: clamped, by: actor,
    ts: clock.nowIso(),
  });
  return { ok: true, id, parent_id: targetParentId, position: clamped, section: section.key };
}

export type RenameNodeResult =
  | { ok: true; id: string; title: string; section: string }
  | { ok: false; status: 400 | 404 | 409; reason: string };

/**
 * Renames one node's display title.
 *
 * `TreeViewProps` has no `onRename` — unlike `onReorder`, this one really is
 * absent from the library — so the affordance is a per-row `renderTrailing`
 * menu rather than an inline edit. That is the library's own slot, not a
 * hand-rolled row.
 *
 * The id is deliberately NOT derived from the title. Ids here look like paths
 * (`ec:standards/ci-cd-standards.md`) and they are referenced by the doc
 * fixture, the versions, the comments channel and any URL someone has already
 * shared — renaming the display title must not break a bookmark. So a rename
 * is a title change and nothing else, which also means two siblings COULD end
 * up sharing a title without colliding. It is still refused: a rail with two
 * identically-named rows is unreadable even when it is unambiguous underneath.
 */
export async function renameKnowledgeNode(...a: Parameters<typeof renameKnowledgeNodeImpl>): ReturnType<typeof renameKnowledgeNodeImpl> {
  const result = await renameKnowledgeNodeImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentDocumentRefs()); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function renameKnowledgeNodeImpl(
  id: string, rawTitle: string, actor = 'unknown',
): Promise<RenameNodeResult> {
  const title = String(rawTitle ?? '').trim();
  if (!title) return { ok: false, status: 400, reason: 'a title is required' };
  if (title.length > 120) return { ok: false, status: 400, reason: 'a title must be 120 characters or fewer' };
  // A newline would break the single-line row it renders in, and the tab is
  // here because pasting from a spreadsheet is the usual way one arrives.
  if (/[\n\r\t]/.test(title)) return { ok: false, status: 400, reason: 'a title must be a single line' };

  const sections = !config.mock.aurora
    ? await A.fetchKnowledgeTree()
    : M.knowledgeSections();

  // A prompt's name is the fleet's command name, so it is never renamed here:
  // the portal hides Rename on prompts, and the server refuses too — the
  // 2026-09-29 explorer rebuild briefly offered Rename on every row and this
  // accepted it. Its BODY is edited through a canvas draft (parity goal
  // decision 7); the published prompt moves only through its promotion path.
  if (id.startsWith('prompt:')) {
    return { ok: false, status: 409, reason: 'prompts cannot be renamed; a prompt\'s name is the command the fleet runs' };
  }
  const section = sections.find((sec) => sec.nodes.some((n) => n.id === id));
  if (!section) return { ok: false, status: 404, reason: `node "${id}" not found` };
  if (section.kind !== 'local') {
    return {
      ok: false, status: 409,
      reason: `"${section.title}" mirrors ${section.provider ?? 'a remote source'}; rename it there, not here`,
    };
  }
  const node = section.nodes.find((n) => n.id === id)!;
  if (node.title === title) return { ok: true, id, title, section: section.key };

  const clash = section.nodes.some(
    (n) => n.id !== id && (n.parent_id ?? null) === (node.parent_id ?? null) && n.title === title,
  );
  if (clash) return { ok: false, status: 409, reason: `a sibling is already called "${title}"` };

  if (!config.mock.aurora) {
    await A.renameKnowledgeNodeRow(id, title);
  } else {
    node.title = title;
  }

  assessmentBroker.publish({
    type: 'knowledge.renamed', id, title, by: actor, ts: clock.nowIso(),
  });
  return { ok: true, id, title, section: section.key };
}

/** The rules, shared by both paths so they cannot drift apart. */
function checkMove(
  sections: M.KnowledgeSection[], id: string, targetParentId: string | null,
): { ok: true; section: string } | { ok: false; status: 400 | 404 | 409; reason: string } {
  const section = sections.find((sec) => sec.nodes.some((n) => n.id === id));
  if (!section) return { ok: false, status: 404, reason: `node "${id}" not found` };
  if (section.kind !== 'local') {
    return {
      ok: false, status: 409,
      reason: `"${section.title}" mirrors ${section.provider ?? 'a remote source'}; move it there, not here`,
    };
  }
  if (targetParentId !== null) {
    const parent = section.nodes.find((n) => n.id === targetParentId);
    if (!parent) {
      const elsewhere = sections.some((sec) => sec.nodes.some((n) => n.id === targetParentId));
      return elsewhere
        ? { ok: false, status: 409, reason: 'a node cannot move between sections — publish it instead' }
        : { ok: false, status: 404, reason: `parent "${targetParentId}" not found` };
    }
    if (!parent.is_dir) return { ok: false, status: 409, reason: `"${parent.title}" is not a folder` };
    // Walk up from the target: meeting the moved node means the drop is inside
    // its own subtree, which would orphan everything under it.
    for (let p: string | null = targetParentId; p !== null; ) {
      if (p === id) return { ok: false, status: 409, reason: 'a node cannot move inside itself' };
      p = section.nodes.find((n) => n.id === p)?.parent_id ?? null;
    }
  }
  return { ok: true, section: section.key };
}

/**
 * Publishes one editable local doc up into the synced section as a page —
 * the "draft-confluence-page, then a human publishes it" flow
 * (docs/assessment-tenant.md), collapsed to a single deterministic step
 * since there's no real Confluence to push to. Re-publishing the same doc
 * updates its existing page in place and increments its version.
 */
export async function publishKnowledgeDoc(...a: Parameters<typeof publishKnowledgeDocImpl>): ReturnType<typeof publishKnowledgeDocImpl> {
  const result = await publishKnowledgeDocImpl(...a);
  try { await noteSearchWrite(...await (await searchRefs()).assessmentDocumentRefs()); } catch { /* the index never fails the write it follows */ }
  return result;
}

async function publishKnowledgeDocImpl(id: string, actor = 'unknown'): Promise<PublishDocResult> {
  if (sourceConfigured()) return {ok:false,status:409,reason:'Preview and explicitly publish the acknowledged document version through source workflows'};
  if (!config.mock.aurora) return {ok:false,status:503,reason:'Document source is not configured'};
  const doc = M.findKnowledgeDoc(id);
  if (!doc) return { ok: false, status: 404, reason: `document "${id}" not found` };
  const target = M.knowledgeSections().find((s) => s.kind === 'synced');
  if (!target) return { ok: false, status: 404, reason: 'no synced section to publish into' };

  const pageId = `published:${id}`;
  const version = (publishedVersions.get(pageId) ?? 0) + 1;
  publishedVersions.set(pageId, version);

  const now = clock.nowIso();
  const existing = target.nodes.find((n) => n.id === `page:${pageId}`);
  if (existing) {
    existing.updated_at = now;
    existing.title = doc.title;
  } else {
    target.nodes.push({
      id: `page:${pageId}`, title: doc.title, parent_id: null, is_dir: false,
      classification: doc.classification, editable: false, viewable: true, updated_at: now, page_id: pageId,
    });
  }

  assessmentBroker.publish({ type: 'knowledge.published', id, page_id: pageId, version, ts: now });
  void actor; // published-by isn't modeled on the page node yet — kept for the event/audit trail
  return { ok: true, page_id: pageId, version };
}

/**
 * Records a comment on a document and broadcasts it. The comment THREAD
 * itself lives in the realtime gateway's chat store (the portal's per-doc
 * `assessment:doc:<id>` channel, via WrappedChatPanel) — this is the
 * server-side echo so a viewer who isn't currently on that channel (the
 * dashboard activity bar, another tab) still sees "a comment happened"
 * through GET /events.
 */
/**
 * The thread on one document, oldest first.
 *
 * This read did not exist: `createKnowledgeComment` had an INSERT and nothing
 * anywhere had a SELECT, so a comment was write-only and the pane rebuilt its
 * thread from live echoes alone. Reload and the thread was gone, under a
 * drawer saying "No comments on this document yet".
 */
export type CommentWriteResult =
  | { ok: true; id: string; body: string; edited_at?: string | null; deleted_at?: string | null }
  | { ok: false; status: 400 | 403 | 404 | 409; reason: string };

/**
 * Once a document's legacy thread has been imported into platform-api
 * (providers/document-comment-import.ts), this store is no longer read, so a
 * write here would vanish from every reader. Refused, naming where to go.
 */
export const COMMENTS_MOVED = 'Comments on this document moved to its Comments tab (platform-api); this thread is read-only.';

/**
 * Edit or soft-delete one comment.
 *
 * Authorship is decided from the SESSION, never the body — the same rule the
 * presence route states — so a caller cannot edit someone else's comment by
 * naming them. A moderator path would be a different capability check, and
 * there isn't one yet: right now the author is the only person who can change
 * their own words, which is the conservative half of the decision.
 *
 * Delete is soft. `deleted_at` is a timestamp rather than a flag because the
 * panel renders WHEN, and the row keeps its place in the thread: removing it
 * outright leaves a hole in a conversation other people are part-way through.
 */
export async function editKnowledgeComment(
  commentId: string, rawBody: string, actor: string,
): Promise<CommentWriteResult> {
  const body = String(rawBody ?? '').trim();
  if (!body) return { ok: false, status: 400, reason: 'a comment body is required' };
  const found = await findComment(commentId);
  if (!found) return { ok: false, status: 404, reason: `comment "${commentId}" not found` };
  if (await legacyThreadMoved(found.doc_id)) return { ok: false, status: 409, reason: COMMENTS_MOVED };
  if (found.author !== actor) return { ok: false, status: 403, reason: 'only the author can edit a comment' };
  if (found.deleted_at) return { ok: false, status: 400, reason: 'that comment was deleted' };

  const now = clock.nowIso();
  if (!config.mock.aurora) await A.updateKnowledgeComment(commentId, body, now);
  else { found.body = body; found.edited_at = now; }

  assessmentBroker.publish({
    type: 'knowledge.comment.edited', id: commentId, doc_id: found.doc_id, by: actor, body, ts: now,
  });
  return { ok: true, id: commentId, body, edited_at: now };
}

export async function deleteKnowledgeComment(
  commentId: string, actor: string,
): Promise<CommentWriteResult> {
  const found = await findComment(commentId);
  if (!found) return { ok: false, status: 404, reason: `comment "${commentId}" not found` };
  if (await legacyThreadMoved(found.doc_id)) return { ok: false, status: 409, reason: COMMENTS_MOVED };
  if (found.author !== actor) return { ok: false, status: 403, reason: 'only the author can delete a comment' };
  if (found.deleted_at) return { ok: true, id: commentId, body: found.body, deleted_at: found.deleted_at };

  const now = clock.nowIso();
  if (!config.mock.aurora) await A.softDeleteKnowledgeComment(commentId, now);
  else found.deleted_at = now;

  assessmentBroker.publish({
    type: 'knowledge.comment.deleted', id: commentId, doc_id: found.doc_id, by: actor, ts: now,
  });
  return { ok: true, id: commentId, body: found.body, deleted_at: now };
}

/** The row itself, so both writers share one lookup and one 404. */
async function findComment(commentId: string): Promise<M.KnowledgeComment | null> {
  if (!config.mock.aurora) return A.fetchKnowledgeComment(commentId);
  return M.knowledgeCommentsFixture.rows().find((c) => c.id === commentId) ?? null;
}

/**
 * Every reaction on a document and on its comments, in one read.
 *
 * The pane needs the doc's own bar plus one bar per comment, so it asks for the
 * page rather than the row — the alternative is a request per comment on a
 * thread that can be long.
 */
export async function listKnowledgeReactions(docId: string, extraTargets: readonly string[] = []): Promise<M.KnowledgeReaction[] | null> {
  const comments = await listKnowledgeComments(docId);
  if (comments === null) return null;
  // `extraTargets`: comments written on platform-api since the thread moved
  // (routes pass providers/document-comments.ts documentCommentTargetIds).
  // Imported comments keep their legacy ids, so their reactions still match.
  const targets = [...new Set([docId, ...comments.map((c) => c.id), ...extraTargets])];
  if (!config.mock.aurora) return A.fetchKnowledgeReactions(targets);
  const wanted = new Set(targets);
  return M.knowledgeReactionsFixture.rows().filter((r) => wanted.has(r.target_id));
}

export type ReactionToggleResult =
  | { ok: true; target_id: string; emoji: string; reacted: boolean }
  | { ok: false; status: 400 | 404; reason: string };

/**
 * Adds or removes the caller's reaction. The (target, emoji, actor) key IS the
 * toggle, so reacting twice is an add then a remove and never a count of two —
 * which is what `mine` on the summary depends on.
 *
 * The target may be the document or one of its comments; both are checked so a
 * reaction cannot attach to something that does not exist.
 */
export async function toggleKnowledgeReaction(
  docId: string, targetId: string, emoji: string, actor: string, extraTargets: readonly string[] = [],
): Promise<ReactionToggleResult> {
  const trimmed = String(emoji ?? '').trim();
  if (!trimmed) return { ok: false, status: 400, reason: 'an emoji is required' };
  if (trimmed.length > 16) return { ok: false, status: 400, reason: 'that is not an emoji' };

  const comments = await listKnowledgeComments(docId);
  if (comments === null) return { ok: false, status: 404, reason: `document "${docId}" not found` };
  const valid = targetId === docId || comments.some((c) => c.id === targetId) || extraTargets.includes(targetId);
  if (!valid) return { ok: false, status: 404, reason: `"${targetId}" is not this document or one of its comments` };

  const now = clock.nowIso();
  let reacted: boolean;
  if (!config.mock.aurora) {
    reacted = await A.toggleKnowledgeReaction(targetId, trimmed, actor, now);
  } else {
    const rows = M.knowledgeReactionsFixture.rows();
    const at = rows.findIndex((r) => r.target_id === targetId && r.emoji === trimmed && r.actor === actor);
    if (at >= 0) { rows.splice(at, 1); reacted = false; }
    else { rows.push({ target_id: targetId, emoji: trimmed, actor, created_at: now }); reacted = true; }
  }

  assessmentBroker.publish({
    type: 'knowledge.reaction.toggled',
    doc_id: docId, target_id: targetId, emoji: trimmed, by: actor, reacted, ts: now,
  });
  return { ok: true, target_id: targetId, emoji: trimmed, reacted };
}

export async function listKnowledgeComments(id: string): Promise<M.KnowledgeComment[] | null> {
  if (!(await getKnowledgeDoc(id))) return null;
  if (!config.mock.aurora) {
    return A.fetchKnowledgeComments(id);
  }
  return M.knowledgeComments(id).map(c => ({ ...c, parent_id: c.parent_id ?? null }));
}

export async function createKnowledgeComment(
  id: string, body: string, actor = 'unknown', parentId: string | null = null,
): Promise<{ ok: true } | { ok: false; reason: string; status?: 409 } | null> {
  if (!(await getKnowledgeDoc(id))) return null;
  if (await legacyThreadMoved(id)) return { ok: false, status: 409, reason: COMMENTS_MOVED };
  const commentId = `comment-${stampNow()}-${hex(6)}`;
  const now = clock.nowIso();
  if (!config.mock.aurora) {
    if (!(await A.insertKnowledgeComment(commentId, id, body, actor, now, parentId))) {
      return { ok: false, reason: 'Invalid reply parent' };
    }
  } else {
    if (parentId !== null && !M.knowledgeCommentsFixture.rows().some(c =>
      c.id === parentId && c.doc_id === id && !c.deleted_at)) {
      return { ok: false, reason: 'Invalid reply parent' };
    }
    M.knowledgeCommentsFixture.rows().push({
      id: commentId, doc_id: id, parent_id: parentId, body, author: actor, created_at: now,
    });
  }
  assessmentBroker.publish({
    type: 'knowledge.comment.created', id: commentId, doc_id: id,
    parent_id: parentId, by: actor, body, ts: now,
  });
  return { ok: true };
}
