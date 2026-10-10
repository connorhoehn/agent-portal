// The facts half of a Social `/deck` (docs/agentic-flows-migration.md slice 5).
// Same rule as the assessment and pipeline decks: every count, name and date
// on a slide is read from the conversation lines here, never written by the
// model. The lines are what the CALLER may read (route: readChatLines — member,
// history floor, no deleted messages), so a slide can only cite a message the
// requester could already see. Nova writes only the prose of the overview and
// discussion slides, through the drafter's existing `draft-review-deck` command
// (tenant 'social'); `mergeDraft` (lib/assessment-deck/narrative.ts) keeps the
// template text for any slide whose quotes are not verbatim in THAT slide's
// evidence or whose numbers are not in its facts.
//
// Every slide cites message ids: a source is `social-message:<messageId>`
// titled "Author - day time - first words". The renderer appends the Sources
// slide from them. Reference: realtime-examples deck-generate pipeline (the
// spec comes from the transcript; every slide carries its sources).

import { MAX_BULLETS_PER_SLIDE, MAX_SOURCES_PER_SLIDE, MAX_TITLE_CHARS, type DeckSource, type DeckSpec } from '@connorhoehnslalom/realtime-modules/deck';
import { clip, makePlan, type DeckEvidence, type DeckFacts, type FactValue, type SlidePlan } from '../deck-shared/plan.js';
import type { DraftDeckInput } from '../deck-shared/narrative.js';
import type { TranscriptLine } from '../social-summarize.js';
import { RECORDING_SOURCE_PREFIX } from '../recording-transcript.js';

export interface DeckPageFact {
  kind: 'initiative' | 'work-item'; id: string; title: string; trail: string;
  /** Set on a revise when the CURRENT requester can no longer read the page: no title is carried. */
  unavailable?: boolean;
}
export const PAGE_SOURCE_PREFIX = 'social-page:';
const PAGE_SOURCE = /^social-page:(initiative|work-item):(.+)$/;
/** The pages a stored deck cites, read from its own sources (durable, unlike the run record). */
export function citedPagesOf(spec: { slides: ReadonlyArray<{ sources: ReadonlyArray<{ documentId: string }> }> }): Array<{ kind: 'initiative' | 'work-item'; id: string }> {
  const out: Array<{ kind: 'initiative' | 'work-item'; id: string }> = [];
  for (const slide of spec.slides) for (const src of slide.sources) {
    const m = PAGE_SOURCE.exec(src.documentId);
    if (m && !out.some(p => p.kind === m[1] && p.id === m[2])) out.push({ kind: m[1] as 'initiative' | 'work-item', id: m[2]! });
  }
  return out;
}
const pageLabel = (p: DeckPageFact): string => (p.kind === 'initiative' ? 'Initiative' : 'Work item');

export interface ConversationDeckSource {
  /** Run id, carried as the drafter's `teamId` (like the pipelines report). */
  runId: string;
  title: string;
  conversationName: string;
  lines: readonly TranscriptLine[];
  pages: readonly DeckPageFact[];
}

export const MESSAGE_SOURCE_PREFIX = 'social-message:';
export const DECK_NARRATIVE_KINDS: ReadonlySet<string> = new Set(['conversation-overview', 'conversation-topic']);

const EXCERPT_CHARS = 600;
const MAX_TOPICS = 4;
const LINES_PER_TOPIC = 6;
const MAX_EVIDENCE = 8;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const day = (iso: string): string => iso.slice(0, 10);
const when = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;

/** A recording segment cites itself (`recording:<id>#<segment>`); a message cites `social-message:<id>`. */
export const sourceIdOf = (messageId: string): string =>
  (messageId.startsWith(RECORDING_SOURCE_PREFIX) ? messageId : `${MESSAGE_SOURCE_PREFIX}${messageId}`).slice(0, 200);

export const messageSource = (line: TranscriptLine): DeckSource => ({
  documentId: sourceIdOf(line.messageId),
  title: clip(`${line.author} · ${when(line.at)} — ${line.text}`, 160),
});

/** Up to `n` lines spread evenly across `lines`, in order. */
export function spread<T>(lines: readonly T[], n: number): T[] {
  if (lines.length <= n) return [...lines];
  const picked: T[] = [];
  for (let i = 0; i < n; i += 1) picked.push(lines[Math.floor((i * (lines.length - 1)) / (n - 1))]!);
  return picked.filter((line, i) => picked.indexOf(line) === i);
}

