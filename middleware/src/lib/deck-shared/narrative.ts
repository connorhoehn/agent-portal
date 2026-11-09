// The prose half of an assessment review deck, and the rules that keep it
// honest (docs/assessment-deck-goal.md decision 3).
//
// Drafter contract (agents/assessment-drafter, DECK_MODES — agree exactly):
//
//   draft-review-deck  in:  { teamId, slides: [{ slideId, kind, dimensionId?, facts, evidence: [{ id, excerpt }] }] }
//                      out: { summary, narratives: [{ slideId, bullets, notes?, source_spans: [{ evidenceId, text }] }],
//                             fallbackSlideIds?, draft: true, published: false }
//   revise-review-deck in:  { spec, instruction, slideId?, facts: { [slideId]: Record<string, string|number> },
//                             evidence: [{ id, excerpt }] }
//                      out: { summary, spec, changedSlideIds, source_spans, draft: true, published: false }
//                           — or { fallback: true, spec: <original>, summary } for a refused edit (no change).
//
// Merge rules enforced HERE, whatever the agent already checked:
//   - a narrative is used only if it has at least one span and every
//     source_span.text is a verbatim substring of THAT evidence id's excerpt
//     as this slide sent it; it also may state no number absent from the
//     slide's facts or evidence, and must fit the slide's caps. Otherwise the
//     templated prose stays.
//   - after a revise, facts are re-applied (layout, sources, chart, fact
//     bullets, fact column, excerpts) so no number can drift; locked slides
//     and slides outside the requested slideId keep the base revision's slide.

import {
  MAX_BULLET_CHARS, MAX_NOTES_CHARS, validateDeckSpec,
  type DeckSlide, type DeckSpec,
} from '@connorhoehn/realtime-modules/deck';
import { checkConstraints, parseConstraints } from '@connorhoehn/realtime-modules/deck';
import { NARRATIVE_KINDS, clip, slideWithProse, type DeckEvidence, type DeckFacts, type FactValue, type SlidePlan } from './plan.js';

export interface SourceSpan { evidenceId: string; text: string }
export interface DeckNarrative { slideId: string; bullets: string[]; notes?: string; source_spans: SourceSpan[] }

export interface DraftDeckInput {
  teamId: string;
  /**
   * An initiative deck's brief (G55, lib/initiative-deck/brief.ts): the
   * requester's words, quoted as data, and the sprint window they selected.
   * It steers which period and theme the prose covers; it is never a fact.
   */
  brief?: { words: string; window: { sprintId: string; name: string; startsOn: string | null; endsOn: string | null; status: string; which: string } | null };
  slides: Array<{ slideId: string; kind: string; dimensionId?: string; facts: Record<string, FactValue>; evidence: DeckEvidence[] }>;
}

export interface ReviseDeckInput {
  spec: DeckSpec;
  instruction: string;
  slideId?: string;
  facts: Record<string, Record<string, FactValue>>;
  evidence: DeckEvidence[];
}

export function buildDraftInput(facts: DeckFacts): DraftDeckInput {
  return {
    teamId: facts.teamId,
    slides: facts.slides.filter((s) => NARRATIVE_KINDS.has(s.kind)).map((s) => ({
      slideId: s.slideId, kind: s.kind, ...(s.dimensionId ? { dimensionId: s.dimensionId } : {}),
      facts: s.facts, evidence: s.evidence,
    })),
  };
}

export function buildReviseInput(spec: DeckSpec, facts: DeckFacts, instruction: string, slideId?: string): ReviseDeckInput {
  const scoped = slideId ? facts.slides.filter((s) => s.slideId === slideId) : facts.slides;
  const seen = new Set<string>();
  const evidence: DeckEvidence[] = [];
  for (const plan of scoped) {
    for (const e of plan.evidence) if (!seen.has(e.id)) { seen.add(e.id); evidence.push(e); }
  }
  return {
    spec, instruction, ...(slideId ? { slideId } : {}),
    facts: Object.fromEntries(facts.slides.map((s) => [s.slideId, s.facts])),
    evidence,
  };
}

const NUMBER = /\d+(?:\.\d+)?/g;

