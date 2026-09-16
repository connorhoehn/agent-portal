// Run with:  cd portal && node --test 'src/pages/assessment/__tests__/*.test.ts'
//
// Plain node:test — both types.ts and assessmentFormat.ts are pure TypeScript
// (no DOM, no fetch), so Node's type-stripping loader runs them directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  certificationBasisLine,
  certificationBasisMeaning,
  certificationSortKey,
  dimensionCertificationStatement,
  fmtDate,
  hasOpenClaim,
  highestVerifiedLevel,
  levelBadgeLabel,
  levelTone,
  motionFor,
  teamCertificationCellLabel,
  teamCertificationHeadline,
  teamCertificationSubline,
  type DimensionCertification,
  type TeamCertification,
  type TeamSummary,
} from '../types.ts';
import {
  cohortCards,
  countOpenFollowUps,
  countsSentence,
  countsTotal,
  dimensionLabel,
  emptyStateFor,
  filterAndSortTeams,
  groupPlan,
  isOpenFollowUp,
  kindMeta,
  needsInputSentence,
  orderedRecommendations,
  searchTeams,
  statusMeta,
  statusOptions,
  summarizeTeamList,
  teamsForCohort,
  unassessedGroupHeading,
  type Recommendation,
  type RecommendationsResponse,
  type Story,
} from '../assessmentFormat.ts';
import { MOTIONS } from '../types.ts';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function team(partial: Partial<TeamSummary> & { id: string }): TeamSummary {
  return {
    name: partial.id,
    cohort: 'general',
    cohort_label: 'Assessment Factory',
    // NEW / IN_PROGRESS / ASSESSED is the wire enum — the same one
    // `formatTeamStatus` is tested against further down this file. The
    // fixtures here used to run on invented `active` / `paused` statuses.
    status: 'ASSESSED',
    assessment_lead: 'Lead',
    workflow_step: 1,
    workflow_step_label: 'Intake',
    dimensions_assessed: 0,
    dimensions_total: 17,
    followups_open: 0,
    updated_at: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

function cert(partial: Partial<TeamCertification>): TeamCertification {
  // `below_target` / `above_target` are required on the wire (the server
  // counts both on every rollup), so the fixture states them; `...partial`
  // still lets a case override either.
  const base: TeamCertification = {
    target_level: 3, at_or_above_target: 0, below_target: 0, above_target: 0,
    assessed: 0, applicable: 17,
  };
  const merged = { ...base, ...partial };
  // Keep the identity the server guarantees — at_or_above + below === assessed
  // — unless the case pinned `below_target` itself.
  if (partial.below_target === undefined) merged.below_target = merged.assessed - merged.at_or_above_target;
  return merged;
}

function dimCert(partial: Partial<DimensionCertification>): DimensionCertification {
  return { verified_level: null, claimed_level: null, ...partial };
}

// ─── Certification helpers (types.ts) ───────────────────────────────────────

test('highestVerifiedLevel reads either server spelling, preferring highest_verified_level', () => {
  assert.equal(highestVerifiedLevel(cert({ highest_verified_level: 2, max_verified_level: 4 })), 2);
  assert.equal(highestVerifiedLevel(cert({ max_verified_level: 4 })), 4);
  assert.equal(highestVerifiedLevel(cert({})), null);
  assert.equal(highestVerifiedLevel(null), null);
});

test('hasOpenClaim: explicit status wins, then verification_gap, then a level comparison', () => {
  assert.equal(hasOpenClaim(dimCert({ status: 'claim_open' })), true);
  assert.equal(hasOpenClaim(dimCert({ verification_gap: 2 })), true);
  assert.equal(hasOpenClaim(dimCert({ verification_gap: 0 })), false);
  assert.equal(hasOpenClaim(dimCert({ claimed_level: 4, verified_level: null })), true);
  assert.equal(hasOpenClaim(dimCert({ claimed_level: 3, verified_level: 3 })), false);
  assert.equal(hasOpenClaim(dimCert({ claimed_level: 4, verified_level: 2 })), true);
  assert.equal(hasOpenClaim(dimCert({ claimed_level: null })), false);
  assert.equal(hasOpenClaim(null), false);
});

test('dimensionCertificationStatement never awards one number', () => {
  assert.equal(
    dimensionCertificationStatement(dimCert({ claimed_level: null, verified_level: null })),
    'Not yet verified · no claim on file',
  );
  assert.equal(
    dimensionCertificationStatement(dimCert({ claimed_level: 5, verified_level: 2 })),
    'Claimed Level 5 · Verified up to Level 2',
  );
  assert.equal(
    dimensionCertificationStatement(dimCert({ claimed_level: 3, verified_level: 3 })),
    "Verified at Level 3 — matches the team's own rating",
  );
  assert.equal(
    dimensionCertificationStatement(dimCert({ claimed_level: 1, verified_level: 3 })),
    "Verified at Level 3 — the evidence supports more than the team's own rating (Level 1)",
  );
  // Server-rendered statement always wins.
  assert.equal(dimensionCertificationStatement(dimCert({ statement: 'from server' })), 'from server');
});

test('certificationBasisLine/Meaning are shown, never used as a gate', () => {
  assert.equal(certificationBasisLine('documented'), 'Basis: documented.');
  assert.equal(certificationBasisLine(null), null);
  assert.match(certificationBasisMeaning('self-attested') ?? '', /what the team told us/);
  assert.equal(certificationBasisMeaning('unknown-basis'), null);
});

test('teamCertificationHeadline: not yet assessed, working toward, or verified — never a scalar', () => {
  assert.equal(teamCertificationHeadline(null), null);
  assert.equal(teamCertificationHeadline(cert({ assessed: 0 })), 'Not yet assessed');
  assert.equal(
    teamCertificationHeadline(cert({ assessed: 5, at_or_above_target: 0, max_verified_level: 2 })),
    'Working toward Level 3 · verified up to Level 2',
  );
  assert.equal(
    teamCertificationHeadline(cert({ assessed: 13, at_or_above_target: 13, applicable: 17 })),
    'Verified to Level 3 on 13 of 17 dimensions',
  );
});

test('teamCertificationSubline reports open claims and partial coverage', () => {
  assert.equal(
    teamCertificationSubline(cert({ assessed: 10, applicable: 17, claims_open: 3 }), 17),
    'Claims above verification on 3 dimensions — evidence requested · 10 of 17 dimensions assessed',
  );
  assert.equal(teamCertificationSubline(cert({ assessed: 17, applicable: 17 }), 17), null);
});

test('teamCertificationCellLabel is the compact table form', () => {
  assert.equal(teamCertificationCellLabel(cert({ assessed: 0 })), null);
  assert.equal(
    teamCertificationCellLabel(cert({ assessed: 13, at_or_above_target: 13, applicable: 17, target_level: 3 })),
    'L3 verified · 13/17',
  );
  assert.equal(teamCertificationCellLabel(cert({ assessed: 5, at_or_above_target: 0, target_level: 3 })), 'Working toward Level 3');
});

test('certificationSortKey triages fewest-at-target first, then open claims first', () => {
  const a = certificationSortKey(cert({ at_or_above_target: 0, claims_open: 2 }));
  const b = certificationSortKey(cert({ at_or_above_target: 5, claims_open: 0 }));
  assert.ok(a[0] < b[0]);
  assert.deepEqual(certificationSortKey(null), [Number.MAX_SAFE_INTEGER, 1]);
});

test('levelTone maps L0..L5 onto Chip tones and N/A onto neutral', () => {
  assert.equal(levelTone(0), 'danger');
  assert.equal(levelTone(5), 'success');
  assert.equal(levelTone(null), 'neutral');
  assert.equal(levelTone(2, true), 'neutral');
});

test('levelBadgeLabel', () => {
  assert.equal(levelBadgeLabel(3), 'L3');
  assert.equal(levelBadgeLabel(null), '—');
  assert.equal(levelBadgeLabel(3, true), '—');
});

test('fmtDate falls back to the raw string on an unparseable date', () => {
  assert.equal(fmtDate(null), '—');
  // Noon UTC so a negative-offset local timezone can't roll the date back a day.
  assert.equal(fmtDate('2026-03-01T12:00:00Z'), 'Mar 1, 2026');
});

test('motionFor falls back to the factory motion for an unknown cohort', () => {
  assert.equal(motionFor('general').title, 'Assessment Factory');
  assert.equal(MOTIONS.length, 3);
});

// ─── Cohort landing / team list (assessmentFormat.ts) ──────────────────────

test('cohortCards counts teams and certified teams per motion', () => {
  const teams = [
    team({ id: 'TEAM-001', cohort: 'white_glove' }),
    team({ id: 'TEAM-002', cohort: 'white_glove', certification: cert({ at_or_above_target: 1, target_level: 3 }) }),
    team({ id: 'TEAM-003', cohort: 'general' }),
  ];
  const cards = cohortCards(teams, MOTIONS);
  const whiteGlove = cards.find((c) => c.motion.cohort === 'white_glove')!;
  assert.equal(whiteGlove.teamCount, 2);
  assert.equal(whiteGlove.certifiedCount, 1);
  assert.equal(whiteGlove.targetLevel, 3);
  const general = cards.find((c) => c.motion.cohort === 'general')!;
  assert.equal(general.targetLevel, null);
});

test('searchTeams matches id, name and cohort case-insensitively', () => {
  const teams = [team({ id: 'TEAM-001', name: 'Payments Core' }), team({ id: 'TEAM-002', name: 'Checkout' })];
  assert.deepEqual(searchTeams(teams, 'payments').map((t) => t.id), ['TEAM-001']);
  assert.deepEqual(searchTeams(teams, ''), teams);
});

test('teamsForCohort: "all" and falsy both mean everything', () => {
  const teams = [team({ id: 'TEAM-001', cohort: 'general' }), team({ id: 'TEAM-002', cohort: 'white_glove' })];
  assert.equal(teamsForCohort(teams, 'general').length, 1);
  assert.equal(teamsForCohort(teams, 'all').length, 2);
  assert.equal(teamsForCohort(teams, null).length, 2);
});

test('summarizeTeamList rolls up dimensions and follow-ups across the filtered set', () => {
  const teams = [
    team({ id: 'A', dimensions_assessed: 10, dimensions_total: 17, followups_open: 2 }),
    team({ id: 'B', dimensions_assessed: 17, dimensions_total: 17, followups_open: 0, certification: cert({ at_or_above_target: 17, target_level: 3 }) }),
  ];
  const s = summarizeTeamList(teams);
  assert.equal(s.count, 2);
  assert.equal(s.dimensionsAssessed, 27);
  assert.equal(s.dimensionsTotal, 34);
  assert.equal(s.followupsOpen, 2);
  assert.equal(s.certifiedCount, 1);
  assert.equal(s.targetLevel, 3);
});

test('filterAndSortTeams filters by search + status and triage-sorts once certification exists', () => {
  const teams = [
    team({ id: 'A', name: 'Alpha', status: 'ASSESSED', certification: cert({ at_or_above_target: 5, claims_open: 0 }) }),
    team({ id: 'B', name: 'Beta', status: 'ASSESSED', certification: cert({ at_or_above_target: 0, claims_open: 2 }) }),
    team({ id: 'C', name: 'Gamma', status: 'NEW' }),
  ];
  const active = filterAndSortTeams(teams, { search: '', status: 'ASSESSED' });
  assert.deepEqual(active.map((t) => t.id), ['B', 'A']); // fewest at target first
  const searched = filterAndSortTeams(teams, { search: 'gamma', status: 'all' });
  assert.deepEqual(searched.map((t) => t.id), ['C']);
});

test('statusOptions is the deduped, sorted set of statuses present', () => {
  const teams = [team({ id: 'A', status: 'ASSESSED' }), team({ id: 'B', status: 'NEW' }), team({ id: 'C', status: 'ASSESSED' })];
  assert.deepEqual(statusOptions(teams), ['ASSESSED', 'NEW']);
});

// ─── Improvement plan ────────────────────────────────────────────────────────

function rec(partial: Partial<Recommendation> & { dimension_id: string; kind: Recommendation['kind'] }): Recommendation {
  return {
    dimension_title: `Dimension ${partial.dimension_id}`,
    headline: 'Headline',
    verified_level: null,
    claimed_level: null,
    target_level: 3,
    next_level: null,
    why: 'Why',
    what_would_help: [],
    level_up_criteria: [],
    open_questions: [],
    team_flagged_priority: false,
    rank: 1,
    story_command: '/develop-jira-story',
    existing_stories: [],
    ...partial,
  };
}

test('kindMeta never lets a raw or unknown kind key reach the screen', () => {
  assert.equal(kindMeta('advance').label, 'Practice to build');
  assert.equal(kindMeta('__proto__').label, 'Question to answer');
  assert.equal(kindMeta('constructor').label, 'Question to answer');
});

test('orderedRecommendations sorts by rank then numeric dimension id', () => {
  const data: RecommendationsResponse = {
    team_id: 'TEAM-001',
    target_level: 3,
    counts: { close_claim: 0, advance: 0, answer: 0, sustain: 0, not_applicable: 0 },
    summary: '',
    recommendations: [
      rec({ dimension_id: '10', kind: 'advance', rank: 1 }),
      rec({ dimension_id: '2', kind: 'advance', rank: 1 }),
      rec({ dimension_id: '5', kind: 'advance', rank: 0 }),
    ],
    unlinked_stories: [],
  };
  assert.deepEqual(orderedRecommendations(data).map((r) => r.dimension_id), ['5', '2', '10']);
});

test('groupPlan separates the unassessed tail without dropping or re-ranking', () => {
  const recs = [
    rec({ dimension_id: '1', kind: 'close_claim' }),
    rec({ dimension_id: '2', kind: 'answer' }),
    rec({ dimension_id: '3', kind: 'advance' }),
  ];
  const { actionable, unassessed } = groupPlan(recs);
  assert.deepEqual(actionable.map((r) => r.dimension_id), ['1', '3']);
  assert.deepEqual(unassessed.map((r) => r.dimension_id), ['2']);
});

test('unassessedGroupHeading pluralizes correctly', () => {
  assert.equal(unassessedGroupHeading(1), '1 dimension has not been assessed yet');
  assert.equal(unassessedGroupHeading(3), '3 dimensions have not been assessed yet');
});

test('countsSentence reads like a sentence and joins with "and"', () => {
  const s = countsSentence(
    { close_claim: 1, advance: 2, answer: 0, sustain: 3, not_applicable: 0 },
    3,
  );
  assert.match(s ?? '', /^This team's scorecard has /);
  assert.match(s ?? '', / and /);
});

test('countsSentence is null with no counts at all', () => {
  assert.equal(countsSentence(null, 3), null);
  assert.equal(countsSentence({ close_claim: 0, advance: 0, answer: 0, sustain: 0, not_applicable: 0 }, 3), null);
});

test('countsTotal sums every bucket', () => {
  assert.equal(countsTotal({ close_claim: 1, advance: 2, answer: 3, sustain: 4, not_applicable: 5 }), 15);
  assert.equal(countsTotal(null), 0);
});

test('emptyStateFor picks the honest empty state, and returns null once there are recommendations', () => {
  const base: RecommendationsResponse = {
    team_id: 'T', target_level: 3, summary: '', recommendations: [], unlinked_stories: [],
    counts: { close_claim: 0, advance: 0, answer: 0, sustain: 0, not_applicable: 0 },
  };
  assert.match(emptyStateFor(base)!.title, /Nothing to plan from yet/);

  const allNa = { ...base, counts: { ...base.counts, not_applicable: 17 } };
  assert.match(emptyStateFor(allNa)!.title, /not applicable/);

  const allSustain = { ...base, counts: { ...base.counts, sustain: 17 } };
  assert.match(emptyStateFor(allSustain)!.title, /already at or above Level 3/);

  const withRecs = { ...base, recommendations: [rec({ dimension_id: '1', kind: 'advance' })] };
  assert.equal(emptyStateFor(withRecs), null);
});

// ─── Stories ──────────────────────────────────────────────────────────────

function story(partial: Partial<Story> & { status: Story['status'] }): Story {
  return {
    path: `teams/T/stories/${partial.status}.md`,
    filename: `${partial.status}.md`,
    title: 'A story',
    dimension_id: null,
    dimension_title: null,
    jira_key: null,
    needs_input: [],
    needs_input_count: 0,
    created_at: null,
    push_command: 'jira push-story',
    ...partial,
  };
}

test('statusMeta reads an unknown status as the cautious "blocked" state', () => {
  assert.equal(statusMeta('ready').label, 'Ready to push');
  assert.equal(statusMeta('bogus').label, 'Question open');
});

test('dimensionLabel is null when the story names no dimension', () => {
  assert.equal(dimensionLabel(story({ status: 'ready' })), null);
  assert.equal(
    dimensionLabel(story({ status: 'ready', dimension_id: '6', dimension_title: 'Delivery Automation' })),
    'Dimension 6 · Delivery Automation',
  );
});

test('needsInputSentence names the open ids and counts unnamed markers', () => {
  const s = story({ status: 'blocked', needs_input: ['Q-1', 'Q-2'], needs_input_count: 3 });
  assert.match(needsInputSentence(s), /Q-1, Q-2/);
  assert.match(needsInputSentence(s), /plus 1 more/);
});

// ─── Follow-ups ──────────────────────────────────────────────────────────────

test('isOpenFollowUp compares case-insensitively against the uppercase API values', () => {
  assert.equal(isOpenFollowUp('OPEN'), true);
  assert.equal(isOpenFollowUp('open'), true);
  assert.equal(isOpenFollowUp('ANSWERED'), false);
  assert.equal(isOpenFollowUp('DROPPED'), false);
});

test('countOpenFollowUps counts only the open ones', () => {
  assert.equal(countOpenFollowUps([{ status: 'OPEN' }, { status: 'ANSWERED' }, { status: 'open' }]), 2);
});

// ─── Wire shape → page model ─────────────────────────────────────────────────

import { normalizePlan, normalizeRecommendation } from '../assessmentFormat.ts';

const API_ENTRY = {
  dimension_id: '1', title: 'Continuous Integration (CI)', kind: 'close_claim', rank: '2',
  rationale: 'The team rates itself above what the evidence reaches.',
  story_command: '/develop-jira-story team: TEAM-001 dimension: 1',
  certification: { verified_level: 2, claimed_level: 5, verification_gap: 3, basis: 'self-attested',
    status: 'claim_open', target_level: 3, meets_target: false, statement: 'Claimed Level 5 · Verified up to Level 2',
    // Verbatim from GET /api/assessment/recommendations — the server sends a
    // whole sentence with a "To verify higher: " lead-in and a full stop.
    to_verify_higher: 'To verify higher: consistent practice at Level 3 (Defined).' },
  existing_stories: [{ filename: 'story-dim1.md', team_id: 'TEAM-001', dimension_id: '1', jira_key: null, status: 'ready' as const }],
};

test('normalizeRecommendation maps the contract onto the page model', () => {
  const rec = normalizeRecommendation(API_ENTRY, 3);
  assert.equal(rec.kind, 'close_claim');
  assert.equal(rec.dimension_title, 'Continuous Integration (CI)');
  // rank arrives as a string from some fixtures; the page sorts on a number
  assert.equal(rec.rank, 2);
  assert.equal(rec.verified_level, 2);
  assert.equal(rec.claimed_level, 5);
  assert.equal(rec.target_level, 3);
  assert.equal(rec.next_level, 3);
  // Stripped of the server's lead-in: the card it lands on is already headed
  // "What would let us confirm it", so the prefix would read twice.
  assert.deepEqual(rec.what_would_help, ['consistent practice at Level 3 (Defined)']);
  assert.equal(rec.existing_stories[0]!.path, 'story-dim1.md');
});

// The bug this closes: the portal read `cert.to_verify_higher` on both the
// scorecard and the improvement plan, and no middleware source file named the
// field — so `what_would_help` was permanently `[]` and "To confirm a higher
// level, we would need …" never rendered. `verification_gap`, the other
// candidate, is a NUMBER (claimed − verified); reading it here would have
// produced "we would need 3."
test('what_would_help is empty exactly when the server has nothing to ask for', () => {
  const noAsk = { ...API_ENTRY, certification: { ...API_ENTRY.certification, to_verify_higher: '' } };
  assert.deepEqual(normalizeRecommendation(noAsk, 3).what_would_help, []);

  const { to_verify_higher: _omitted, ...certWithout } = API_ENTRY.certification;
  const missing = { ...API_ENTRY, certification: certWithout };
  assert.deepEqual(normalizeRecommendation(missing, 3).what_would_help, []);

  // A gap number is not an ask, and must never be dressed up as one.
  const gapOnly = { ...API_ENTRY, certification: { ...certWithout, verification_gap: 3 } };
  assert.deepEqual(normalizeRecommendation(gapOnly, 3).what_would_help, []);
});

test('the headline is the rationale, not the certification statement', () => {
  // The card already renders the statement beside the level chip; putting it
  // in the headline too made every card say the same sentence twice.
  const rec = normalizeRecommendation(API_ENTRY, 3);
  assert.equal(rec.headline, API_ENTRY.rationale);
  assert.notEqual(rec.headline, API_ENTRY.certification.statement);
  assert.equal(rec.why, '');
});

test('an unknown kind falls back to "answer" rather than crashing the plan', () => {
  const rec = normalizeRecommendation({ ...API_ENTRY, kind: 'sustain' }, 3);
  assert.equal(rec.kind, 'answer');
});

test('normalizePlan fills every count and leaves the summary to the page', () => {
  const plan = normalizePlan({ team_id: 'TEAM-001', target_level: 3, counts: { close_claim: 6, sustain: 9 }, recommendations: [API_ENTRY] });
  assert.deepEqual(plan.counts, { close_claim: 6, advance: 0, answer: 0, sustain: 9, not_applicable: 0 });
  assert.equal(plan.summary, '');
  assert.equal(plan.recommendations.length, 1);
});

// ─── Story push command ──────────────────────────────────────────────────────

import { pushCommandFor, storyPath } from '../assessmentFormat.ts';

test('the push command is composed from team + file, in the source verb form', () => {
  assert.equal(storyPath('TEAM-001', 'story-dim1.md'), 'workspace/teams/TEAM-001/stories/story-dim1.md');
  assert.equal(
    pushCommandFor('TEAM-001', 'story-dim1.md'),
    'uv run -m sdlcd.main jira push-story --team TEAM-001 --file workspace/teams/TEAM-001/stories/story-dim1.md',
  );
});

// ─── Team status labels ──────────────────────────────────────────────────────

import { formatTeamStatus, validateNewTeamForm } from '../assessmentFormat.ts';

test('formatTeamStatus humanizes the known wire enum', () => {
  assert.equal(formatTeamStatus('NEW'), 'New');
  assert.equal(formatTeamStatus('IN_PROGRESS'), 'In progress');
  assert.equal(formatTeamStatus('ASSESSED'), 'Assessed');
});

test('formatTeamStatus degrades an unknown status to a humanized guess, never a bare enum', () => {
  assert.equal(formatTeamStatus('ON_HOLD'), 'On hold');
  assert.equal(formatTeamStatus('archived'), 'Archived');
});

// ─── New team form validation ────────────────────────────────────────────────

test('validateNewTeamForm requires a name and a cohort', () => {
  const noName = validateNewTeamForm({ name: '  ', cohort: 'general', assessment_lead: '' });
  assert.equal(noName.ok, false);
  if (!noName.ok) assert.match(noName.error, /name/i);

  const noCohort = validateNewTeamForm({ name: 'Checkout', cohort: '', assessment_lead: '' });
  assert.equal(noCohort.ok, false);
  if (!noCohort.ok) assert.match(noCohort.error, /cohort/i);
});

test('validateNewTeamForm trims the name and omits an empty lead', () => {
  const result = validateNewTeamForm({ name: '  Checkout Experience  ', cohort: 'self_service', assessment_lead: '  ' });
  assert.deepEqual(result, { ok: true, value: { name: 'Checkout Experience', cohort: 'self_service' } });
});

test('validateNewTeamForm trims and includes a non-empty lead', () => {
  const result = validateNewTeamForm({ name: 'Checkout', cohort: 'general', assessment_lead: '  Dana Ko  ' });
  assert.deepEqual(result, { ok: true, value: { name: 'Checkout', cohort: 'general', assessment_lead: 'Dana Ko' } });
});
