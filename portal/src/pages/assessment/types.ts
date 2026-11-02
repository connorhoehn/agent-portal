// The assessment domain model, ported verbatim (shapes + wording) from
// agentic-assessment-accelerator's `ui/src/components/assessment/types.ts`.
//
// Nothing here is React. The two-track certification stance is the whole
// point of the product and has to survive the port exactly: a dimension
// reports a CLAIMED level and a VERIFIED level side by side, never a single
// number, and a claim sitting above verification is `claim_open` — a request
// for evidence, never a fault, never "capped".
//
// Every certification field is optional so a response from an API build that
// predates this model still types and renders — the UI falls back to a
// "Not yet assessed" placeholder rather than inventing a level.
//
// ⚠️ This file is owned by the primary Dashboard build (docs/assessment-tenant.md
// "Assessment page" section) — TeamSummary/TeamDetail/Dimension/certification
// shapes for /assessment/teams and /assessment/teams/:teamId. The secondary
// pages (Submissions, Feedback, Reports, Runs/Activity, Configuration) need
// their own wire types (RunRecord, SubmissionListItem, FeedbackTask, etc.) —
// those belong in a differently-named module (e.g. secondaryTypes.ts), not
// here: this file was clobbered once already by a secondary-pages build that
// wrote conflicting Cohort/MotionConfig/RecommendationKind shapes to this same
// path. Do not re-merge that content in — the kind vocabulary here
// ("close_the_claim" | "advance_practice" | "answer_question") is copied
// verbatim from the source app; the other shapes invented different strings.

import type { ChipTone } from '@connorhoehnslalom/ui-components/shared';

// ─── Cohorts / motions ──────────────────────────────────────────────────────

export type Cohort = 'white_glove' | 'self_service' | 'general';

export interface MotionConfig {
  cohort: Cohort;
  title: string;
  tag: string;
  /** The source used a raw hex per motion for a CSS gradient tag; re-expressed
   *  as a Chip tone so the tag renders through the library's tone palette. */
  accent: ChipTone;
  description: string;
}

/** Fallback/initial-render value for cohort landing cards — mirrors the
 *  source's MOTIONS constant. `GET/PUT /api/assessment/configuration` is the
 *  live source of truth once loaded. */
export const MOTIONS: MotionConfig[] = [
  {
    cohort: 'white_glove',
    title: 'White Glove',
    tag: 'HIGH-TOUCH',
    accent: 'accent',
    description: 'Dedicated, hands-on assessment engagements with a named lead.',
  },
  {
    cohort: 'self_service',
    title: 'Self-Service',
    tag: 'GUIDED',
    accent: 'info',
    description: 'Guided self-assessment with light-touch review checkpoints.',
  },
  {
    cohort: 'general',
    title: 'Assessment Factory',
    tag: 'SCALED',
    accent: 'neutral',
    description: 'Automated, at-scale factory assessment across the portfolio.',
  },
];

export const motionFor = (cohort: Cohort): MotionConfig =>
  MOTIONS.find((m) => m.cohort === cohort) ?? MOTIONS[2];

// ─── Certification — the two-track statement ───────────────────────────────

export type CertificationStatus = 'verified' | 'claim_open' | 'not_applicable' | 'pending';

/** "self-attested" | "documented" | "verified" — widened so an unknown basis
 *  renders as-is rather than being coerced into one of three known values. */
export type CertificationBasis = string;

/** Team aggregate: counts against the target level, never a scalar, mean, or
 *  percentage. */
export interface TeamCertification {
  target_level: number;
  at_or_above_target: number;
  /** The other two halves of the same count, over the dimensions verification
   *  has reached a level on: `at_or_above_target + below_target === assessed`,
   *  and `above_target <= at_or_above_target`. The server counts both on every
   *  team rollup (`teamCertification` in middleware/src/providers/assessment.ts),
   *  so neither is optional. */
  below_target: number;
  above_target: number;
  assessed: number;
  applicable: number;
  not_applicable?: number;
  /** Dimensions whose claim sits above what verification reached. */
  claims_open?: number;
  /** Highest verified level across the team's dimensions. The server spells
   *  this `highest_verified_level`; `max_verified_level` is the client-derived
   *  name. Read both through `highestVerifiedLevel()`. */
  max_verified_level?: number | null;
  highest_verified_level?: number | null;
  basis?: CertificationBasis;
  status?: CertificationStatus | string;
  /** Server-rendered headline, e.g. "Verified to Level 3 on 13 of 17 dimensions". */
  headline?: string;
  /** Server-rendered sub-line. `sub_line` is the SOURCE APP's spelling; this
   *  port has always sent `subline`, and only `subline`. */
  subline?: string | null;
}

