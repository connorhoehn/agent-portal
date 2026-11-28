// Typed edit operations on a deck (docs/deck-edit-operations.md): a short list
// of small, explicit changes applied to the head revision and saved as ONE new
// revision through the same compare-and-set a person's save uses. The list
// applies whole or not at all; the result passes the engine's validator and is
// laid out, and the answer carries the layout findings of the slides touched.
//
// Nothing here writes anything but validated deck data (docs/deck-builder-plan.md
// decision 1). Chart numbers come either from the caller as explicit data
// (validated against the format's limits) or from a report the app reads under
// the caller's own authority (`DeckChartResolver`, lib/deck-shared/reports.ts);
// never from a model.

import { randomUUID } from 'node:crypto';
import {
  DECK_DECORATION_PLACEMENTS, DECK_EMPHASES, MAX_BULLET_CHARS, MAX_CHART_LABELS, MAX_CHART_SERIES, MAX_ITEM_TEXT_CHARS, MAX_ITEM_TITLE_CHARS,
  MAX_PIE_SLICES, MAX_SLIDES, MAX_STORY_BULLETS, SLIDE_ID_PATTERN, THEME_REF_PATTERN, plainText, textRuns, validateDeckSpec,
  type DeckChart, type DeckDecorationPlacement, type DeckEmphasis, type DeckRun, type DeckSlide, type DeckSource, type DeckSpec, type DeckText, type SlideLayout,
} from '@connorhoehn/realtime-modules/deck';
import { BUILTIN_THEMES, DECK_STYLES, GRAPHIC_NAMES, isGraphicName, isEditablePath, setInDeck } from '@connorhoehn/realtime-modules/deck/layout';
import type { ArtifactRevisionStore } from '../flow-artifacts/index.js';
import { hostSpecErrors } from './host-rules.js';
import { layoutSpec } from './render.js';

export { hostSpecErrors };
import { REPORT_NOTE_LINE } from './reports.js';
import {
  BULLET_LAYOUTS, LAYOUT_PAYLOAD, LAYOUT_PAYLOADS, LAYOUT_TITLE, PAYLOAD_FIELDS, SLIDE_LAYOUTS, STARTERS, UNSOURCED_SOURCE,
} from './slide-starters.js';

export { LAYOUT_PAYLOAD, LAYOUT_PAYLOADS, SLIDE_LAYOUTS, UNSOURCED_SOURCE };
import { summaryOf, type DeckLookup, type DeckHead } from './service.js';
import { isDeckStyle, resolveDeckTheme, themeChoice, withDeckStyle, type DeckHostTenant } from './themes.js';
import type { DeckRevisionSummary, Result } from './types.js';

export const MAX_DECK_OPERATIONS = 10;

export const DECK_OPERATION_KINDS = [
  'add_slide', 'remove_slide', 'move_slide', 'set_title', 'set_fields', 'change_layout', 'set_notes', 'set_theme', 'set_chart',
  'set_style', 'set_decoration', 'set_emphasis', 'set_path',
] as const;
export type DeckOperationKind = typeof DECK_OPERATION_KINDS[number];


/** The fields `set_fields` and `add_slide.fields` may name on a slide of `layout`: bullets only where the layout draws them. */
export function layoutFields(layout: SlideLayout): string[] {
  return ['eyebrow', ...(BULLET_LAYOUTS.includes(layout) ? ['bullets'] : []), ...LAYOUT_PAYLOADS[layout]];
}


/**
 * The documentId prefix of a placeholder citation: a template's example source
 * (`example:template:<id>`) or a slide added without sources (`example:unsourced`).
 * The format accepts it like any source; previews and the operations answer name
 * the slides still carrying one so a page can ask for the real document.
 */
export const EXAMPLE_SOURCE_PREFIX = 'example:';

export const isExampleSource = (s: DeckSource): boolean => s.documentId.startsWith(EXAMPLE_SOURCE_PREFIX);

/** Slides whose only citations are placeholders. */
export function exampleSourceSlideIds(spec: DeckSpec): string[] {
  return spec.slides.filter((s) => s.sources.length > 0 && s.sources.every(isExampleSource)).map((s) => s.id);
}



/** A chart read from one of the app's reports, ready to put on a slide. */
export interface ResolvedChart {
  chart: DeckChart;
  /** The source the slide cites: the report and its period. */
  source: DeckSource;
  /** One line for the speaker notes: what was read and when. */
  note: string;
  /** One phrase for the revision summary ("Spend by initiative, this month, top 5 and Other"). */
  summary: string;
  /** The report title: the slide takes it unless the operation gave a title. */
  title: string;
}

