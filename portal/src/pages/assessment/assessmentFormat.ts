// Further pure derivations for the assessment dashboard — cohort grouping and
// filtering for the landing/list views, plus the improvement-plan and stories
// vocabulary (ported from the source's `components/recommendations/types.ts`
// and `components/stories/types.ts`). Nothing here is React; see
// `__tests__/assessmentFormat.test.ts`.

import {
  certificationSortKey,
  motionFor,
  type Cohort,
  type DimensionCertification,
  hasOpenClaim,
  type MotionConfig,
  type TeamSummary,
} from './types.ts';

// ─── Cohort landing ─────────────────────────────────────────────────────────

export interface CohortCard {
  motion: MotionConfig;
  teamCount: number;
  /** null when no team in this cohort carries a certification block yet. */
  targetLevel: number | null;
  certifiedCount: number;
}

/** One card per cohort — team counts + how many are verified at the cohort's
 *  target level. Certification data is entirely optional; a cohort with none
 *  of it yet just omits the "N verified" line. */
export function cohortCards(teams: TeamSummary[], motions: MotionConfig[]): CohortCard[] {
  return motions.map((motion) => {
    const cohortTeams = teams.filter((t) => t.cohort === motion.cohort);
    const certified = cohortTeams.filter((t) => (t.certification?.at_or_above_target ?? 0) > 0);
    const targetLevel = cohortTeams.find((t) => t.certification)?.certification?.target_level ?? null;
    return { motion, teamCount: cohortTeams.length, targetLevel, certifiedCount: certified.length };
  });
}

/** Client-side filter ahead of real semantic search — name / id / cohort. */
export function searchTeams(teams: TeamSummary[], query: string): TeamSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return teams;
  return teams.filter((t) => [t.id, t.name, t.cohort, t.cohort_label].some((f) => f?.toLowerCase().includes(q)));
}

/** Teams for a `?cohort=` value — "all" (or anything falsy) is every team. */
export function teamsForCohort(teams: TeamSummary[], cohort: Cohort | 'all' | null | undefined): TeamSummary[] {
  if (!cohort || cohort === 'all') return teams;
  return teams.filter((t) => t.cohort === cohort);
}

export function cohortTitle(cohort: Cohort | 'all'): string {
  return cohort === 'all' ? 'All teams' : motionFor(cohort).title;
}

// ─── Team list ──────────────────────────────────────────────────────────────

export interface TeamListSummary {
  count: number;
  certifiedCount: number;
  targetLevel: number | null;
  dimensionsAssessed: number;
  dimensionsTotal: number;
  followupsOpen: number;
}

export function summarizeTeamList(teams: TeamSummary[]): TeamListSummary {
  const dimensionsAssessed = teams.reduce((sum, t) => sum + t.dimensions_assessed, 0);
  const dimensionsTotal = teams.reduce((sum, t) => sum + t.dimensions_total, 0);
  const followupsOpen = teams.reduce((sum, t) => sum + t.followups_open, 0);
  const certified = teams.filter((t) => (t.certification?.at_or_above_target ?? 0) > 0);
  const targetLevel = teams.find((t) => t.certification)?.certification?.target_level ?? null;
  return {
    count: teams.length,
    certifiedCount: certified.length,
    targetLevel,
    dimensionsAssessed,
    dimensionsTotal,
    followupsOpen,
  };
}

export interface TeamListFilters {
  search: string;
  status: string | 'all';
}

/** Filter by name/id + status, then triage-sort once any team in the set
 *  carries certification data (fewest verified-at-target first, open claims
 *  ahead of settled ones) — otherwise the server's own order is left alone. */
export function filterAndSortTeams(teams: TeamSummary[], filters: TeamListFilters): TeamSummary[] {
  const q = filters.search.trim().toLowerCase();
  const rows = teams.filter((team) => {
    if (q && !team.name.toLowerCase().includes(q) && !team.id.toLowerCase().includes(q)) return false;
    if (filters.status !== 'all' && team.status !== filters.status) return false;
    return true;
  });
  if (!rows.some((t) => t.certification)) return rows;
  return [...rows].sort((a, b) => {
    const [aTarget, aOpen] = certificationSortKey(a.certification);
    const [bTarget, bOpen] = certificationSortKey(b.certification);
    return aTarget - bTarget || aOpen - bOpen;
  });
}

export function statusOptions(teams: TeamSummary[]): string[] {
  return Array.from(new Set(teams.map((t) => t.status).filter(Boolean))).sort();
}

