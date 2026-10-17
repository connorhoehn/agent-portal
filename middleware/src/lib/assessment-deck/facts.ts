// The facts half of an assessment review deck (docs/assessment-deck-goal.md).
//
// Decision 3: numbers never come from the model. Every level, target,
// confidence, count, claim and recommendation kind on a slide is read here
// from `providers/assessment.ts` (`getTeamDeckSource` → the same
// `dimensionCertification` / `teamCertification` / `computeTeamPlan` the
// scorecard and plan render) and laid out into the vendored DeckSpec. The
// drafter writes only the PROSE part of a slide; `SlidePlan` records which
// part of each slide is facts and which is prose, so a model revision can be
// merged back without letting a fact drift (see narrative.ts `applyFacts`).
//
// Every slide cites a source: `assessment:<team>:<dimension>` for a dimension,
// the evidence id for an excerpt, and `assessment:<team>:all` for the
// team-wide rollup slides (the scorecard as a whole).

import {
  MAX_BULLETS_PER_SLIDE, MAX_BULLET_CHARS, MAX_SOURCES_PER_SLIDE, MAX_TITLE_CHARS,
  type DeckSlide, type DeckSource, type DeckSpec,
} from '@connorhoehn/realtime-modules/deck';
import {
  NARRATIVE_KINDS, clip, makePlan, slideFrame, slideWithProse,
  type DeckEvidence, type DeckFacts, type DeckSlideKind, type FactValue, type SlidePlan,
} from '../deck-shared/plan.js';
import type { TeamDeckSource, DimensionOut, Recommendation, RecommendationKind } from '../../providers/assessment.js';

export { NARRATIVE_KINDS, clip, makePlan, slideFrame, slideWithProse };
export type { DeckEvidence, DeckFacts, DeckSlideKind, FactValue, SlidePlan };

export interface DeckFactsOptions {
  /** The deck's own date (its creation), so re-applying facts later keeps it. */
  asOf: string;
  title?: string;
  audience?: string;
  /** Restrict the per-dimension slides and the chart to these ids. */
  dimensionIds?: string[];
}

const EXCERPT_FOR_AGENT_CHARS = 1200;
const AGENT_EVIDENCE_PER_DIMENSION = 6;
const AGENT_EVIDENCE_PER_SUMMARY = 12;
const EXCERPTS_ON_SLIDE = 3;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function listNames(label: string, names: string[]): string {
  if (!names.length) return `${label}: none`;
  let shown = 0;
  let text = `${label}: `;
  for (const name of names) {
    const candidate = shown ? `${text}, ${name}` : `${text}${name}`;
    const rest = names.length - shown - 1;
    if ((candidate + (rest ? ` and ${rest} more` : '')).length > MAX_BULLET_CHARS) break;
    text = candidate;
    shown += 1;
  }
  const rest = names.length - shown;
  return clip(rest ? `${text}${shown ? ' and' : ''} ${rest} more` : text);
}

/** Scored evidence, strongest first: supports_level desc (null last), then id — deterministic. */
function rankedEvidence(dim: DimensionOut): DimensionOut['evidence'] {
  return [...dim.evidence]
    .filter((e) => typeof e.excerpt === 'string' && e.excerpt.trim())
    .sort((a, b) => (b.supports_level ?? -1) - (a.supports_level ?? -1) || a.evidence_id.localeCompare(b.evidence_id));
}

const agentEvidence = (e: DimensionOut['evidence'][number]): DeckEvidence => ({
  id: e.evidence_id, excerpt: e.excerpt.slice(0, EXCERPT_FOR_AGENT_CHARS),
});

function teamSource(teamId: string, teamName: string): DeckSource {
  return { documentId: `assessment:${teamId}:all`, title: `${teamName} scorecard — all dimensions` };
}

function dimensionSource(teamId: string, dim: { id: string; title: string }): DeckSource {
  return { documentId: `assessment:${teamId}:${dim.id}`, title: clip(`Dimension ${dim.id} — ${dim.title}`, 160) };
}