/** Resolves `{ report, params }` for this caller and this deck's tenant (lib/deck-shared/reports.ts). */
export type DeckChartResolver = (ref: { report: string; params?: unknown }, kind: DeckChart['kind']) => Promise<Result<ResolvedChart>>;

export interface ApplyOperationsInput {
  tenant: DeckHostTenant;
  revisions: ArtifactRevisionStore<DeckSpec>;
  lookup: DeckLookup<DeckHead>;
  deckId: string;
  body: { baseRevisionId?: unknown; operations?: unknown; label?: unknown };
  sub: string | null;
  /** Absent: `set_chart` takes explicit data only. */
  resolveChart?: DeckChartResolver;
  /**
   * The record a new slide cites when the operation names no sources: an
   * initiative deck's own initiative (`initiative:<id>`). Absent: the
   * `example:unsourced` placeholder, which the page flags until it is replaced.
   */
  recordSource?: DeckSource;
  /** Ids for new slides; tests pass a deterministic one. */
  mintSlideId?: () => string;
}

export interface OperationsOut {
  revision: DeckRevisionSummary;
  /** Every slide an operation changed or added (not ones it removed), in deck order. */
  touchedSlideIds: string[];
  /** The layout findings for those slides: "that slide now overflows". */
  findings: Array<{ slideId: string; kind: string; region: string; detail: string; byPoints?: number }>;
  summary: string;
  /** Slides still citing only a placeholder (a template's example, or `example:unsourced`). */
  exampleSourceSlideIds: string[];
}

class OpError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413 | 429 | 503, message: string, readonly errors?: string[]) { super(message); }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isLayout = (v: unknown): v is SlideLayout => typeof v === 'string' && (SLIDE_LAYOUTS as readonly string[]).includes(v);

function only(op: Record<string, unknown>, keys: string[]): void {
  const extra = Object.keys(op).filter((k) => k !== 'op' && !keys.includes(k));
  if (extra.length) throw new OpError(400, `unknown field${extra.length > 1 ? 's' : ''} ${extra.join(', ')}`);
}

function str(op: Record<string, unknown>, key: string): string {
  const v = op[key];
  if (typeof v !== 'string' || !v.trim()) throw new OpError(400, `${key} must be a non-empty string`);
  return v;
}

/** Validation errors one field produces on its own, checked on a one-slide probe deck. */
function fieldErrors(layout: SlideLayout, field: string, value: unknown): string[] {
  const probe = { title: 'probe', slides: [{ id: 'probe', layout, title: 'probe', [field]: value, sources: [{ documentId: 'probe', title: 'probe' }] }] };
  const out = validateDeckSpec(probe);
  const errors = out.ok ? [] : out.errors.filter((e) => e.includes(`].${field}`) || e.includes(`]: a '${layout}' slide needs`) && e.includes(field));
  if (field === 'image' && isObj(value) && value['url'] !== undefined) errors.push(...hostSpecErrors({ slides: [{ id: 'probe', image: { url: String(value['url']) } }] }).map((e) => e.replace(/^slide probe: /, 'deck.slides[0].')));
  return errors;
}

/** A title or a bullet: a non-empty string or a list of runs (`{ text, emphasis? }`) the format accepts. */
function deckText(op: Record<string, unknown>, key: string): DeckText {
  const v = op[key];
  if (typeof v === 'string') return str(op, key);
  if (!Array.isArray(v) || !v.length) throw new OpError(400, `${key} must be a non-empty string or a list of { text, emphasis? } runs`);
  const out = validateDeckSpec({ title: 'probe', slides: [{ id: 'probe', layout: 'bullets', title: v, bullets: ['probe'], sources: [{ documentId: 'probe', title: 'probe' }] }] });
  if (!out.ok) throw new OpError(400, `${key} is not valid`, out.errors.map((e) => e.replace(/^(deck\.)?slides\[0\]\.title/, key)));
  return structuredClone(v) as DeckRun[];
}