const TEAM_STATUS_LABELS: Record<string, string> = {
  NEW: 'New',
  IN_PROGRESS: 'In progress',
  ASSESSED: 'Assessed',
};

/** "IN_PROGRESS" -> "In progress". The wire sends the raw enum constant
 *  (`routes/assessment.ts`'s `VALID_TEAM_STATUSES`); this is the one place
 *  it becomes a sentence a reader wasn't meant to parse as code. An unknown
 *  status still degrades to a humanized guess rather than a bare enum. */
export function formatTeamStatus(status: string): string {
  const known = TEAM_STATUS_LABELS[status];
  if (known) return known;
  const words = status.toLowerCase().split(/[_\s]+/).filter(Boolean);
  if (words.length === 0) return status;
  return [words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1), ...words.slice(1)].join(' ');
}

// ─── New team form ──────────────────────────────────────────────────────────

export interface NewTeamFormState {
  name: string;
  cohort: Cohort | '';
  assessment_lead: string;
}

export type NewTeamValidation =
  | { ok: true; value: { name: string; cohort: Cohort; assessment_lead?: string } }
  | { ok: false; error: string };

/** Mirrors `POST /teams`'s own validation (routes/assessment.ts) so the modal
 *  fails fast on an empty name or missing cohort instead of round-tripping an
 *  obvious 400. */
export function validateNewTeamForm(form: NewTeamFormState): NewTeamValidation {
  const name = form.name.trim();
  if (!name) return { ok: false, error: 'Name is required.' };
  if (!form.cohort) return { ok: false, error: 'Choose a cohort.' };
  const lead = form.assessment_lead.trim();
  return {
    ok: true,
    value: lead ? { name, cohort: form.cohort, assessment_lead: lead } : { name, cohort: form.cohort },
  };
}

// ─── Improvement plan vocabulary (ported from recommendations/types.ts) ────

export type RecommendationKind = 'close_claim' | 'advance' | 'answer';

export interface RecommendationStory {
  path: string;
  title: string;
  jira_key: string | null;
  status?: StoryStatus | null;
}

export interface Recommendation {
  dimension_id: string;
  dimension_title: string;
  kind: RecommendationKind;
  headline: string;
  verified_level: number | null;
  claimed_level: number | null;
  target_level: number;
  next_level: number | null;
  why: string;
  what_would_help: string[];
  level_up_criteria: string[];
  open_questions: string[];
  team_flagged_priority: boolean;
  rank: number;
  story_command: string;
  existing_stories: RecommendationStory[];
  certification?: DimensionCertification | null;
}

export interface RecommendationCounts {
  close_claim: number;
  advance: number;
  answer: number;
  sustain: number;
  not_applicable: number;
}

export interface RecommendationsResponse {
  team_id: string;
  target_level: number;
  counts: RecommendationCounts;
  summary: string;
  recommendations: Recommendation[];
  unlinked_stories: RecommendationStory[];
}

// ─── Wire shape → page model ────────────────────────────────────────────────
//
// The middleware speaks the source app's vocabulary (docs/assessment-tenant.md):
// `{dimension_id, title, kind, rank, rationale, story_command, certification,
// existing_stories[{filename,…}]}`. The page's model above is richer — it was
// written first, against a guessed shape, and every entry rendered as the
// default kind with a blank title until this mapping existed. The mapping is
// the ONE place the two meet; the page never reads the wire shape directly.

export interface ApiRecommendation {
  dimension_id: string;
  title: string;
  kind: string;
  rank: number | string;
  rationale: string;
  story_command: string;
  // `to_verify_higher` is on DimensionCertification itself (types.ts) — the
  // server sends it now, so this no longer needs to widen the type to admit a
  // field nobody was sending.
  certification?: DimensionCertification | null;
  existing_stories?: Array<{ filename: string; title?: string; jira_key?: string | null; status?: StoryStatus | null }>;
}

export interface ApiRecommendationsResponse {
  team_id: string;
  generated_at?: string;
  target_level: number;
  counts: Partial<RecommendationCounts> & Record<string, number>;
  recommendations: ApiRecommendation[];
}

const KINDS: readonly RecommendationKind[] = ['close_claim', 'advance', 'answer'];

/**
 * The bare evidence ask, with the server's "To verify higher: " lead-in and
 * trailing period taken off — `[]` when there is nothing above this dimension
 * to reach (N/A, nothing verified yet, already at Level 5), which is exactly
 * when the server sends an empty string.
 */