export const highestVerifiedLevel = (
  cert: TeamCertification | null | undefined,
): number | null => {
  if (!cert) return null;
  return cert.highest_verified_level ?? cert.max_verified_level ?? null;
};

/** Per-dimension certification — claimed track and verified track, side by side. */
export interface DimensionCertification {
  /** How far the evidence reaches. null = nothing verified yet. */
  verified_level: number | null;
  /** What the team says. null = no claim on file — never imply agreement. */
  claimed_level: number | null;
  /** claimed − verified; null when there is no claim. */
  verification_gap?: number | null;
  basis?: CertificationBasis;
  status?: CertificationStatus | string;
  meets_target?: boolean;
  target_level?: number;
  /** The specific artifact that would let verification go higher. */
  to_verify_higher?: string | null;
  /** Server-rendered statement, e.g. "Claimed Level 5 · Verified up to Level 2". */
  statement?: string;
}

/** True when the team's claim sits above what verification reached. */
export const hasOpenClaim = (cert: DimensionCertification | null | undefined): boolean => {
  if (!cert) return false;
  if (cert.status === 'claim_open') return true;
  if (typeof cert.verification_gap === 'number') return cert.verification_gap > 0;
  if (cert.claimed_level === null || cert.claimed_level === undefined) return false;
  if (cert.verified_level === null || cert.verified_level === undefined) return true;
  return cert.claimed_level > cert.verified_level;
};

/** "Claimed Level 5 · Verified up to Level 2" — both facts, never one awarded number. */
export const dimensionCertificationStatement = (
  cert: DimensionCertification | null | undefined,
): string | null => {
  if (!cert) return null;
  if (cert.statement) return cert.statement;
  const verified =
    cert.verified_level === null || cert.verified_level === undefined
      ? 'Not yet verified'
      : `Verified up to Level ${cert.verified_level}`;
  if (cert.claimed_level === null || cert.claimed_level === undefined) {
    return `${verified} · no claim on file`;
  }
  if (cert.verified_level !== null && cert.verified_level !== undefined) {
    if (cert.claimed_level === cert.verified_level) {
      return `Verified at Level ${cert.verified_level} — matches the team's own rating`;
    }
    if (cert.claimed_level < cert.verified_level) {
      return `Verified at Level ${cert.verified_level} — the evidence supports more than the team's own rating (Level ${cert.claimed_level})`;
    }
  }
  return `Claimed Level ${cert.claimed_level} · ${verified}`;
};

/** "Basis: self-attested." — the confidence label, shown, never used as a gate. */
export const certificationBasisLine = (basis: CertificationBasis | null | undefined): string | null =>
  basis ? `Basis: ${basis}.` : null;

/** What a basis actually means, in words a reader outside the team can follow. */
export const certificationBasisMeaning = (
  basis: CertificationBasis | null | undefined,
): string | null => {
  switch ((basis || '').trim().toLowerCase()) {
    case 'self-attested':
      return 'That means it rests on what the team told us, and nothing more.';
    case 'documented':
      return 'That means the team also pointed us at something they had written down.';
    case 'verified':
      return 'That means we were able to look at the practice ourselves, not just read about it.';
    default:
      return null;
  }
};

const openClaimCount = (cert: TeamCertification): number => cert.claims_open ?? 0;

/** "Verified to Level 3 on 13 of 17 dimensions" — counts against target, never a scalar. */
export const teamCertificationHeadline = (
  cert: TeamCertification | null | undefined,
): string | null => {
  if (!cert) return null;
  if (cert.headline) return cert.headline;
  if (!cert.assessed) return 'Not yet assessed';
  if (cert.at_or_above_target >= 1) {
    return `Verified to Level ${cert.target_level} on ${cert.at_or_above_target} of ${cert.applicable} dimensions`;
  }
  const max = highestVerifiedLevel(cert);
  return max === null
    ? `Working toward Level ${cert.target_level}`
    : `Working toward Level ${cert.target_level} · verified up to Level ${max}`;
};