/** The words of `text` from `from` to `to` (1-based, inclusive) given `emphasis`, or plain when it is null; other runs keep theirs. */
export function emphasiseWords(text: DeckText, from: number, to: number, emphasis: DeckEmphasis | null): DeckText {
  const runs = textRuns(text) ?? [{ text: String(text) }];
  const raw = runs.map((r) => r.text).join('');
  const marks: Array<DeckEmphasis | undefined> = runs.flatMap((r) => [...r.text].map(() => r.emphasis));
  const chars = [...raw];
  const words = [...raw.matchAll(/\S+/gu)];
  if (from < 1 || to < from || to > words.length) throw new OpError(400, `words ${from} to ${to}: the text has ${words.length} word${words.length === 1 ? '' : 's'}`);
  // Positions in code points, so an accented or emoji character counts once.
  const cp = (index: number): number => [...raw.slice(0, index)].length;
  const start = cp(words[from - 1]!.index!);
  const end = cp(words[to - 1]!.index! + words[to - 1]![0].length);
  for (let i = start; i < end; i += 1) marks[i] = emphasis ?? undefined;
  const out: DeckRun[] = [];
  for (const [i, ch] of chars.entries()) {
    const last = out[out.length - 1];
    if (last && last.emphasis === marks[i]) last.text += ch;
    else out.push(marks[i] ? { text: ch, emphasis: marks[i] } : { text: ch });
  }
  // The engine refuses a run of only spaces (two marked words side by side leave one between them): it joins a neighbour.
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i]!.text.trim() || out.length === 1) continue;
    if (i > 0) out[i - 1]!.text += out[i]!.text;
    else out[1]!.text = out[0]!.text + out[1]!.text;
    out.splice(i, 1);
  }
  return out.every((r) => !r.emphasis) ? raw : out;
}