export function verificationAsk(cert: DimensionCertification | null | undefined): string[] {
  const raw = cert?.to_verify_higher?.trim();
  if (!raw) return [];
  const bare = raw.replace(/^To verify higher:\s*/i, '').replace(/\.+$/, '').trim();
  return bare ? [bare] : [];
}

export function normalizeRecommendation(r: ApiRecommendation, targetLevel: number): Recommendation {
  const cert = r.certification ?? null;
  const verified = cert?.verified_level ?? null;
  const kind: RecommendationKind = (KINDS as readonly string[]).includes(r.kind) ? (r.kind as RecommendationKind) : 'answer';
  return {
    dimension_id: r.dimension_id,
    dimension_title: r.title,
    kind,
    // The rationale is the headline. The certification statement ("Claimed
    // Level 5 · Verified up to Level 2") is NOT repeated here — the card
    // already renders it beside the level chip, and once it read twice.
    headline: r.rationale,
    verified_level: verified,
    claimed_level: cert?.claimed_level ?? null,
    target_level: cert?.target_level ?? targetLevel,
    next_level: verified != null && verified < (cert?.target_level ?? targetLevel) ? verified + 1 : null,
    // Nothing further to say beyond the headline; the card hides an empty why.
    why: '',
    // The server sends this as a whole sentence, "To verify higher: <ask>." —
    // and the card it lands on already has the heading "What would let us
    // confirm it", so the prefix would read twice. Same strip as
    // DimensionMasterDetail's, which renders the ask into its own sentence.
    what_would_help: verificationAsk(cert),
    level_up_criteria: [],
    open_questions: [],
    team_flagged_priority: false,
    rank: typeof r.rank === 'number' ? r.rank : Number.parseInt(String(r.rank), 10) || 0,
    story_command: r.story_command,
    existing_stories: (r.existing_stories ?? []).map((st) => ({
      path: st.filename, title: st.title ?? st.filename, jira_key: st.jira_key ?? null, status: st.status ?? null,
    })),
    certification: cert,
  };
}

export function normalizePlan(api: ApiRecommendationsResponse): RecommendationsResponse {
  const counts: RecommendationCounts = {
    close_claim: api.counts.close_claim ?? 0,
    advance: api.counts.advance ?? 0,
    answer: api.counts.answer ?? 0,
    sustain: api.counts.sustain ?? 0,
    not_applicable: api.counts.not_applicable ?? 0,
  };
  return {
    team_id: api.team_id,
    target_level: api.target_level,
    counts,
    // The page composes its own sentence from the counts; a second one here
    // rendered as a duplicate paragraph.
    summary: '',
    recommendations: api.recommendations.map((r) => normalizeRecommendation(r, api.target_level)),
    unlinked_stories: [],
  };
}

export interface KindMeta {
  label: string;
  meaning: string;
  chipTone: 'warning' | 'info' | 'neutral';
  countPhrase: string;
}

/** Each kind gets its own word and its own tone — deliberately not the app's
 *  accent, which carries no meaning of its own here. */
export const KIND_META: Record<RecommendationKind, KindMeta> = {
  close_claim: {
    label: 'Evidence requested',
    meaning:
      "The team already describes this as the way they work. Nothing about the practice has to change — we simply have not been able to see it for ourselves yet.",
    chipTone: 'warning',
    countPhrase: 'where the team already describes the practice and we have asked to see it',
  },
  advance: {
    label: 'Practice to build',
    meaning:
      'This way of working is not in place yet, so this entry is real engineering work rather than a matter of sharing something that already exists.',
    chipTone: 'info',
    countPhrase: 'where the practice is not yet in place',
  },
  answer: {
    label: 'Question to answer',
    meaning: 'We do not yet have enough to go on to say anything about this dimension. Answering the questions below is what would let us start.',
    chipTone: 'neutral',
    countPhrase: 'we have not been able to assess yet',
  },
};

/** Never render a raw kind key — an unknown one reads as the neutral one. */
export const kindMeta = (kind: string): KindMeta =>
  Object.hasOwn(KIND_META, kind) ? KIND_META[kind as RecommendationKind] : KIND_META.answer;

export const certificationFor = (rec: Recommendation): DimensionCertification | null => rec.certification ?? null;

const countNoun = (n: number, singular: string, plural: string): string => `${n} ${n === 1 ? singular : plural}`;