/** "Claims above verification on 12 dimensions — evidence requested" (+ coverage). */
export const teamCertificationSubline = (
  cert: TeamCertification | null | undefined,
  _dimensionsTotal?: number,
): string | null => {
  if (!cert) return null;
  if (cert.subline) return cert.subline;
  const parts: string[] = [];
  const open = openClaimCount(cert);
  if (open > 0) {
    parts.push(`Claims above verification on ${open} dimension${open === 1 ? '' : 's'} — evidence requested`);
  }
  const total = cert.applicable;
  if (cert.assessed < total) parts.push(`${cert.assessed} of ${total} dimensions assessed`);
  return parts.length > 0 ? parts.join(' · ') : null;
};

/** Table-cell form of the team aggregate: "L3 verified · 13/17". */
export const teamCertificationCellLabel = (
  cert: TeamCertification | null | undefined,
): string | null => {
  if (!cert || !cert.assessed) return null;
  if (cert.at_or_above_target > 0) {
    return `L${cert.target_level} verified · ${cert.at_or_above_target}/${cert.applicable}`;
  }
  return `Working toward Level ${cert.target_level}`;
};

/** Triage order: fewest dimensions at target first, open claims ahead of settled
 *  ones. Teams with no certification block sort last. */
export const certificationSortKey = (
  cert: TeamCertification | null | undefined,
): [number, number] => [
  cert ? cert.at_or_above_target : Number.MAX_SAFE_INTEGER,
  cert ? -openClaimCount(cert) : 1,
];

// ─── Teams ──────────────────────────────────────────────────────────────────

// ⚠️ No person ids on a team, deliberately. `assessment_teams`
// (schema/assessment_schema.sql) carries `assessment_lead TEXT` and
// `contributors JSONB {initials,name}[]` — there is no person column to send;
// all three assessment `app_users` carry `personId: null`; and PersonRef sets
// `linkable = session?.tenant === 'orgiq'`, so in this tenant it renders a
// plain name whatever id you hand it (its hover card reads /api/graph/people,
// which requireTenant('orgiq') 403s here). A lead is a name.
export interface TeamSummary {
  id: string;
  name: string;
  cohort: Cohort;
  cohort_label: string;
  status: string;
  assessment_lead: string;
  workflow_step: number;
  workflow_step_label: string;
  /** Same shape as `TeamDetail`'s six-step ladder, built server-side by the one function both wires share. Optional here (like `certification`/`contributors`) so hand-built test fixtures need not restate it. */
  workflow_steps?: WorkflowStep[];
  certification?: TeamCertification;
  dimensions_assessed: number;
  dimensions_total: number;
  followups_open: number;
  updated_at: string;
  contributors?: { initials: string; name: string; avatarUrl?: string | null }[];
}

export interface RepoRef {
  name: string;
  gitlab_url: string;
}

export interface TeamDetail {
  id: string;
  name: string;
  cohort: Cohort;
  cohort_label: string;
  status: string;
  assessment_lead: string;
  contacts: string[];
  repos: RepoRef[];
  workflow_step: number;
  workflow_step_label: string;
  certification?: TeamCertification;
  dimensions_assessed: number;
  dimensions_total: number;
  followups_open: number;
  updated_at: string;
}

export interface WorkflowStep {
  step: number;
  label: string;
  done: boolean;
  active: boolean;
}

export interface RubricLevel {
  level: number;
  name: string;
  description: string;
  key_characteristics: string[];
  level_up_criteria: string[];
  evidence_examples: string[];
}

export interface Provenance {
  provenance_id: string;
  source_uri: string;
  captured_by: string;
  captured_at: string;
}

/** The whole vocabulary an evidence row's `status` can hold: `PENDING` at
 *  intake, `CLASSIFIED` once it has been attached to a dimension, `SCORED`
 *  once it has informed a level. It is not an open string — the Aurora column
 *  carries `CHECK (status IN ('PENDING','CLASSIFIED','SCORED'))`
 *  (schema/assessment_schema.sql) and the mock provider writes only those
 *  three. */
export type EvidenceStatus = 'PENDING' | 'CLASSIFIED' | 'SCORED';