const clipAt = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…`);

function setField(slide: DeckSlide, field: string, value: unknown): void {
  if (!layoutFields(slide.layout).includes(field)) {
    throw new OpError(400, `${field} does not belong to a '${slide.layout}' slide; it takes ${layoutFields(slide.layout).join(', ')}`);
  }
  const rec = slide as unknown as Record<string, unknown>;
  if (value === null) {
    if ((LAYOUT_PAYLOADS[slide.layout] as readonly string[]).includes(field)) throw new OpError(400, `${field} is what a '${slide.layout}' slide shows; it cannot be removed`);
    delete rec[field];
    return;
  }
  const errors = fieldErrors(slide.layout, field, value);
  if (errors.length) throw new OpError(400, `${field} is not valid`, errors.map((e) => e.replace(/^(deck\.)?slides\[0\]/, `slide ${slide.id}`)));
  rec[field] = structuredClone(value);
}

/** Moves `slide` to `layout`, carrying across what the new layout can show. Returns the fields dropped. */
export function changeSlideLayout(slide: DeckSlide, layout: SlideLayout): string[] {
  if (slide.layout === layout) return [];
  const rec = slide as unknown as Record<string, unknown>;
  const dropped: string[] = [];
  const owns = (l: SlideLayout, f: string): boolean => (LAYOUT_PAYLOADS[l] as readonly string[]).includes(f);
  const points = (slide.bullets ?? []).map((b) => plainText(b));
  // What carries over: a list of points becomes the agenda, the next steps, cards or
  // process steps and back; two columns become the two sides of a comparison and back.
  if (layout === 'agenda' && !slide.agenda && points.length) {
    slide.agenda = { items: points.slice(0, 6).map((b) => clipAt(b, 80)) };
    delete slide.bullets;
  } else if ((layout === 'cards' || layout === 'process') && !slide.items && points.length >= 3) {
    slide.items = points.slice(0, layout === 'cards' ? 4 : 5).map((b) => (b.length <= MAX_ITEM_TITLE_CHARS ? { title: b } : { title: clipAt(b, MAX_ITEM_TITLE_CHARS), text: clipAt(b, MAX_ITEM_TEXT_CHARS) }));
    delete slide.bullets;
  } else if (layout === 'cards' && slide.items && slide.items.length > 4) {
    slide.items = slide.items.slice(0, 4);
    dropped.push('the fifth step');
  } else if (layout === 'bullets' && slide.agenda) {
    slide.bullets = [...slide.agenda.items];
  } else if (layout === 'bullets' && slide.items?.length) {
    slide.bullets = slide.items.map((i) => clipAt(i.text ? `${i.title}: ${i.text}` : i.title, MAX_BULLET_CHARS));
  } else if (layout === 'bullets' && slide.closing?.nextSteps?.length) {
    slide.bullets = [...slide.closing.nextSteps];
  } else if (layout === 'comparison' && slide.columns) {
    slide.comparison = {
      left: { title: 'Left', points: slide.columns[0].slice(0, 5).map((p) => p.slice(0, 120)) },
      right: { title: 'Right', points: slide.columns[1].slice(0, 5).map((p) => p.slice(0, 120)) },
    };
  } else if (layout === 'two-column' && slide.comparison) {
    slide.columns = [[...slide.comparison.left.points], [...slide.comparison.right.points]];
  } else if (layout === 'closing' && !slide.closing && points.length) {
    slide.closing = { line: clipAt(plainText(slide.title), 100), nextSteps: points.slice(0, 3).map((b) => clipAt(b, 120)) };
    delete slide.bullets;
  }
  for (const field of PAYLOAD_FIELDS) {
    if (rec[field] !== undefined && !owns(layout, field)) { delete rec[field]; dropped.push(field); }
  }
  // Bullets stay only where the new layout draws them; a big number's story takes three.
  if (slide.bullets !== undefined && !BULLET_LAYOUTS.includes(layout)) { delete slide.bullets; dropped.push('bullets'); }
  if (layout === 'big-number' && slide.bullets && slide.bullets.length > MAX_STORY_BULLETS) {
    slide.bullets = slide.bullets.slice(0, MAX_STORY_BULLETS);
    dropped.push(`bullets after the ${MAX_STORY_BULLETS === 3 ? 'third' : `${MAX_STORY_BULLETS}th`}`);
  }
  if (layout === 'big-number' && slide.figures && slide.figures.length > 1) { slide.figures = slide.figures.slice(0, 1); dropped.push('figures after the first'); }
  slide.layout = layout;
  fillStarters(slide);
  return dropped;
}

/** Gives a slide its layout's starter words for every owned field it lacks (and bullets on an empty bullets slide). */
function fillStarters(slide: DeckSlide): void {
  const rec = slide as unknown as Record<string, unknown>;
  const starter = STARTERS[slide.layout] ?? (slide.layout === 'kpi' ? { figures: STARTERS['key-figures']!.figures } : {});
  for (const [k, v] of Object.entries(starter)) if (rec[k] === undefined) rec[k] = structuredClone(v);
  if (slide.layout === 'bullets' && !slide.bullets?.length) slide.bullets = [...STARTERS.bullets!.bullets!];
}

/** Explicit chart data, checked against the format's limits before it touches a slide. */
function explicitChart(kind: DeckChart['kind'], raw: unknown): DeckChart {
  if (!isObj(raw)) throw new OpError(400, 'data must be { labels, series }');
  const { labels, series } = raw;
  if (!Array.isArray(labels) || !Array.isArray(series)) throw new OpError(400, 'data must be { labels, series }');
  if (labels.length > MAX_CHART_LABELS) throw new OpError(400, `data.labels: ${labels.length} labels, the cap is ${MAX_CHART_LABELS}`);
  if (series.length > MAX_CHART_SERIES) throw new OpError(400, `data.series: ${series.length} series, the cap is ${MAX_CHART_SERIES}`);
  if (kind === 'pie' && labels.length > MAX_PIE_SLICES) throw new OpError(400, `data.labels: a pie takes at most ${MAX_PIE_SLICES} slices`);
  const chart = { kind, labels, series } as DeckChart;
  const errors = fieldErrors('chart', 'chart', chart);
  if (errors.length) throw new OpError(400, 'data is not a valid chart', errors.map((e) => e.replace(/^(deck\.)?slides\[0\]\./, '')));
  return structuredClone(chart);
}


/**
 * Applies `body.operations` to the deck's head and saves the result as a new
 * revision when `body.baseRevisionId` is still the head (409 with the current
 * head otherwise, exactly as a save answers).
 */
/** A list that passed every check, not yet saved: what `applyDeckOperations` appends and a proposal shows. */
export interface PlannedOperations {
  base: { id: string; lockedSlideIds: string[] };
  spec: DeckSpec;
  /** One plain phrase per operation, in order ("changed slide 3 from bullets to kpi"). */
  phrases: string[];
  touchedSlideIds: string[];
  findings: OperationsOut['findings'];
  /** The phrases as one sentence, capitalised, as the revision summary reads. */
  summary: string;
}

/**
 * Every check `applyDeckOperations` makes (the shape of each operation, the head,
 * locked slides, the engine's validator, the host rules, the layout), without
 * saving anything. The proposal route (lib/deck-shared/propose.ts) asks this.
 */
export async function planDeckOperations(input: ApplyOperationsInput): Promise<Result<PlannedOperations>> {
  const { body, revisions, deckId } = input;
  if (!revisions.isRevisionId(body.baseRevisionId)) return { ok: false, status: 400, reason: 'baseRevisionId must name a revision' };
  if (!Array.isArray(body.operations) || body.operations.length === 0) return { ok: false, status: 400, reason: 'operations must be a non-empty list' };
  if (body.operations.length > MAX_DECK_OPERATIONS) return { ok: false, status: 400, reason: `at most ${MAX_DECK_OPERATIONS} operations at a time` };
  if (body.label !== undefined && (typeof body.label !== 'string' || !body.label.trim() || body.label.length > 80)) {
    return { ok: false, status: 400, reason: 'label must be a non-empty string of at most 80 characters' };
  }
  const deck = await input.lookup();
  if (!deck) return { ok: false, status: 404, reason: 'deck not found' };
  const base = deck.headRevisionId === body.baseRevisionId ? await revisions.getRevision(deckId, body.baseRevisionId) : null;
  if (!base) return { ok: false, status: 409, reason: 'the deck has a newer revision', details: { activeRevisionId: deck.headRevisionId } };

  const spec = structuredClone(base.spec);
  const locked = new Set(base.lockedSlideIds);
  const touched = new Set<string>();
  const phrases: string[] = [];
  const mint = input.mintSlideId ?? (() => `s-${randomUUID().slice(0, 8)}`);
  const newId = (): string => {
    for (let i = 0; i < 20; i += 1) {
      const id = mint();
      if (SLIDE_ID_PATTERN.test(id) && id !== 'sources' && !spec.slides.some((s) => s.id === id)) return id;
    }
    throw new OpError(400, 'could not mint a slide id');
  };
  const indexOf = (id: unknown, key = 'slideId'): number => {
    if (typeof id !== 'string') throw new OpError(400, `${key} must name a slide`);
    const i = spec.slides.findIndex((s) => s.id === id);
    if (i < 0) throw new OpError(404, `no slide ${id} in this deck`);
    return i;
  };
  const editable = (op: Record<string, unknown>): DeckSlide => {
    const slide = spec.slides[indexOf(op['slideId'])]!;
    if (locked.has(slide.id)) throw new OpError(409, `slide ${slide.id} is locked`);
    return slide;
  };
  const position = (s: number): string => `slide ${s + 1}`;
  /** A slide by its place in the deck as it stands at that operation, never its id: the summary is read aloud and shown in the history. */
  const named = (slide: DeckSlide): string => position(spec.slides.indexOf(slide));

  try {
    for (const [n, raw] of (body.operations as unknown[]).entries()) {
      try {
        if (!isObj(raw) || typeof raw['op'] !== 'string' || !(DECK_OPERATION_KINDS as readonly string[]).includes(raw['op'])) {
          throw new OpError(400, `op must be one of ${DECK_OPERATION_KINDS.join(', ')}`);
        }
        const op = raw;
        switch (op['op'] as DeckOperationKind) {
          case 'add_slide': {
            only(op, ['layout', 'after', 'title', 'fields', 'sources']);
            if (!isLayout(op['layout'])) throw new OpError(400, `layout must be one of ${SLIDE_LAYOUTS.join(', ')}`);
            if (spec.slides.length >= MAX_SLIDES) throw new OpError(400, `a deck holds at most ${MAX_SLIDES} slides`);
            const layout = op['layout'];
            const at = op['after'] === undefined || op['after'] === 'end' ? spec.slides.length : indexOf(op['after'], 'after') + 1;
            const title = op['title'] === undefined ? LAYOUT_TITLE[layout] : deckText(op, 'title');
            // A deck about a record cites it by default (the deck's own copy of that source when a slide has one).
            const record = input.recordSource
              ? spec.slides.flatMap((s) => s.sources).find((s) => s.documentId === input.recordSource!.documentId) ?? input.recordSource
              : UNSOURCED_SOURCE;
            const slide: DeckSlide = { id: newId(), layout, title, sources: [{ ...record }] };
            if (op['sources'] !== undefined) {
              if (!Array.isArray(op['sources']) || !op['sources'].length) throw new OpError(400, 'sources must be a non-empty list of { documentId, title, anchor? }');
              slide.sources = structuredClone(op['sources']) as DeckSource[];
            }
            if (op['fields'] !== undefined) {
              if (!isObj(op['fields'])) throw new OpError(400, 'fields must be an object');
              for (const [k, v] of Object.entries(op['fields'])) setField(slide, k, v);
            }
            fillStarters(slide);
            spec.slides.splice(at, 0, slide);
            touched.add(slide.id);
            phrases.push(`added a ${layout} slide at ${position(at)}`);
            break;
          }
          case 'remove_slide': {
            only(op, ['slideId']);
            const slide = editable(op);
            if (spec.slides.length === 1) throw new OpError(400, 'a deck keeps at least one slide');
            const was = named(slide);
            spec.slides.splice(spec.slides.indexOf(slide), 1);
            touched.delete(slide.id);
            phrases.push(`removed ${was} ("${plainText(slide.title)}")`);
            break;
          }
          case 'move_slide': {
            only(op, ['slideId', 'after', 'to']);
            const slide = editable(op);
            if ((op['after'] === undefined) === (op['to'] === undefined)) throw new OpError(400, "give either after (a slide id) or to: 'start'");
            if (op['to'] !== undefined && op['to'] !== 'start') throw new OpError(400, "to must be 'start'");
            if (op['after'] === slide.id) throw new OpError(400, 'a slide cannot move after itself');
            const from = named(slide);
            spec.slides.splice(spec.slides.indexOf(slide), 1);
            const at = op['to'] === 'start' ? 0 : indexOf(op['after'], 'after') + 1;
            spec.slides.splice(at, 0, slide);
            touched.add(slide.id);
            phrases.push(`moved ${from} to ${position(at)}`);
            break;
          }
          case 'set_title': {
            only(op, ['slideId', 'title']);
            const slide = editable(op);
            slide.title = deckText(op, 'title');
            touched.add(slide.id);
            phrases.push(`retitled ${named(slide)}`);
            break;
          }
          case 'set_notes': {
            only(op, ['slideId', 'notes']);
            const slide = editable(op);
            if (op['notes'] === null || op['notes'] === '') delete slide.notes;
            else if (typeof op['notes'] !== 'string') throw new OpError(400, 'notes must be a string, or null to clear them');
            else slide.notes = op['notes'];
            touched.add(slide.id);
            phrases.push(`set the notes of ${named(slide)}`);
            break;
          }
          case 'set_fields': {
            only(op, ['slideId', 'fields']);
            const slide = editable(op);
            if (!isObj(op['fields']) || !Object.keys(op['fields']).length) throw new OpError(400, 'fields must name at least one field');
            for (const [k, v] of Object.entries(op['fields'])) setField(slide, k, v);
            touched.add(slide.id);
            phrases.push(`edited ${Object.keys(op['fields']).join(', ')} on ${named(slide)}`);
            break;
          }
          case 'change_layout': {
            only(op, ['slideId', 'layout', 'fields']);
            const slide = editable(op);
            if (!isLayout(op['layout'])) throw new OpError(400, `layout must be one of ${SLIDE_LAYOUTS.join(', ')}`);
            const from = slide.layout;
            const dropped = changeSlideLayout(slide, op['layout']);
            if (op['fields'] !== undefined) {
              if (!isObj(op['fields'])) throw new OpError(400, 'fields must be an object');
              for (const [k, v] of Object.entries(op['fields'])) setField(slide, k, v);
            }
            touched.add(slide.id);
            phrases.push(`changed ${named(slide)} from ${from} to ${slide.layout}${dropped.length ? ` (dropped ${dropped.join(', ')})` : ''}`);
            break;
          }
          case 'set_theme': {
            only(op, ['theme']);
            const theme = op['theme'];
            // The deck's style (when it names one) stays: a theme change only swaps the colours and brand.
            const style = themeChoice(spec.theme).style;
            let name: string;
            if (typeof theme === 'string' && Object.prototype.hasOwnProperty.call(BUILTIN_THEMES, theme)) { spec.theme = theme as keyof typeof BUILTIN_THEMES; name = theme; }
            else if (isObj(theme) && Object.keys(theme).length === 1 && typeof theme['ref'] === 'string' && THEME_REF_PATTERN.test(theme['ref'])) {
              if (theme['ref'] !== input.tenant) throw new OpError(400, `theme ref must be '${input.tenant}', this tenant's theme`);
              spec.theme = { ref: theme['ref'] };
              name = theme['ref'];
            } else throw new OpError(400, `theme must be one of ${Object.keys(BUILTIN_THEMES).join(', ')} or { ref: '${input.tenant}' }`);
            if (style) spec.theme = withDeckStyle(spec.theme, style, input.tenant);
            phrases.push(`set the theme to ${name}`);
            break;
          }
          case 'set_chart': {
            only(op, ['slideId', 'kind', 'data', 'report', 'title']);
            const givenTitle = op['title'] === undefined ? undefined : str(op, 'title');
            const slide = editable(op);
            const kind = op['kind'];
            if (kind !== 'bar' && kind !== 'line' && kind !== 'stacked-bar' && kind !== 'pie') throw new OpError(400, 'kind must be bar, line, stacked-bar or pie');
            if ((op['data'] === undefined) === (op['report'] === undefined)) throw new OpError(400, 'give either data ({ labels, series }) or report ({ report, params? })');
            let chart: DeckChart;
            let phrase: string;
            if (op['data'] !== undefined) {
              chart = explicitChart(kind, op['data']);
              phrase = `set a ${kind} chart on ${named(slide)}`;
            } else {
              const ref = op['report'];
              if (!isObj(ref) || typeof ref['report'] !== 'string') throw new OpError(400, 'report must be { report: <id>, params? }');
              if (!input.resolveChart) throw new OpError(404, `no report ${ref['report']} for this deck`);
              const resolved = await input.resolveChart({ report: ref['report'], ...(ref['params'] !== undefined ? { params: ref['params'] } : {}) }, kind);
              if (!resolved.ok) throw new OpError(resolved.status, resolved.reason);
              chart = resolved.value.chart;
              // The report is the slide's source; any earlier placeholder goes.
              slide.sources = [resolved.value.source, ...slide.sources.filter((s) => !isExampleSource(s) && s.documentId !== resolved.value.source.documentId)].slice(0, 10);
              // One "Figures read …" line: an earlier one on this slide is replaced, never stacked.
              const kept = (slide.notes ?? '').split('\n').filter((line) => line.trim() && !REPORT_NOTE_LINE.test(line.trim()));
              slide.notes = [...kept, resolved.value.note].join('\n').slice(-2000);
              phrase = `set a ${kind} chart on ${named(slide)} from ${resolved.value.summary}`;
              // The report names the slide unless the caller gave a title; the summary says the rename (the confirm card and the page do too).
              if (givenTitle === undefined && plainText(slide.title) !== resolved.value.title) {
                phrase += plainText(slide.title) ? ` and renamed it from "${plainText(slide.title)}" to "${resolved.value.title}"` : ` titled "${resolved.value.title}"`;
                slide.title = resolved.value.title;
              }
            }
            if (givenTitle !== undefined && plainText(slide.title) !== givenTitle) {
              phrase += ` titled "${givenTitle}"`;
              slide.title = givenTitle;
            }
            // A chart put on a slide that cannot show one turns it into a chart slide; what a chart slide does not
            // draw (old bullets, another layout's payload) is dropped and the summary says so (finding 2 of the tour film).
            if (!(LAYOUT_PAYLOADS[slide.layout] as readonly string[]).includes('chart')) {
              const from = slide.layout;
              const dropped = changeSlideLayout(slide, 'chart');
              phrase += ` (it was a ${from} slide${dropped.length ? `; dropped ${dropped.join(', ')}` : ''})`;
            }
            slide.chart = chart;
            touched.add(slide.id);
            phrases.push(phrase);
            break;
          }
          case 'set_style': {
            only(op, ['style']);
            if (!isDeckStyle(op['style'])) throw new OpError(400, `style must be one of ${DECK_STYLES.join(', ')}`);
            spec.theme = withDeckStyle(spec.theme, op['style'], input.tenant);
            phrases.push(`set the style to ${op['style']}`);
            break;
          }
          case 'set_decoration': {
            only(op, ['slideId', 'decoration']);
            const slide = editable(op);
            const d = op['decoration'];
            if (d === null) { delete slide.decoration; phrases.push(`gave ${named(slide)} its style's own decoration`); }
            else if (d === 'none') { slide.decoration = 'none'; phrases.push(`removed the decoration from ${named(slide)}`); }
            else {
              if (!isObj(d) || !isGraphicName(d['graphic'])) {
                throw new OpError(400, "decoration must be 'none', null (the style's own) or { graphic, placement? } with a graphic name from the catalogue (such as blob, waves, dots, badge-seal, rocket)");
              }
              const extra = Object.keys(d).filter((k) => k !== 'graphic' && k !== 'placement');
              if (extra.length) throw new OpError(400, `decoration: unknown field ${extra.join(', ')}`);
              const placement = d['placement'];
              if (placement !== undefined && !(DECK_DECORATION_PLACEMENTS as readonly unknown[]).includes(placement)) {
                throw new OpError(400, `decoration.placement must be one of ${DECK_DECORATION_PLACEMENTS.join(', ')}`);
              }
              slide.decoration = { graphic: d['graphic'], ...(placement !== undefined ? { placement: placement as DeckDecorationPlacement } : {}) };
              phrases.push(`put a ${String(d['graphic']).replace(/-/g, ' ')} on ${named(slide)}`);
            }
            touched.add(slide.id);
            break;
          }
          case 'set_emphasis': {
            only(op, ['slideId', 'target', 'from', 'to', 'emphasis']);
            const slide = editable(op);
            const target = op['target'];
            const bullet = isObj(target) && Object.keys(target).length === 1 && Number.isInteger(target['bullet']) ? Number(target['bullet']) : null;
            if (target !== 'title' && bullet === null) throw new OpError(400, "target must be 'title' or { bullet: <1-based number> }");
            if (bullet !== null && (bullet < 1 || bullet > (slide.bullets?.length ?? 0))) {
              throw new OpError(400, `slide ${slide.id} has ${slide.bullets?.length ?? 0} bullets; there is no bullet ${bullet}`);
            }
            const from = op['from'];
            const to = op['to'] ?? from;
            if (!Number.isInteger(from) || !Number.isInteger(to)) throw new OpError(400, 'from and to must be word numbers (1-based); to defaults to from');
            const emphasis = op['emphasis'];
            if (emphasis !== null && !(DECK_EMPHASES as readonly unknown[]).includes(emphasis)) {
              throw new OpError(400, `emphasis must be one of ${DECK_EMPHASES.join(', ')}, or null to clear it`);
            }
            const e = emphasis as DeckEmphasis | null;
            if (bullet === null) slide.title = emphasiseWords(slide.title, from as number, to as number, e);
            else slide.bullets![bullet - 1] = emphasiseWords(slide.bullets![bullet - 1]!, from as number, to as number, e);
            touched.add(slide.id);
            const words = from === to ? `word ${String(from)}` : `words ${String(from)} to ${String(to)}`;
            phrases.push(`${e === null ? 'cleared the emphasis on' : `gave ${e} emphasis to`} ${words} of the ${bullet === null ? 'title' : `bullet ${bullet}`} on ${named(slide)}`);
            break;
          }
          case 'set_path': {
            // One field edited in place on the slide (a title, a card's text or icon, a table cell, the deck's subtitle),
            // addressed by the engine's path grammar (realtime-modules 0.154.0 `editableRegions`); the whole deck is
            // validated again below, like every other operation.
            only(op, ['slideId', 'path', 'value']);
            const slide = editable(op);
            const path = str(op, 'path');
            if (path !== 'deck.subtitle' && !isEditablePath(slide.layout, path)) throw new OpError(400, `path ${path} is not a field a '${slide.layout}' slide shows`);
            // null clears an optional field (a card's icon: "No icon"); JSON has no undefined.
            if (op['value'] === undefined) throw new OpError(400, 'value is required (null clears an optional field)');
            const was = named(slide);
            let next: DeckSpec;
            try { next = setInDeck(spec, slide.id, path, op['value'] === null ? undefined : structuredClone(op['value'])); }
            catch (error) { throw new OpError(400, error instanceof Error ? error.message : `path ${path} could not be set`); }
            Object.assign(spec, next);
            touched.add(slide.id);
            phrases.push(`edited ${path} on ${was}`);
            break;
          }
        }
      } catch (error) {
        if (error instanceof OpError) throw new OpError(error.status, `operation ${n + 1} (${isObj(raw) ? String(raw['op']) : '?'}): ${error.message}`, error.errors);
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof OpError) {
      return { ok: false, status: error.status, reason: error.message, ...(error.errors ? { details: { errors: error.errors } } : {}) };
    }
    // A resolver's AppError (401/403/503) keeps its own status: same answer the report's route gives.
    throw error;
  }

  const valid = validateDeckSpec(spec);
  if (!valid.ok) return { ok: false, status: 400, reason: 'the edited deck is not valid', details: { errors: valid.errors } };
  const hostErrors = hostSpecErrors(valid.spec);
  if (hostErrors.length) return { ok: false, status: 400, reason: 'the edited deck is not valid', details: { errors: hostErrors } };
  const touchedIds = valid.spec.slides.map((s) => s.id).filter((id) => touched.has(id));
  const layout = layoutSpec(valid.spec, resolveDeckTheme(valid.spec.theme, input.tenant));
  const findings = layout.findings.filter((f) => touched.has(f.slideId));
  const line = clipLine(`${phrases.join('; ')}.`);
  return {
    ok: true,
    value: {
      base: { id: base.id, lockedSlideIds: base.lockedSlideIds }, spec: valid.spec, phrases, touchedSlideIds: touchedIds, findings,
      summary: line.charAt(0).toUpperCase() + line.slice(1),
    },
  };
}