const joinList = (parts: string[]): string => {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
};

/** The counts, said as a sentence a reader could say out loud — never a row of figures. */
export const countsSentence = (
  counts: RecommendationCounts | null | undefined,
  targetLevel: number,
): string | null => {
  if (!counts) return null;
  const dims = (n: number) => countNoun(n, 'dimension', 'dimensions');
  const parts: string[] = [];
  if (counts.close_claim > 0) parts.push(`${dims(counts.close_claim)} ${KIND_META.close_claim.countPhrase}`);
  if (counts.advance > 0) parts.push(`${dims(counts.advance)} ${KIND_META.advance.countPhrase}`);
  if (counts.answer > 0) parts.push(`${dims(counts.answer)} ${KIND_META.answer.countPhrase}`);
  if (counts.sustain > 0) parts.push(`${dims(counts.sustain)} already verified at or above Level ${targetLevel}`);
  if (counts.not_applicable > 0) parts.push(`${dims(counts.not_applicable)} recorded as not applicable to this team`);
  if (parts.length === 0) return null;
  return `This team's scorecard has ${joinList(parts)}.`;
};

export const countsTotal = (counts: RecommendationCounts | null | undefined): number => {
  if (!counts) return 0;
  return (
    counts.close_claim + counts.advance + counts.answer + counts.sustain + counts.not_applicable
  );
};

export interface PlanEmptyState {
  title: string;
  body: string;
}

/** Which honest empty state applies, if any — never render a plan over no data. */
export const emptyStateFor = (data: RecommendationsResponse): PlanEmptyState | null => {
  if ((data.recommendations ?? []).length > 0) return null;
  const counts = data.counts;
  const total = countsTotal(counts);

  if (total === 0) {
    return {
      title: 'Nothing to plan from yet',
      body: 'No dimension on this team\'s scorecard has been assessed, so there is nothing here to recommend. Once evidence has been read and the dimensions have been assessed, this page will say what would move each one forward.',
    };
  }
  if (counts && counts.not_applicable === total) {
    return {
      title: 'Every dimension is recorded as not applicable',
      body: "Each dimension on this team's scorecard is covered by an approved exception, so there is no improvement work to describe. If any of those exceptions no longer fits how the team works, say so and the dimension can be assessed instead.",
    };
  }
  if (counts && counts.sustain > 0) {
    return {
      title: `Every dimension we could assess is already at or above Level ${data.target_level}`,
      body: 'There is nothing we would ask this team to change right now. The work from here is keeping these practices in place, and keeping the evidence current enough that the next baseline can confirm them again.',
    };
  }
  return {
    title: 'No recommendations on file',
    body: 'The assessment has not produced any improvement entries for this team yet. That is not the same as saying there is nothing to do — it means the plan has not been generated from the current evidence.',
  };
};

/** The plan in the order the server ranked it. */
export const orderedRecommendations = (data: RecommendationsResponse): Recommendation[] =>
  [...(data.recommendations ?? [])].sort((a, b) =>
    a.rank !== b.rank ? a.rank - b.rank : Number(a.dimension_id) - Number(b.dimension_id),
  );

export interface PlanGroups {
  /** Entries with something to do — evidence to share, or a practice to build. */
  actionable: Recommendation[];
  /** Dimensions we have not been able to assess at all yet. */
  unassessed: Recommendation[];
}

/** Split for layout only — nothing is dropped or re-ranked. A long unassessed
 *  tail would otherwise bury the one or two entries someone can act on. */
export const groupPlan = (recommendations: Recommendation[]): PlanGroups => ({
  actionable: recommendations.filter((rec) => rec.kind !== 'answer'),
  unassessed: recommendations.filter((rec) => rec.kind === 'answer'),
});

export const unassessedGroupHeading = (count: number): string =>
  `${countNoun(count, 'dimension has', 'dimensions have')} not been assessed yet`;

// ─── Stories vocabulary (ported from stories/types.ts) ─────────────────────

export type StoryStatus = 'pushed' | 'blocked' | 'ready';

/**
 * The deterministic push verb for a drafted story — the source app's fifth
 * handoff verb, run by a person from the repo root. Composed here from the
 * team and file rather than read off the API, which carries neither a command
 * nor a path: a story is `workspace/teams/<team>/stories/<file>` by construction.
 */
export function storyPath(teamId: string, filename: string): string {
  return `workspace/teams/${teamId}/stories/${filename}`;
}