export interface Evidence {
  evidence_id: string;
  source_type: string;
  excerpt: string;
  /** null for ingested-but-unscored evidence. */
  supports_level: number | null;
  captured_at: string;
  source_ref: string;
  provenance: Provenance | null;
  /** true = informed a dimension's level; false = raw intake, awaiting scoring. */
  scored: boolean;
  status: EvidenceStatus;
}

export interface FollowUpQuestion {
  question_id: string;
  text: string;
  target_audience: string;
  status: string;
}

export interface CriteriaProgress {
  text: string;
  target_level: number;
  met: boolean;
  evidence_ids: string[];
}

export interface DimensionHistory {
  from_level: number | null;
  to_level: number | null;
  is_na: boolean;
  rationale: string;
  changed_at: string;
  changed_by: string;
  source_meeting: string;
}

export interface Dimension {
  id: string;
  title: string;
  definition: string;
  na_description: string;
  current_level: number | null;
  is_na: boolean;
  confidence: string;
  certification?: DimensionCertification;
  level_name: string | null;
  rubric_levels: RubricLevel[];
  next_level_criteria: string[];
  evidence: Evidence[];
  follow_up_questions: FollowUpQuestion[];
  criteria_progress: CriteriaProgress[];
  history: DimensionHistory[];
}

export interface TeamDetailResponse {
  team: TeamDetail;
  workflow_steps: WorkflowStep[];
  dimensions: Dimension[];
}

// ─── N/A exceptions ─────────────────────────────────────────────────────────
// A claimed N/A is never self-granting: archetype/known_exception rows are
// pre-approved and synthesized on read; submission/manual rows need a human
// Approve/Deny (lead-assessor / program-lead only — see docs/assessment-tenant.md).

export type ExceptionStatus = 'requested' | 'approved' | 'denied';
/**
 * All four are legal — `assessment_exceptions.source` in
 * schema/assessment_schema.sql carries
 * `CHECK (source IN ('archetype','known_exception','submission','manual'))`,
 * and the mock provider declares the same union.
 *
 * ⚠️ But only two of them are ever *produced* by this port: `archetype` (the
 * pre-approved rows synthesized on read from a team's archetype) and `manual`
 * (a scoring run asking for an N/A, which lands `requested` and waits for a
 * human Approve/Deny). Nothing here writes `known_exception` or `submission`.
 * Keep them in the union — the column accepts them and a source-app import
 * would carry them — but do not build UI that assumes they will appear.
 */
export type ExceptionSource = 'archetype' | 'known_exception' | 'submission' | 'manual';

export interface TeamException {
  dimension_id: string;
  status: ExceptionStatus;
  source: ExceptionSource;
  reason: string;
  approved_by: string;
  approved_at: string;
}

export interface ArchetypeOption {
  key: string;
  description: string;
}

export interface TeamExceptionsResponse {
  team_id: string;
  archetype: string | null;
  archetypes: ArchetypeOption[];
  exceptions: TeamException[];
}

// ─── Evidence intake / lineage ledger ───────────────────────────────────────

export type SourceType =
  | 'transcript'
  | 'document'
  | 'codebase'
  | 'teams_chat'
  | 'web'
  | 'survey'
  | 'screenshot'
  | 'touchpoint';

export interface IntakeItem {
  provenance_id: string;
  source_type: SourceType;
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
  items: IntakeItem[];
}

// ─── Level presentation ─────────────────────────────────────────────────────
// The source rendered L0..L5 as a rose→emerald CSS gradient. ui-components has
// no gradient-fill chip, so the level scale maps onto Chip's tone vocabulary
// instead — LevelBadge (./dashboard/LevelBadge.tsx) is a thin Chip wrapper
// around this map.

const LEVEL_TONES: ChipTone[] = ['danger', 'warning', 'caution', 'info', 'accent', 'success'];

export const levelTone = (level: number | null | undefined, isNa?: boolean): ChipTone => {
  if (isNa || level === null || level === undefined) return 'neutral';
  return LEVEL_TONES[Math.max(0, Math.min(5, level))];
};

export const levelBadgeLabel = (level: number | null | undefined, isNa?: boolean): string => {
  if (isNa) return '—';
  if (level === null || level === undefined) return '—';
  return `L${level}`;
};

// ─── Misc formatting helpers ────────────────────────────────────────────────

export const fmtDate = (iso: string | undefined | null): string => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
};