export async function applyDeckOperations(input: ApplyOperationsInput): Promise<Result<OperationsOut>> {
  const { body, revisions, deckId } = input;
  const planned = await planDeckOperations(input);
  if (!planned.ok) return planned;
  const { base, spec, touchedSlideIds: touchedIds, findings, summary } = planned.value;
  const appended = await revisions.append({
    id: revisions.newRevisionId(), deckId, baseRevisionId: base.id,
    label: typeof body.label === 'string' ? body.label.trim() : 'Edited by operations',
    spec, lockedSlideIds: base.lockedSlideIds.filter((id) => spec.slides.some((s) => s.id === id)),
    producedBy: `operations:${input.sub ?? 'unknown'}`, createdBy: input.sub, summary,
  });
  if (!appended.ok) {
    return appended.reason === 'missing'
      ? { ok: false, status: 404, reason: 'deck not found' }
      : { ok: false, status: 409, reason: 'the deck has a newer revision', details: { activeRevisionId: appended.head } };
  }
  return {
    ok: true,
    value: {
      revision: summaryOf(appended.revision), touchedSlideIds: touchedIds, findings,
      summary: appended.revision.summary ?? summary, exampleSourceSlideIds: exampleSourceSlideIds(spec),
    },
  };
}

function clipLine(s: string): string { return s.length > 400 ? `${s.slice(0, 399)}…` : s; }