export function pushCommandFor(teamId: string, filename: string): string {
  return `uv run -m sdlcd.main jira push-story --team ${teamId} --file ${storyPath(teamId, filename)}`;
}

export interface Story {
  path: string;
  filename: string;
  title: string;
  dimension_id: string | null;
  dimension_title: string | null;
  jira_key: string | null;
  status: StoryStatus;
  needs_input: string[];
  needs_input_count: number;
  created_at: string | null;
  push_command: string;
}

export interface StoriesResponse {
  team_id: string;
  count: number;
  stories: Story[];
}

export interface StatusMeta {
  label: string;
  meaning: string;
  chipTone: 'success' | 'warning' | 'info';
}

/** Three states, told apart in words — never by colour alone. "Blocked" means
 *  a question is still open in the file, never a judgement on the team. */
export const STATUS_META: Record<StoryStatus, StatusMeta> = {
  pushed: {
    label: 'In Jira',
    meaning: 'This story has been pushed and carries its Jira key. Track it from there.',
    chipTone: 'success',
  },
  blocked: {
    label: 'Question open',
    meaning: 'Something in this story is still marked as needing input, so the push would refuse until it is filled in.',
    chipTone: 'warning',
  },
  ready: {
    label: 'Ready to push',
    meaning: 'Nothing is left open in this story, so the push command shown against it would create the issue.',
    chipTone: 'info',
  },
};

export const statusMeta = (status: string): StatusMeta =>
  (STATUS_META as Record<string, StatusMeta>)[status] ?? STATUS_META.blocked;

/** "Dimension 6 · Delivery Automation", or null when the story names no dimension. */
export const dimensionLabel = (story: Story): string | null => {
  if (!story.dimension_id) return null;
  return story.dimension_title ? `Dimension ${story.dimension_id} · ${story.dimension_title}` : `Dimension ${story.dimension_id}`;
};

/** What is unresolved in a blocked story, said as a sentence. */
export const needsInputSentence = (story: Story): string => {
  const ids = story.needs_input ?? [];
  const total = story.needs_input_count || ids.length;
  const items = total === 1 ? 'one item' : `${total} items`;
  if (ids.length === 0) return `This story has ${items} still marked as needing input. Open it to see what they are.`;
  const named = ids.join(', ');
  const unnamed = total - ids.length;
  return unnamed > 0
    ? `Open in this story: ${named}, plus ${unnamed} more marked as needing input without a question id.`
    : `Open in this story: ${named}.`;
};

// ─── Dimension follow-ups ───────────────────────────────────────────────────

/** The API returns FollowUpQuestion.status verbatim ("OPEN" | "ANSWERED" |
 *  "DROPPED") — compare case-insensitively so an open one isn't rendered
 *  resolved. */
export const isOpenFollowUp = (status: string): boolean => {
  const s = status.trim().toLowerCase();
  return s === 'open' || s === 'pending';
};

export function countOpenFollowUps(questions: { status: string }[]): number {
  return questions.filter((q) => isOpenFollowUp(q.status)).length;
}

/**
 * What a FormField's render-prop wiring may be spread onto an `<Input>`.
 * The library hands `labelId` along for controls that take `aria-labelledby`;
 * spreading it onto a DOM input makes React warn "does not recognize the
 * `labelId` prop" on every load of the page. Keep the id + aria wiring, drop
 * the label id.
 */
export function inputWiring<W extends { labelId: string }>(wiring: W): Omit<W, 'labelId'> {
  const { labelId: _labelId, ...rest } = wiring;
  void _labelId;
  return rest;
}

// ─── The assessor's desk: what moves each team next ─────────────────────────

export type NextActionKind = 'intake' | 'assess' | 'close_claims' | 'answer' | 'publish' | 'follow_up';

export interface NextAction {
  kind: NextActionKind;
  /** Short imperative, e.g. "Close 3 claims". */
  label: string;
}

/**
 * The one thing that moves a team, computed from the same counts the row
 * shows — never re-derived by an agent, never a level promise
 * (docs/assessment-tenant.md, "Recommendations are computed"). Order of
 * precedence: nothing assessed yet → start intake; claims above verification
 * → close them (evidence asks are the cheapest step); open questions →
 * answer them; dimensions left → assess them; then the ladder's own step.
 */