/** Key-order-insensitive JSON, so "changed" means a value changed. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const sameSlide = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

/** Every number in `text` appears somewhere in `allowed`. */
function numbersGrounded(text: string, allowed: string): boolean {
  return (text.match(NUMBER) ?? []).every((n) => allowed.includes(n));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Whether a narrative may replace a slide's template prose. Returns the
 * cleaned narrative, or null with the template kept.
 */
export function acceptNarrative(raw: unknown, plan: SlidePlan): DeckNarrative | null {
  if (!isRecord(raw) || raw['slideId'] !== plan.slideId) return null;
  const bullets = raw['bullets'];
  if (!Array.isArray(bullets) || bullets.length === 0 || bullets.length > plan.maxProse) return null;
  if (bullets.some((b) => typeof b !== 'string' || !b.trim() || b.replace(/\s+/g, ' ').trim().length > MAX_BULLET_CHARS)) return null;
  const notes = raw['notes'];
  if (notes !== undefined && (typeof notes !== 'string' || notes.length > MAX_NOTES_CHARS)) return null;
  const spans = raw['source_spans'];
  if (!Array.isArray(spans) || spans.length === 0) return null;
  const excerpts = new Map(plan.evidence.map((e) => [e.id, e.excerpt]));
  for (const span of spans) {
    if (!isRecord(span) || typeof span['evidenceId'] !== 'string' || typeof span['text'] !== 'string' || !span['text']) return null;
    const excerpt = excerpts.get(span['evidenceId']);
    if (excerpt === undefined || !excerpt.includes(span['text'])) return null;
  }
  const allowed = `${JSON.stringify(plan.facts)} ${plan.evidence.map((e) => e.excerpt).join(' ')}`;
  if (!numbersGrounded(`${(bullets as string[]).join(' ')} ${typeof notes === 'string' ? notes : ''}`, allowed)) return null;
  return {
    slideId: plan.slideId,
    bullets: (bullets as string[]).map((b) => b.replace(/\s+/g, ' ').trim()),
    ...(typeof notes === 'string' && notes.trim() ? { notes: notes.trim() } : {}),
    source_spans: (spans as Array<Record<string, string>>).map((s) => ({ evidenceId: s['evidenceId']!, text: s['text']! })),
  };
}

export interface DraftMerge {
  spec: DeckSpec;
  /** Slides whose narrative was refused (or missing) and kept the template. */
  templated: string[];
  summary: string;
}

/**
 * Puts the drafter's narratives onto the facts deck. `locked` slides keep the
 * slide from `previous` (a regeneration over an existing deck).
 */
export function mergeDraft(facts: DeckFacts, result: unknown, opts: { previous?: DeckSpec; locked?: string[] } = {}): DraftMerge {
  const value = isRecord(result) ? result : {};
  const narratives = Array.isArray(value['narratives']) ? value['narratives'] : [];
  const agentFallbacks = new Set(Array.isArray(value['fallbackSlideIds']) ? value['fallbackSlideIds'].filter((x): x is string => typeof x === 'string') : []);
  const locked = new Set(opts.locked ?? []);
  const templated: string[] = [];
  const slides = facts.slides.map((plan) => {
    if (locked.has(plan.slideId)) {
      const kept = opts.previous?.slides.find((s) => s.id === plan.slideId);
      if (kept) return kept;
    }
    if (plan.prose === 'none') return plan.base;
    const raw = narratives.find((n) => isRecord(n) && n['slideId'] === plan.slideId);
    const accepted = agentFallbacks.has(plan.slideId) ? null : acceptNarrative(raw, plan);
    if (!accepted) { templated.push(plan.slideId); return plan.base; }
    return slideWithProse(plan, accepted.bullets, accepted.notes ?? plan.templateNotes);
  });
  const summary = typeof value['summary'] === 'string' && value['summary'].trim()
    ? clip(value['summary'], 800) : 'Review deck drafted from the assessment record.';
  return { spec: { ...facts.spec, slides }, templated, summary };
}

/**
 * Re-imposes the facts on a slide: the plan's frame (layout, eyebrow, sources,
 * chart), fact bullets, fact column and excerpts; only the prose part, the
 * title (except on the title slide) and the notes come from `slide`.
 * Returns null when the result is not a renderable slide.
 */
export function applyFacts(slide: DeckSlide, plan: SlidePlan): DeckSlide | null {
  let prose: string[] = [];
  if (plan.prose === 'bullets') prose = (slide.bullets ?? []).slice(plan.factBullets.length);
  else if (plan.prose === 'column') prose = (slide.columns?.[1] ?? []).slice(plan.excerptBullets?.length ?? 0);
  const title = plan.kind === 'title' ? undefined : slide.title;
  const out = slideWithProse(plan, prose, slide.notes, title);
  if (plan.prose === 'bullets' && !out.bullets?.length) return null;
  return out;
}

/** Re-applies facts across a whole deck (slides absent from `facts` are kept as-is). */
export function applyFactsToSpec(spec: DeckSpec, facts: DeckFacts): DeckSpec {
  const plans = new Map(facts.slides.map((p) => [p.slideId, p]));
  return {
    ...spec,
    slides: spec.slides.map((slide) => {
      const plan = plans.get(slide.id);
      return plan ? (applyFacts(slide, plan) ?? plan.base) : slide;
    }),
  };
}

export type ReviseMerge =
  | { ok: true; changed: false; summary: string }
  | { ok: true; changed: true; spec: DeckSpec; changedSlideIds: string[]; summary: string }
  | { ok: false; reason: string };

/**
 * Merges a revise-review-deck result over `base`. A refused edit (`fallback`)
 * is "no change". Otherwise: same slide ids in the same order, deck-level
 * fields from `base`, locked and out-of-scope slides from `base`, facts
 * re-applied everywhere, then validated and checked against the measurable
 * constraints the instruction states (deckConstraints).
 */
export function mergeRevise(
  base: DeckSpec, result: unknown, facts: DeckFacts,
  opts: { instruction: string; slideId?: string; locked?: string[] },
): ReviseMerge {
  const value = isRecord(result) ? result : {};
  const summary = typeof value['summary'] === 'string' && value['summary'].trim() ? clip(value['summary'], 800) : '';
  if (value['fallback'] === true) return { ok: true, changed: false, summary: summary || 'No change was made.' };
  const revised = value['spec'];
  if (!isRecord(revised) || !Array.isArray(revised['slides'])) return { ok: false, reason: 'the drafter returned no deck spec' };
  const revisedSlides = revised['slides'] as unknown[];
  const ids = revisedSlides.map((s) => (isRecord(s) ? s['id'] : undefined));
  if (ids.length !== base.slides.length || ids.some((id, i) => id !== base.slides[i]!.id)) {
    return { ok: false, reason: 'the revision changed the slide list (ids or order)' };
  }
  const plans = new Map(facts.slides.map((p) => [p.slideId, p]));
  const locked = new Set(opts.locked ?? []);
  const slides = base.slides.map((before, i) => {
    if (locked.has(before.id)) return before;
    if (opts.slideId && before.id !== opts.slideId) return before;
    if (sameSlide(revisedSlides[i], before)) return before;
    const candidate = validateDeckSpec({ title: base.title, slides: [revisedSlides[i]] });
    if (!candidate.ok) return before;
    const plan = plans.get(before.id);
    if (!plan) return before;
    return applyFacts(candidate.spec.slides[0]!, plan) ?? before;
  });
  const after: DeckSpec = { ...base, slides };
  const validation = validateDeckSpec(after);
  if (!validation.ok) return { ok: false, reason: `the revised deck is not valid: ${validation.errors.join('; ')}` };
  const changedSlideIds = validation.spec.slides.filter((s, i) => !sameSlide(s, base.slides[i])).map((s) => s.id);
  if (!changedSlideIds.length) return { ok: true, changed: false, summary: summary || 'No change was made.' };
  const scope = opts.slideId ? { slideId: opts.slideId } : {};
  const check = checkConstraints(parseConstraints(opts.instruction, scope), base, validation.spec, scope);
  if (check.violations.length) {
    return { ok: false, reason: `the revision does not do what was asked: ${check.violations.map((v) => v.message).join(' ')}` };
  }
  return { ok: true, changed: true, spec: validation.spec, changedSlideIds, summary: summary || 'Deck revised as instructed.' };
}

// ─── Offline drafter (MOCK_AGENTCORE) ─────────────────────────────────────
//
// Deterministic, and obeys the same contract the deployed drafter does:
// every span is a verbatim prefix of an excerpt the slide was given, and the
// only numbers stated come from the slide's facts (the template prose) or the
// quoted evidence.

function spanOf(excerpt: string): string {
  const flat = excerpt.trim();
  if (flat.length <= 140) return flat;
  const cut = flat.slice(0, 140);
  const space = cut.lastIndexOf(' ');
  return space > 60 ? cut.slice(0, space) : cut;
}

export function mockDraftResult(input: DraftDeckInput, facts: DeckFacts): Record<string, unknown> {
  const narratives: DeckNarrative[] = [];
  const fallbackSlideIds: string[] = [];
  for (const slide of input.slides) {
    const plan = facts.slides.find((p) => p.slideId === slide.slideId);
    const first = slide.evidence[0];
    if (!plan || !first) { fallbackSlideIds.push(slide.slideId); continue; }
    const span = spanOf(first.excerpt);
    const quote = clip(`Evidence on file: “${span}”`);
    narratives.push({
      slideId: slide.slideId,
      bullets: [...plan.templateProse.slice(0, Math.max(0, plan.maxProse - 1)), quote].slice(0, plan.maxProse),
      notes: `Drafted offline from ${slide.evidence.length === 1 ? 'one evidence excerpt' : 'the supplied evidence excerpts'}.`,
      source_spans: [{ evidenceId: first.id, text: span }],
    });
  }
  return {
    summary: `Drafted narrative for ${narratives.length} of ${input.slides.length} slides from the team's evidence (offline drafter).`,
    narratives, fallbackSlideIds, draft: true, published: false,
  };
}

export function mockReviseResult(input: ReviseDeckInput, facts: DeckFacts): Record<string, unknown> {
  const target = input.slideId
    ?? facts.slides.find((p) => p.prose !== 'none' && input.spec.slides.some((s) => s.id === p.slideId))?.slideId;
  const index = input.spec.slides.findIndex((s) => s.id === target);
  const plan = facts.slides.find((p) => p.slideId === target);
  if (index < 0 || !plan) {
    return { summary: 'No change was made.', spec: input.spec, changedSlideIds: [], source_spans: [], fallback: true, draft: true, published: false };
  }
  const slide: DeckSlide = JSON.parse(JSON.stringify(input.spec.slides[index]));
  const instruction = input.instruction.trim();
  const shorterTitle = /\btitle\b/i.test(instruction) && /\b(short|shorter|shorten)\b/i.test(instruction);
  if (shorterTitle && plan.kind !== 'title') {
    const words = slide.title.split(/\s+/);
    if (words.length > 1) slide.title = words.slice(0, -1).join(' ');
  } else if (plan.prose !== 'none') {
    const list = plan.prose === 'column' ? slide.columns![1] : (slide.bullets ??= []);
    const fixed = plan.prose === 'column' ? (plan.excerptBullets?.length ?? 0) : plan.factBullets.length;
    const wantsShorter = /\b(shorter|shorten|fewer|concise|trim|tighter|tighten|condense|briefer|terser|crisper)\b/i.test(instruction);
    if (wantsShorter && list.length - fixed > 1) list.pop();
    else if (wantsShorter) {
      // One prose bullet left: shorten it by a word rather than adding a note,
      // so a "tighten"/"shorter" instruction never grows the slide.
      const last = list.length - 1;
      const words = (list[last] ?? '').split(/\s+/);
      if (last >= fixed && words.length > 3) list[last] = words.slice(0, -1).join(' ');
    } else if (list.length - fixed < plan.maxProse) list.push(clip(`Reviewer note: ${instruction.replace(/\d+(?:\.\d+)?/g, '').replace(/\s+/g, ' ')}`));
  }
  slide.notes = clip(`Revised offline per instruction: ${instruction}`, 600);
  const spec = { ...input.spec, slides: input.spec.slides.map((s, i) => (i === index ? slide : s)) };
  return {
    summary: `Revised slide ${index + 1} (${slide.id}) as instructed (offline drafter).`,
    spec, changedSlideIds: [slide.id], source_spans: [], draft: true, published: false,
  };
}