const evidenceOf = (lines: readonly TranscriptLine[]): DeckEvidence[] =>
  lines.map(l => ({ id: l.messageId, excerpt: l.text.slice(0, EXCERPT_CHARS) }));
const sourcesOf = (lines: readonly TranscriptLine[]): DeckSource[] => lines.slice(0, MAX_SOURCES_PER_SLIDE).map(messageSource);
const quoteOf = (l: TranscriptLine): string => clip(`${l.author}: “${l.text}”`);

/** Consecutive chunks of the thread, at most MAX_TOPICS, none empty. */
export function topicChunks<T>(lines: readonly T[]): T[][] {
  if (lines.length < 4) return [];
  const count = Math.min(MAX_TOPICS, Math.ceil(lines.length / LINES_PER_TOPIC));
  const size = Math.ceil(lines.length / count);
  const chunks: T[][] = [];
  for (let i = 0; i < lines.length; i += size) chunks.push(lines.slice(i, i + size));
  return chunks;
}

export function buildConversationDeckFacts(src: ConversationDeckSource): DeckFacts {
  const { lines, pages } = src;
  const people = new Map<string, TranscriptLine[]>();
  for (const l of lines) people.set(l.author, [...(people.get(l.author) ?? []), l]);
  const slides: SlidePlan[] = [];
  const first = lines[0];
  const last = lines[lines.length - 1];
  const period = first && last ? (day(first.at) === day(last.at) ? day(first.at) : `${day(first.at)} to ${day(last.at)}`) : 'no messages';
  const pageSources: DeckSource[] = pages.map(p => ({ documentId: `${PAGE_SOURCE_PREFIX}${p.kind}:${p.id}`.slice(0, 200), title: p.unavailable ? 'Page no longer available to you' : clip(`${p.title}${p.trail ? ` — ${p.trail}` : ''}`, 160) }));
  const edgeSources = first && last ? [first, last].filter((l, i, a) => a.indexOf(l) === i).map(messageSource) : [];

  // 1. Title — cites the thread's first and last message (and the pages).
  slides.push(makePlan({
    slideId: 'title', kind: 'conversation-title',
    facts: { conversation: src.conversationName, period, messages: lines.length, people: people.size },
    evidence: [], prose: 'none', maxProse: 0,
    factBullets: [`Conversation: ${clip(src.conversationName, 80)}`, `Period: ${period}`, `${plural(lines.length, 'message')} from ${plural(people.size, 'person', 'people')}`],
    templateProse: [], templateNotes: `Deck built from ${plural(lines.length, 'message')} in ${src.conversationName} that the requester could read.`,
  }, { id: 'title', layout: 'title', title: clip(src.title, MAX_TITLE_CHARS), eyebrow: 'Conversation deck', sources: [...edgeSources, ...pageSources].slice(0, MAX_SOURCES_PER_SLIDE) }));

  // 2. Overview — prose by Nova, from evenly spread messages.
  if (lines.length > 0) {
    const evidenceLines = spread(lines, MAX_EVIDENCE);
    const factBullets = [`${plural(lines.length, 'message')} · ${plural(people.size, 'person', 'people')} · ${period}`];
    slides.push(makePlan({
      slideId: 'overview', kind: 'conversation-overview',
      facts: { messages: lines.length, people: people.size, period },
      evidence: evidenceOf(evidenceLines), prose: 'bullets', maxProse: MAX_BULLETS_PER_SLIDE - factBullets.length, factBullets,
      templateProse: spread(lines, 3).map(quoteOf),
      templateNotes: 'Counts are read from the conversation lines you could see; each quote is one message, cited under Sources.',
    }, { id: 'overview', layout: 'bullets', title: 'Overview', sources: sourcesOf(evidenceLines) }));
  }

  // 3. Discussion slides — consecutive stretches of the thread.
  topicChunks(lines).forEach((chunk, i) => {
    const evidenceLines = spread(chunk, MAX_EVIDENCE);
    const from = chunk[0]!;
    const to = chunk[chunk.length - 1]!;
    const authors = new Set(chunk.map(l => l.author));
    const factBullets = [`${plural(chunk.length, 'message')} from ${plural(authors.size, 'person', 'people')} · ${when(from.at)} to ${when(to.at)}`];
    const id = `topic-${i + 1}`;
    slides.push(makePlan({
      slideId: id, kind: 'conversation-topic',
      facts: { messages: chunk.length, people: authors.size, from: when(from.at), to: when(to.at) },
      evidence: evidenceOf(evidenceLines), prose: 'bullets', maxProse: MAX_BULLETS_PER_SLIDE - factBullets.length, factBullets,
      templateProse: spread(chunk, 2).map(quoteOf),
      templateNotes: `Messages ${when(from.at)} to ${when(to.at)}; each quote is one message, cited under Sources.`,
    }, { id, layout: 'bullets', title: `Discussion ${i + 1}`, eyebrow: day(from.at), sources: sourcesOf(evidenceLines) }));
  });

  // 4. Who spoke — counts only.
  if (people.size > 0) {
    const ranked = [...people.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    const rows = ranked.map(([name, ls]) => `${name} — ${plural(ls.length, 'message')}`);
    const shown = rows.length > MAX_BULLETS_PER_SLIDE ? [...rows.slice(0, MAX_BULLETS_PER_SLIDE - 1), `…and ${rows.length - (MAX_BULLETS_PER_SLIDE - 1)} more`] : rows;
    slides.push(makePlan({
      slideId: 'people', kind: 'conversation-people', facts: { people: people.size }, evidence: [], prose: 'none', maxProse: 0,
      factBullets: shown.map(r => clip(r)), templateProse: [], templateNotes: 'Message counts per person, counted from the thread.',
    }, { id: 'people', layout: 'bullets', title: 'Who spoke', sources: ranked.slice(0, MAX_SOURCES_PER_SLIDE).map(([, ls]) => messageSource(ls[ls.length - 1]!)) }));
  }

  // 5. Referenced pages.
  if (pages.length > 0) {
    slides.push(makePlan({
      slideId: 'pages', kind: 'conversation-pages', facts: { pages: pages.length, unavailable: pages.filter(p => p.unavailable).length }, evidence: [], prose: 'none', maxProse: 0,
      factBullets: pages.map(p => clip(p.unavailable ? `${pageLabel(p)} ${p.id}: no longer available to you` : `${pageLabel(p)}: ${p.title}${p.trail ? ` (${p.trail})` : ''}`)), templateProse: [],
      templateNotes: 'Pages named in the command, read under your own access.',
    }, { id: 'pages', layout: 'bullets', title: 'Referenced pages', sources: pageSources }));
  }

  const subtitle = clip(`${src.conversationName} · ${period}`, 200);
  return { teamId: src.runId, slides, spec: { title: clip(src.title, MAX_TITLE_CHARS), subtitle, theme: 'plain', slides: slides.map(s => s.base) } };
}

/** The drafter's input for `draft-review-deck`: `teamId` carries the run id. */
export function buildConversationDraftInput(facts: DeckFacts): DraftDeckInput {
  return {
    teamId: facts.teamId,
    slides: facts.slides.filter(s => DECK_NARRATIVE_KINDS.has(s.kind)).map(s => ({ slideId: s.slideId, kind: s.kind, facts: s.facts, evidence: s.evidence })),
  };
}

export type { FactValue };

/**
 * Re-applies the facts-only slides of a stored deck from the current facts: the
 * Referenced pages slide (bullets and sources) and the page sources on the
 * title slide. A page the reviser can no longer read becomes an "unavailable"
 * line there; the old title is never reused. Locked slides are left alone.
 */
export function refreshPageSlides(base: DeckSpec, facts: DeckFacts, locked: readonly string[]): DeckSpec {
  const fresh = new Map(facts.spec.slides.map(s => [s.id, s]));
  const slides = base.slides.map(slide => {
    if (locked.includes(slide.id)) return slide;
    const next = fresh.get(slide.id);
    if (!next) return slide;
    if (slide.id === 'pages') return { ...next };
    if (slide.id === 'title') {
      const kept = slide.sources.filter(x => !x.documentId.startsWith(PAGE_SOURCE_PREFIX));
      const pageSrc = next.sources.filter(x => x.documentId.startsWith(PAGE_SOURCE_PREFIX));
      return { ...slide, sources: [...kept, ...pageSrc].slice(0, MAX_SOURCES_PER_SLIDE) };
    }
    return slide;
  });
  return { ...base, slides };
}