export function nextActionFor(team: TeamSummary): NextAction {
  const cert = team.certification;
  const claims = cert?.claims_open ?? 0;
  if (!cert || cert.assessed === 0) {
    return team.dimensions_assessed > 0
      ? { kind: 'assess', label: `Assess ${team.dimensions_total - team.dimensions_assessed} more` }
      : { kind: 'intake', label: 'Start intake' };
  }
  if (claims > 0) return { kind: 'close_claims', label: `Close ${claims} claim${claims === 1 ? '' : 's'}` };
  if (team.followups_open > 0) {
    return { kind: 'answer', label: `Answer ${team.followups_open} question${team.followups_open === 1 ? '' : 's'}` };
  }
  const left = team.dimensions_total - team.dimensions_assessed;
  if (left > 0) return { kind: 'assess', label: `Assess ${left} more` };
  if (team.workflow_step < 5) return { kind: 'publish', label: 'Review and publish' };
  if (team.workflow_step === 5) return { kind: 'publish', label: 'Publish' };
  return { kind: 'follow_up', label: 'Follow up' };
}

export interface DeskSummary {
  teams: number;
  verifiedAtTarget: number;
  targetLevel: number | null;
  claimsOpen: number;
  questionsOpen: number;
}

/** The four numbers above the desk, summed from the rows it shows. */
export function deskSummary(teams: TeamSummary[]): DeskSummary {
  const base = summarizeTeamList(teams);
  return {
    teams: base.count,
    verifiedAtTarget: base.certifiedCount,
    targetLevel: base.targetLevel,
    claimsOpen: teams.reduce((sum, t) => sum + (t.certification?.claims_open ?? 0), 0),
    questionsOpen: base.followupsOpen,
  };
}

// ─── Evidence coverage + rail tracks (docs/assessment-ux-goal.md slice 4) ───

/** The slice of a Dimension these helpers read — kept narrow so a test can
 *  hand in a literal. */
export interface DimensionTrackInput {
  is_na: boolean;
  current_level: number | null;
  confidence?: string;
  certification?: DimensionCertification | null;
}

/** The evidence class a dimension's verified level rests on. The server's
 *  `basis` IS the class in its wire spelling ('self-attested' | 'documented' |
 *  'verified'); the two extra keys cover a dimension with nothing to class. */
export type EvidenceClassKey = 'attested' | 'documented' | 'observed' | 'na' | 'unassessed';

export const evidenceClassOf = (dimension: DimensionTrackInput): EvidenceClassKey => {
  if (dimension.is_na) return 'na';
  // A pending dimension still arrives with basis 'self-attested' (the
  // provider's confidence floor) — but nothing has been assessed, so there is
  // no evidence to class yet. Unassessed, not attested.
  if (dimension.current_level == null && dimension.certification?.verified_level == null) return 'unassessed';
  const basis = (dimension.certification?.basis ?? '').trim().toLowerCase();
  if (basis === 'verified' || basis === 'observed') return 'observed';
  if (basis === 'documented') return 'documented';
  if (basis === 'self-attested' || basis === 'attested') return 'attested';
  return dimension.current_level == null ? 'unassessed' : 'attested';
};

export const evidenceCoverage = (dimensions: DimensionTrackInput[]): Record<EvidenceClassKey, number> => {
  const counts: Record<EvidenceClassKey, number> = { attested: 0, documented: 0, observed: 0, na: 0, unassessed: 0 };
  for (const d of dimensions) counts[evidenceClassOf(d)] += 1;
  return counts;
};

/** The scorer's confidence vocabulary (low / moderate / high) as a fraction
 *  of three dots; anything unrecognised shows as an empty meter rather than a
 *  guessed one. */
export const CONFIDENCE_VALUE: Record<string, number> = { low: 1 / 3, moderate: 2 / 3, high: 1 };

export const confidenceValue = (confidence: string): number =>
  CONFIDENCE_VALUE[confidence.trim().toLowerCase()] ?? 0;

/** What a rail row's data attributes say: 'na' for a not-applicable
 *  dimension, the level as a string, '' when there is nothing on that track. */
export const railTracks = (dimension: DimensionTrackInput): { claimed: string; verified: string; claimOpen: boolean } => {
  const cert = dimension.certification;
  const verifiedLevel = cert?.verified_level ?? dimension.current_level;
  return {
    claimed: cert?.claimed_level == null ? '' : String(cert.claimed_level),
    verified: dimension.is_na ? 'na' : verifiedLevel == null ? '' : String(verifiedLevel),
    claimOpen: cert ? hasOpenClaim(cert) : false,
  };
};