function evidenceSource(e: DimensionOut['evidence'][number]): DeckSource {
  return { documentId: e.evidence_id, title: clip(`Evidence ${e.evidence_id} (${e.source_type})`, 160) };
}

/**
 * The whole deck as facts plus templated prose. Pure: same source and options,
 * same deck.
 */
export function buildDeckFacts(source: TeamDeckSource, options: DeckFactsOptions): DeckFacts {
  const { team, detail, plan, targetLevel } = source;
  const cert = detail.team.certification;
  const teamId = team.id;
  const allSource = teamSource(teamId, team.name);
  const date = options.asOf.slice(0, 10);

  const assessedAll = detail.dimensions.filter((d) => !d.is_na && d.certification.verified_level !== null);
  const wanted = options.dimensionIds?.length ? new Set(options.dimensionIds) : null;
  const assessed = wanted ? assessedAll.filter((d) => wanted.has(d.id)) : assessedAll;
  const notApplicable = detail.dimensions.filter((d) => d.is_na);
  const verifiedLevels = assessedAll.map((d) => d.certification.verified_level as number);
  const floorLevel = verifiedLevels.length ? Math.min(...verifiedLevels) : null;
  const summaryEvidence = assessedAll
    .map((d) => rankedEvidence(d)[0])
    .filter((e): e is DimensionOut['evidence'][number] => !!e)
    .slice(0, AGENT_EVIDENCE_PER_SUMMARY)
    .map(agentEvidence);

  const slides: SlidePlan[] = [];

  // 1. Title
  {
    const facts = { team: team.name, cohort: detail.team.cohort_label, date, rubricVersion: team.rubric_version };
    slides.push(makePlan({
      slideId: 'title', kind: 'title', facts, evidence: [], prose: 'none', maxProse: 0,
      factBullets: [`Cohort: ${facts.cohort}`, `Date: ${date}`, `Rubric version: ${facts.rubricVersion}`],
      templateProse: [],
      templateNotes: `Assessment review for ${team.name}, prepared from the assessment record on ${date}.`,
    }, { id: 'title', layout: 'title', title: clip(team.name, MAX_TITLE_CHARS), eyebrow: 'Assessment review', sources: [allSource] }));
  }

  // 2. Executive summary
  {
    const facts: Record<string, FactValue> = {
      targetLevel, verifiedAtTarget: cert.at_or_above_target, assessed: cert.assessed,
      applicable: cert.applicable, floorLevel: floorLevel ?? 'none', claimsOpen: cert.claims_open,
      headline: cert.headline,
    };
    const factBullets = [
      `${cert.at_or_above_target} of ${cert.assessed} assessed dimensions verified at or above the Level ${targetLevel} target`,
      floorLevel === null ? 'Floor: no dimension is verified yet' : `Floor: the lowest verified level is Level ${floorLevel}`,
      `Open claims: ${plural(cert.claims_open, 'dimension')} rated by the team above what is verified`,
    ];
    slides.push(makePlan({
      slideId: 'executive-summary', kind: 'executive-summary', facts, evidence: summaryEvidence,
      prose: 'bullets', maxProse: MAX_BULLETS_PER_SLIDE - factBullets.length, factBullets,
      templateProse: [clip(cert.headline)],
      ...(cert.subline ? { templateNotes: cert.subline } : {}),
    }, { id: 'executive-summary', layout: 'bullets', title: 'Executive summary', sources: [allSource] }));
  }

  // 3. Dimension overview chart
  if (assessed.length) {
    const facts: Record<string, FactValue> = { targetLevel, assessed: assessed.length };
    const caption = [`Verified level against the Level ${targetLevel} target for ${plural(assessed.length, 'assessed dimension')}`];
    slides.push(makePlan({
      slideId: 'overview', kind: 'overview', facts, evidence: [], prose: 'none', maxProse: 0,
      factBullets: caption, templateProse: [],
    }, {
      id: 'overview', layout: 'chart', title: 'Dimension overview', sources: [allSource],
      chart: {
        kind: 'bar',
        labels: assessed.map((d) => clip(d.title, 40)),
        series: [
          { name: 'Verified', values: assessed.map((d) => d.certification.verified_level as number) },
          { name: 'Target', values: assessed.map(() => targetLevel) },
        ],
      },
    }));
  }

  // 4. One slide per assessed dimension
  for (const dim of assessed) {
    const c = dim.certification;
    const score = source.dims[dim.id];
    const evidenceClass = score?.evidence_class ?? null;
    const openFollowUps = dim.follow_up_questions.filter((q) => q.status === 'OPEN');
    const ranked = rankedEvidence(dim);
    const facts: Record<string, FactValue> = {
      dimension: dim.title, verifiedLevel: c.verified_level as number, claimedLevel: c.claimed_level ?? 'none',
      targetLevel: c.target_level, meetsTarget: c.meets_target ? 'yes' : 'no', confidence: dim.confidence,
      evidenceClass: evidenceClass ?? 'not recorded', basis: c.basis, statement: c.statement,
      openFollowUps: openFollowUps.length,
    };
    const factColumn = [
      `Verified Level ${c.verified_level} · claimed ${c.claimed_level === null ? 'none' : `Level ${c.claimed_level}`} · target Level ${c.target_level}`,
      `Confidence: ${dim.confidence} · evidence class: ${facts.evidenceClass}`,
      clip(c.statement),
      ...dim.next_level_criteria.slice(0, 2).map((text) => clip(`Next level asks: ${text}`)),
      `Open follow-ups: ${openFollowUps.length}`,
      ...openFollowUps.slice(0, 1).map((q) => clip(`Follow-up: ${q.text}`)),
    ].slice(0, MAX_BULLETS_PER_SLIDE);
    const shown = ranked.slice(0, EXCERPTS_ON_SLIDE);
    const excerptBullets = shown.map((e) => clip(`“${e.excerpt.replace(/\s+/g, ' ').trim()}”`));
    const templateProse = [clip(c.to_verify_higher || (c.meets_target
      ? 'At or above target — sustain the practice and keep the evidence current.'
      : 'Not yet at target — see the next-level criteria.'))];
    const sources = [dimensionSource(teamId, dim), ...shown.map(evidenceSource)].slice(0, MAX_SOURCES_PER_SLIDE);
    slides.push(makePlan({
      slideId: `dim-${dim.id}`, kind: 'dimension', dimensionId: dim.id, facts,
      evidence: ranked.slice(0, AGENT_EVIDENCE_PER_DIMENSION).map(agentEvidence),
      prose: 'column', maxProse: Math.min(5, MAX_BULLETS_PER_SLIDE - excerptBullets.length),
      factBullets: [], factColumn, excerptBullets, templateProse, templateNotes: c.statement,
    }, { id: `dim-${dim.id}`, layout: 'two-column', title: clip(dim.title, MAX_TITLE_CHARS), eyebrow: `Dimension ${dim.id}`, sources }));
  }

  // 5. N/A dimensions with their approved exception reasons
  if (notApplicable.length) {
    const reasonFor = (id: string): string => team.exceptions.find((e) => e.dimension_id === id && e.status === 'approved')?.reason
      || 'approved exception (no reason recorded)';
    const lines = notApplicable.map((d) => clip(`${d.title}: ${reasonFor(d.id)}`));
    const factBullets = lines.length > MAX_BULLETS_PER_SLIDE
      ? [...lines.slice(0, MAX_BULLETS_PER_SLIDE - 1), `…and ${lines.length - (MAX_BULLETS_PER_SLIDE - 1)} more`]
      : lines;
    slides.push(makePlan({
      slideId: 'not-applicable', kind: 'not-applicable', facts: { notApplicable: notApplicable.length },
      evidence: [], prose: 'none', maxProse: 0, factBullets, templateProse: [],
    }, {
      id: 'not-applicable', layout: 'bullets', title: 'Not applicable dimensions',
      sources: notApplicable.map((d) => dimensionSource(teamId, d)).slice(0, MAX_SOURCES_PER_SLIDE),
    }));
  }

  // 6. Overall summary — strengths vs gaps
  {
    const strengths = assessedAll.filter((d) => d.certification.meets_target);
    const gaps = assessedAll.filter((d) => !d.certification.meets_target);
    const claims = assessedAll.filter((d) => d.certification.status === 'claim_open');
    const facts: Record<string, FactValue> = {
      targetLevel, strengths: strengths.length, gaps: gaps.length, claimsOpen: claims.length,
    };
    const factBullets = [
      listNames(`Strengths (at or above Level ${targetLevel})`, strengths.map((d) => d.title)),
      listNames(`Gaps (below Level ${targetLevel})`, gaps.map((d) => d.title)),
      listNames('Claims above verification', claims.map((d) => d.title)),
    ];
    slides.push(makePlan({
      slideId: 'overall-summary', kind: 'overall-summary', facts, evidence: summaryEvidence,
      prose: 'bullets', maxProse: MAX_BULLETS_PER_SLIDE - factBullets.length, factBullets,
      templateProse: [`${plural(strengths.length, 'strength')} and ${plural(gaps.length, 'gap')} against the Level ${targetLevel} target.`],
    }, { id: 'overall-summary', layout: 'bullets', title: 'Overall summary', sources: [allSource] }));
  }

  // 7. Recommendations grouped by kind
  const recs = plan.recommendations;
  {
    const LABEL: Record<RecommendationKind, string> = { close_claim: 'Close claims', advance: 'Advance', answer: 'Answer' };
    const byKind = (kind: RecommendationKind): Recommendation[] => recs.filter((r) => r.kind === kind);
    const factBullets = (['close_claim', 'advance', 'answer'] as const)
      .filter((kind) => byKind(kind).length)
      .map((kind) => listNames(`${LABEL[kind]} (${byKind(kind).length})`, byKind(kind).map((r) => r.title)));
    slides.push(makePlan({
      slideId: 'recommendations', kind: 'recommendations',
      facts: { closeClaim: plan.counts.close_claim, advance: plan.counts.advance, answer: plan.counts.answer },
      evidence: [], prose: 'none', maxProse: 0,
      factBullets: factBullets.length ? factBullets : ['No open recommendations — every applicable dimension is at or above target.'],
      templateProse: [],
    }, {
      id: 'recommendations', layout: 'bullets', title: 'Recommendations',
      sources: [allSource, ...recs.slice(0, MAX_SOURCES_PER_SLIDE - 1).map((r) => dimensionSource(teamId, { id: r.dimension_id, title: r.title }))],
    }));
  }

  // 8. Next steps — prose only
  {
    const templateProse = recs.slice(0, 3).map((r) => clip(`${r.title}: ${r.certification.to_verify_higher || r.rationale}`));
    slides.push(makePlan({
      slideId: 'next-steps', kind: 'next-steps',
      facts: { recommendations: recs.length, ...Object.fromEntries(templateProse.map((text, i) => [`step${i + 1}`, text])) },
      evidence: summaryEvidence,
      prose: 'bullets', maxProse: 5, factBullets: [],
      templateProse: templateProse.length ? templateProse : ['Sustain current practice and re-verify at the next assessment cycle.'],
    }, { id: 'next-steps', layout: 'bullets', title: 'Next steps', sources: [allSource] }));
  }

  const title = clip(options.title?.trim() || `${team.name} — assessment review`, MAX_TITLE_CHARS);
  const subtitle = clip(`${detail.team.cohort_label} · ${date}${options.audience?.trim() ? ` · for ${options.audience.trim()}` : ''}`, 200);
  return { teamId, slides, spec: { title, subtitle, theme: 'plain', slides: slides.map((s) => s.base) } };
}
