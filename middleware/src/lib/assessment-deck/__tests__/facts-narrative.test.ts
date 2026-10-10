// Review-deck facts and narrative merge (docs/assessment-deck-goal.md
// decision 3): one slide per assessed dimension, every number equal to the
// provider's, every slide citing a source; a non-verbatim span keeps the
// template; a revise cannot move a fact, a locked slide, or a slide outside
// its scope.

jest.mock('../../../config.js', () => ({ config: { mock: { aurora: true, agentcore: true }, auth: {} } }));

import * as M from '../../../mock/assessment.js';
import { dimensionCertification, getTeamDeckSource, teamCertification, type TeamDeckSource } from '../../../providers/assessment.js';
import { validateDeckSpec, type DeckSpec } from '@connorhoehnslalom/realtime-modules/deck';
import { buildDeckFacts, type DeckFacts } from '../facts.js';
import { acceptNarrative, buildDraftInput, buildReviseInput, mergeDraft, mergeRevise, mockDraftResult, mockReviseResult } from '../narrative.js';

const TEAM = 'TEAM-001';
let source: TeamDeckSource;
let facts: DeckFacts;

beforeAll(async () => {
  source = (await getTeamDeckSource(TEAM))!;
  facts = buildDeckFacts(source, { asOf: '2026-10-05T12:00:00.000Z' });
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('facts', () => {
  it('has exactly one slide per assessed dimension, and none for the rest', () => {
    const scores = M.scoresFor(TEAM)!;
    const assessed = M.DIMENSION_IDS.filter((id) => scores[id] && !scores[id]!.is_na && scores[id]!.current_level !== null);
    expect(assessed.length).toBeGreaterThan(0);
    const dimSlides = facts.spec.slides.filter((s) => s.id.startsWith('dim-')).map((s) => s.id);
    expect(dimSlides).toEqual(assessed.map((id) => `dim-${id}`));
    expect(validateDeckSpec(facts.spec).ok).toBe(true);
  });

  it('every number equals the provider value', () => {
    const scores = M.scoresFor(TEAM)!;
    const target = M.configuration().target_level;
    const team = teamCertification(Object.values(scores), target);
    const exec = facts.slides.find((s) => s.slideId === 'executive-summary')!;
    expect(exec.facts).toMatchObject({
      targetLevel: target, verifiedAtTarget: team.at_or_above_target, assessed: team.assessed,
      applicable: team.applicable, claimsOpen: team.claims_open,
    });
    const levels = Object.values(scores).filter((d) => !d.is_na && d.current_level !== null).map((d) => d.current_level as number);
    expect(exec.facts['floorLevel']).toBe(Math.min(...levels));
    expect(exec.base.bullets![0]).toBe(`${team.at_or_above_target} of ${team.assessed} assessed dimensions verified at or above the Level ${target} target`);

    const chart = facts.spec.slides.find((s) => s.id === 'overview')!.chart!;
    for (const plan of facts.slides.filter((s) => s.kind === 'dimension')) {
      const score = scores[plan.dimensionId!]!;
      const cert = dimensionCertification(score, target);
      expect(plan.facts).toMatchObject({
        verifiedLevel: cert.verified_level, claimedLevel: cert.claimed_level ?? 'none', targetLevel: cert.target_level,
        confidence: score.confidence, evidenceClass: score.evidence_class ?? 'not recorded', statement: cert.statement,
        openFollowUps: score.follow_up_questions.filter((q) => q.status === 'OPEN').length,
      });
      const line = plan.base.columns![0][0]!;
      expect(line).toBe(`Verified Level ${cert.verified_level} · claimed ${cert.claimed_level === null ? 'none' : `Level ${cert.claimed_level}`} · target Level ${target}`);
      const index = facts.slides.filter((s) => s.kind === 'dimension').indexOf(plan);
      expect(chart.series[0]!.values[index]).toBe(cert.verified_level);
      expect(chart.series[1]!.values[index]).toBe(target);
      // Excerpts on the slide are the scored evidence, verbatim (clipped only at the cap).
      for (const [i, bullet] of (plan.excerptBullets ?? []).entries()) {
        const excerpt = plan.evidence[i]!.excerpt.replace(/\s+/g, ' ').trim();
        expect(excerpt.startsWith(bullet.replace(/^“/, '').replace(/(”|…)$/, ''))).toBe(true);
      }
    }
    const recs = facts.slides.find((s) => s.slideId === 'recommendations')!;
    expect(recs.facts).toEqual({ closeClaim: source.plan.counts.close_claim, advance: source.plan.counts.advance, answer: source.plan.counts.answer });
  });

  it('every slide cites a source: the team, a dimension, or an evidence id', () => {
    const evidenceIds = new Set(Object.values(M.scoresFor(TEAM)!).flatMap((d) => d.evidence.map((e) => e.evidence_id)));
    for (const slide of facts.spec.slides) {
      expect(slide.sources.length).toBeGreaterThan(0);
      for (const s of slide.sources) {
        expect(s.documentId.startsWith(`assessment:${TEAM}:`) || evidenceIds.has(s.documentId)).toBe(true);
      }
    }
    for (const plan of facts.slides.filter((s) => s.kind === 'dimension')) {
      expect(plan.base.sources[0]!.documentId).toBe(`assessment:${TEAM}:${plan.dimensionId}`);
    }
  });

  it('lists N/A dimensions with their approved exception reasons', () => {
    const na = source.detail.dimensions.filter((d) => d.is_na);
    const slide = facts.spec.slides.find((s) => s.id === 'not-applicable');
    if (!na.length) { expect(slide).toBeUndefined(); return; }
    expect(slide!.bullets).toHaveLength(na.length);
    for (const d of na) {
      const reason = source.team.exceptions.find((e) => e.dimension_id === d.id && e.status === 'approved')?.reason;
      if (reason) expect(slide!.bullets!.some((b) => b.startsWith(`${d.title}: ${reason.slice(0, 20)}`))).toBe(true);
    }
  });
});

describe('narrative merge', () => {
  const dimPlan = () => facts.slides.find((s) => s.kind === 'dimension' && s.evidence.length > 0)!;

  it('uses a narrative whose spans are verbatim', () => {
    const plan = dimPlan();
    const e = plan.evidence[0]!;
    const ok = acceptNarrative({ slideId: plan.slideId, bullets: ['The evidence shows a working practice.'],
      source_spans: [{ evidenceId: e.id, text: e.excerpt.slice(0, 30) }] }, plan);
    expect(ok?.bullets).toEqual(['The evidence shows a working practice.']);
  });

  it('falls back to the template when a span is not verbatim', () => {
    const plan = dimPlan();
    const e = plan.evidence[0]!;
    const result = {
      summary: 'drafted',
      narratives: [{ slideId: plan.slideId, bullets: ['Invented claim.'], source_spans: [{ evidenceId: e.id, text: `${e.excerpt.slice(0, 20)} NOT IN THE EXCERPT` }] }],
    };
    const merged = mergeDraft(facts, result);
    expect(merged.templated).toContain(plan.slideId);
    expect(merged.spec.slides.find((s) => s.id === plan.slideId)).toEqual(plan.base);
  });

  it('falls back on a span citing another slide\'s evidence, an ungrounded number, or an agent fallback', () => {
    const plan = dimPlan();
    const e = plan.evidence[0]!;
    expect(acceptNarrative({ slideId: plan.slideId, bullets: ['x'], source_spans: [{ evidenceId: 'EV-elsewhere', text: e.excerpt.slice(0, 10) }] }, plan)).toBeNull();
    expect(acceptNarrative({ slideId: plan.slideId, bullets: ['Verified at Level 97.'], source_spans: [{ evidenceId: e.id, text: e.excerpt.slice(0, 10) }] }, plan)).toBeNull();
    expect(acceptNarrative({ slideId: plan.slideId, bullets: ['No spans.'], source_spans: [] }, plan)).toBeNull();
    const merged = mergeDraft(facts, { narratives: [{ slideId: plan.slideId, bullets: ['fine'], source_spans: [{ evidenceId: e.id, text: e.excerpt.slice(0, 10) }] }], fallbackSlideIds: [plan.slideId] });
    expect(merged.templated).toContain(plan.slideId);
  });

  it('the offline drafter obeys the contract, and its narratives are used', () => {
    const input = buildDraftInput(facts);
    expect(input.teamId).toBe(TEAM);
    expect(input.slides.every((s) => ['executive-summary', 'dimension', 'overall-summary', 'next-steps'].includes(s.kind))).toBe(true);
    const result = mockDraftResult(input, facts) as { narratives: Array<{ slideId: string; source_spans: Array<{ evidenceId: string; text: string }> }> };
    for (const n of result.narratives) {
      const slide = input.slides.find((s) => s.slideId === n.slideId)!;
      for (const span of n.source_spans) expect(slide.evidence.find((e) => e.id === span.evidenceId)!.excerpt.includes(span.text)).toBe(true);
    }
    const merged = mergeDraft(facts, result);
    expect(validateDeckSpec(merged.spec).ok).toBe(true);
    expect(merged.templated).toEqual([]);
    // Facts are untouched by the narrative.
    for (const plan of facts.slides) {
      const slide = merged.spec.slides.find((s) => s.id === plan.slideId)!;
      if (plan.prose === 'column') expect(slide.columns![0]).toEqual(plan.factColumn);
      if (plan.prose === 'bullets') expect(slide.bullets!.slice(0, plan.factBullets.length)).toEqual(plan.factBullets);
      if (plan.base.chart) expect(slide.chart).toEqual(plan.base.chart);
    }
  });
});

describe('revise merge', () => {
  let base: DeckSpec;
  beforeAll(() => { base = mergeDraft(facts, mockDraftResult(buildDraftInput(facts), facts)).spec; });

  it('re-applies facts: a tampered number, chart or source is restored', () => {
    const plan = facts.slides.find((s) => s.kind === 'dimension')!;
    const revised = clone(base);
    const slide = revised.slides.find((s) => s.id === plan.slideId)!;
    slide.columns![0][0] = 'Verified Level 5 · claimed Level 5 · target Level 1';
    slide.columns![1].push('A new reviewer sentence.');
    slide.sources = [{ documentId: 'made-up', title: 'Made up' }];
    revised.slides.find((s) => s.id === 'overview')!.chart!.series[0]!.values[0] = 5;
    const merged = mergeRevise(base, { summary: 'Added a sentence.', spec: revised, changedSlideIds: [plan.slideId], source_spans: [] }, facts, { instruction: 'add a sentence' });
    expect(merged.ok && merged.changed).toBe(true);
    if (!merged.ok || !merged.changed) return;
    const after = merged.spec.slides.find((s) => s.id === plan.slideId)!;
    expect(after.columns![0]).toEqual(plan.factColumn);
    expect(after.columns![1]).toContain('A new reviewer sentence.');
    expect(after.sources).toEqual(plan.base.sources);
    expect(merged.spec.slides.find((s) => s.id === 'overview')!.chart).toEqual(facts.spec.slides.find((s) => s.id === 'overview')!.chart);
    expect(merged.changedSlideIds).toEqual([plan.slideId]);
  });

  it('keeps locked slides and slides outside the requested slideId', () => {
    const revised = clone(base);
    for (const s of revised.slides) s.notes = 'Changed everywhere.';
    const locked = mergeRevise(base, { summary: 's', spec: revised }, facts, { instruction: 'rewrite notes', locked: ['executive-summary'] });
    expect(locked.ok && locked.changed && locked.spec.slides.find((s) => s.id === 'executive-summary')).toEqual(base.slides.find((s) => s.id === 'executive-summary'));
    const scoped = mergeRevise(base, { summary: 's', spec: revised }, facts, { instruction: 'rewrite notes', slideId: 'next-steps' });
    expect(scoped.ok && scoped.changed && scoped.changedSlideIds).toEqual(['next-steps']);
  });

  it('treats a refused edit as no change, and refuses a reordered deck or an unmet constraint', () => {
    expect(mergeRevise(base, { fallback: true, spec: base, summary: 'No change was made.' }, facts, { instruction: 'x' }))
      .toEqual({ ok: true, changed: false, summary: 'No change was made.' });
    const reordered = clone(base); reordered.slides.reverse();
    expect(mergeRevise(base, { spec: reordered }, facts, { instruction: 'x' }).ok).toBe(false);
    const longer = clone(base);
    longer.slides.find((s) => s.id === 'next-steps')!.title = 'Next steps and much more to do';
    const result = mergeRevise(base, { summary: 'Shortened.', spec: longer }, facts, { instruction: 'make the title shorter', slideId: 'next-steps' });
    expect(result.ok).toBe(false);
  });

  it('the offline reviser shortens a title as asked and passes the constraint check', () => {
    const input = buildReviseInput(base, facts, 'make the title shorter', 'executive-summary');
    expect(Object.keys(input.facts)).toEqual(facts.slides.map((s) => s.slideId));
    const merged = mergeRevise(base, mockReviseResult(input, facts), facts, { instruction: input.instruction, slideId: 'executive-summary' });
    expect(merged.ok && merged.changed && merged.spec.slides.find((s) => s.id === 'executive-summary')!.title).toBe('Executive');
  });

  it.each(['Tighten the bullets', 'make it more concise', 'shorter please'])('the offline reviser never grows a dimension slide for "%s"', (instruction) => {
    for (const id of facts.slides.filter((s) => s.kind === 'dimension').map((s) => s.slideId)) {
      const input = buildReviseInput(base, facts, instruction, id);
      const merged = mergeRevise(base, mockReviseResult(input, facts), facts, { instruction, slideId: id });
      expect({ id, ok: merged.ok }).toEqual({ id, ok: true });
    }
  });
});
